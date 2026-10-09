import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { commandDecision, unwrapShell, type PermissionProfile } from '../core/permissions.js';

/**
 * ACP agents (ALPD §46): a generic transport for any agent that speaks the Agent Client
 * Protocol v1 over stdio, such as Gemini CLI or opencode. It maps the runtime's
 * normalized protocol (thread/start, turn/start, item and turn notifications) to ACP's
 * initialize, session/new, session/prompt and session/update.
 *
 * What ACP does not have, ALP does without: instructions go in the first prompt, mail
 * waits for the turn to end (no steer), and a session resumes only when the agent can
 * load one. ALP's tools reach the agent as an MCP server ("alp") that the agent starts:
 * a small bridge process connected back to this transport by a local socket.
 */

export type AcpProvider = {
  id: string;
  label: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  models?: Array<{ id: string; label?: string; description?: string }>;
};

type Listener = (method: string, params: any) => void;
type RequestHandler = (method: string, params: any) => Promise<unknown>;

/** What ALP decides about an ACP agent's permission request. */
export type AcpPermission = { kind: string; title: string; command?: string; paths: string[]; alpTool: boolean };

/** The MCP server ALP's tools reach an ACP agent through; it speaks MCP on stdio and forwards calls to the socket. */
const BRIDGE = `
const net = require('node:net');
const readline = require('node:readline');
const socket = net.connect(process.env.ALP_BRIDGE_SOCKET);
const waiting = new Map();
let sequence = 0;
let buffer = '';
socket.setEncoding('utf8');
socket.write(JSON.stringify({ token: process.env.ALP_BRIDGE_TOKEN }) + '\\n');
socket.on('data', data => {
  buffer += data;
  for (let index; (index = buffer.indexOf('\\n')) >= 0;) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    try { const message = JSON.parse(line); const waiter = waiting.get(message.id); if (waiter) { waiting.delete(message.id); waiter(message); } } catch {}
  }
});
socket.on('close', () => process.exit(0));
socket.on('error', () => process.exit(1));
const ask = message => new Promise(resolve => { const id = ++sequence; waiting.set(id, resolve); socket.write(JSON.stringify({ ...message, id }) + '\\n'); });
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', async line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || message.id === null) return;
  try {
    if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: (message.params && message.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'alp', version: '1' } } });
    if (message.method === 'ping') return send({ id: message.id, result: {} });
    if (message.method === 'tools/list') { const reply = await ask({ op: 'list' }); return send({ id: message.id, result: { tools: reply.tools } }); }
    if (message.method === 'tools/call') { const reply = await ask({ op: 'call', name: message.params.name, arguments: message.params.arguments || {} }); return send({ id: message.id, result: reply.result }); }
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  } catch (error) { send({ id: message.id, error: { code: -32603, message: String((error && error.message) || error) } }); }
});
process.stdin.on('end', () => process.exit(0));
`;

const READERS = ['read', 'search', 'think', 'fetch'];
const inside = (file: string, root: string) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };

/** What an ACP permission request asks for: its tool kind, the command it runs, and the paths it touches. */
export function acpPermission(toolCall: any, tools: string[]): AcpPermission {
  const raw = toolCall?.rawInput;
  const kind = typeof toolCall?.kind === 'string' ? toolCall.kind : 'other';
  const title = typeof toolCall?.title === 'string' ? toolCall.title : '';
  const command = kind === 'execute'
    ? (typeof raw?.command === 'string' ? raw.command : Array.isArray(raw?.command) ? raw.command.join(' ') : title || undefined)
    : undefined;
  const paths = (Array.isArray(toolCall?.locations) ? toolCall.locations : []).map((location: any) => location?.path).filter((value: unknown): value is string => typeof value === 'string');
  // An agent asks to call an MCP tool as kind other; ALP's own tools are always allowed.
  const named = `${title} ${typeof toolCall?.name === 'string' ? toolCall.name : ''}`;
  const alpTool = !['execute', 'edit', 'delete', 'move'].includes(kind) && tools.some(tool => new RegExp(`\\b${tool}\\b`).test(named));
  return { kind, title, ...(command ? { command } : {}), paths, alpTool };
}

/**
 * Whether ALP lets an ACP agent use a tool: ALP's tools always; then the profile's
 * Bash rules for a command; then the session's mode. Read-only allows reading;
 * workspace-write also changing files inside the workspace and running commands, which
 * only the agent's own sandbox, if it has one, contains; full access allows everything.
 * 'mode' is beyond the mode: the profile decides whether ALP asks the user.
 */
export function acpDecision(request: AcpPermission, mode: string, profile: PermissionProfile | null | undefined, workdir: string): 'allow' | 'deny' | 'rule' | 'mode' {
  if (request.alpTool) return 'allow';
  const rule = request.command !== undefined && profile ? commandDecision(profile, request.command) : undefined;
  if (rule === 'deny') return 'deny';
  if (rule === 'allow') return 'allow';
  if (rule === 'ask') return 'rule';
  if (mode === 'full-access' || READERS.includes(request.kind)) return 'allow';
  if (mode === 'workspace-write') {
    const outside = request.paths.some(file => !inside(path.resolve(workdir, file), workdir) && !inside(path.resolve(file), os.tmpdir()));
    if (!outside) return 'allow';
  }
  return 'mode';
}

/** The text ALP shows the user when an ACP agent asks for a permission. */
export function acpWhat(request: AcpPermission) {
  if (request.command !== undefined) return `run \`${unwrapShell(request.command).slice(0, 400)}\``;
  return `${request.kind === 'other' ? 'use' : request.kind} ${request.title ? `\`${request.title.slice(0, 300)}\`` : 'a tool'}${request.paths.length ? ` (${request.paths.slice(0, 5).join(', ')})` : ''}`;
}

/** ACP's MCP server list: stdio servers with env as name and value pairs, HTTP when the agent takes it. */
function acpServers(servers: Record<string, any>, http: boolean) {
  return Object.entries(servers).map(([name, server]) => {
    if (server.url) {
      if (!http) throw new Error(`MCP server '${name}' is HTTP, which this ACP agent does not take; use a stdio server`);
      return { type: 'http', name, url: server.url, headers: Object.entries(server.http_headers ?? {}).map(([key, value]) => ({ name: key, value: String(value) })) };
    }
    return { name, command: server.command, args: server.args ?? [], env: Object.entries(server.env ?? {}).map(([key, value]) => ({ name: key, value: String(value) })) };
  });
}

/** Maps an ACP agent over stdio to the normalized runtime protocol. */
export class AcpTransport {
  private child?: ChildProcessWithoutNullStreams;
  private exit: Promise<void> = Promise.resolve();
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
  private listeners = new Set<Listener>();
  private failures = new Set<(error: Error) => void>();
  private requestHandler?: RequestHandler;
  private closed = false;
  private capabilities: any = {};
  private sessionId = '';
  private config: any;
  /** Instructions go with the first prompt of a new session; a loaded one has them already. */
  private instructionsSent = false;
  private loading = false;
  private activeTurn?: string;
  /** The running prompt; a cancelled one still answers before the next starts. */
  private prompting?: Promise<void>;
  /** Text of the running turn's current message; a tool call starts the next one. */
  private message?: { id: string; text: string };
  private messages = 0;
  private toolCalls = new Map<string, { command: string; alp: boolean }>();
  /** Permission questions of the running turn, answered cancelled when it is cancelled. */
  private questions = new Set<(value: unknown) => void>();
  private bridge?: { server: net.Server; socket: string; token: string; connections: Set<net.Socket> };
  private tools: Array<{ name: string; description: string; inputSchema?: unknown }> = [];

  constructor(private readonly provider: AcpProvider, private readonly cwd: string, private readonly env: NodeJS.ProcessEnv) {}

  async initialize() {
    if (/\.(cmd|bat|ps1)$/i.test(this.provider.command)) throw new Error(`${this.provider.label}: the command must be a native executable, not a shell launcher`);
    const child = spawn(this.provider.command, this.provider.args, { cwd: this.cwd, env: { ...this.env, ...this.provider.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.exit = new Promise(resolve => { child.once('close', () => resolve()); child.once('error', () => resolve()); });
    child.stderr.on('data', () => {});
    child.stdin.on('error', error => this.fail(error));
    child.on('error', error => this.fail(new Error(`${this.provider.label} did not start: ${error.message}`)));
    child.on('close', code => { if (!this.closed) this.fail(new Error(`${this.provider.label} exited (${code})`)); });
    createInterface({ input: child.stdout }).on('line', line => this.receive(line));
    const result = await this.call('initialize', {
      protocolVersion: 1,
      // The agent reads, writes and runs commands with its own tools; ALP answers its permission requests.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'alp', title: 'ALP', version: '0.0.0' },
    }, 30_000);
    if (result?.protocolVersion !== 1) throw new Error(`${this.provider.label} speaks ACP version ${result?.protocolVersion}; ALP speaks version 1`);
    this.capabilities = result.agentCapabilities ?? {};
  }

  onNotification(listener: Listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onFailure(listener: (error: Error) => void) { this.failures.add(listener); return () => this.failures.delete(listener); }
  onRequest(handler: RequestHandler) { this.requestHandler = handler; }

  async request(method: string, params: any): Promise<any> {
    if (this.closed) throw new Error('Runtime is closed');
    if (method === 'thread/start' || method === 'thread/resume') {
      this.config = params;
      this.tools = params.dynamicTools ?? [];
      const mcpServers = [...acpServers(params.mcpServers ?? {}, Boolean(this.capabilities.mcpCapabilities?.http)), ...(this.tools.length ? [await this.openBridge()] : [])];
      if (method === 'thread/resume') {
        if (!this.capabilities.loadSession) throw new Error(`${this.provider.label} cannot resume a session: it does not support session/load`);
        // The agent replays the session's history as updates while loading; ALP has it already.
        this.loading = true;
        try { await this.call('session/load', { sessionId: params.threadId, cwd: params.cwd, mcpServers }, 120_000); }
        finally { this.loading = false; }
        this.sessionId = params.threadId;
        this.instructionsSent = true;
      } else {
        const result = await this.call('session/new', { cwd: params.cwd, mcpServers }, 120_000);
        this.sessionId = result.sessionId;
        await this.chooseModel(result.models);
      }
      return { thread: { id: this.sessionId, turns: [] }, cwd: params.cwd, model: params.model, reasoningEffort: params.thinking };
    }
    if (method === 'turn/start') {
      if (!this.sessionId) throw new Error(`${this.provider.label} session is not open`);
      // After a cancel, the agent answers the cancelled prompt first; ALP waits a little for it.
      if (this.prompting) await Promise.race([this.prompting, new Promise(resolve => setTimeout(resolve, 10_000).unref())]);
      if (this.closed) throw new Error('Runtime is closed');
      const turnId = randomUUID();
      this.activeTurn = turnId;
      this.message = undefined;
      const prompt = (params.input ?? []).filter((part: any) => typeof part?.text === 'string').map((part: any) => ({ type: 'text', text: part.text }));
      if (!this.instructionsSent && this.config?.developerInstructions) {
        prompt.unshift({ type: 'text', text: `Instructions from ALP, which runs you. Follow them for this whole session.\n\n${this.config.developerInstructions}` });
        this.instructionsSent = true;
      }
      this.prompting = this.call('session/prompt', { sessionId: this.sessionId, prompt }).then(
        result => this.endTurn(turnId, result?.stopReason),
        error => this.endTurn(turnId, 'error', error instanceof Error ? error.message : String(error)),
      ).finally(() => { if (this.activeTurn === undefined || this.activeTurn === turnId) this.prompting = undefined; });
      return { turn: { id: turnId } };
    }
    if (method === 'turn/steer') throw new Error(`${this.provider.label} takes no messages during a turn; ALP delivers them when it ends`);
    if (method === 'turn/interrupt') {
      if (this.sessionId) this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
      for (const answer of this.questions) answer({ outcome: { outcome: 'cancelled' } });
      this.questions.clear();
      return {};
    }
    // ALP decides permissions itself, by the session's current mode.
    if (method === 'session/configure') return {};
    if (method === 'thread/delete') return {};
    throw new Error(`${this.provider.label} does not support '${method}'`);
  }

  /** Picks the session's model when ALP was given one and the agent offers a choice. */
  private async chooseModel(models: any) {
    const wanted = this.config?.model?.includes('/') ? this.config.model.slice(this.config.model.indexOf('/') + 1) : undefined;
    if (!wanted || models?.currentModelId === wanted) return;
    if (!Array.isArray(models?.availableModels)) throw new Error(`${this.provider.label} does not let ALP choose its model; use acp:${this.provider.id} alone`);
    if (!models.availableModels.some((model: any) => model?.modelId === wanted)) throw new Error(`${this.provider.label} has no model '${wanted}'`);
    await this.call('session/set_model', { sessionId: this.sessionId, modelId: wanted }, 30_000);
  }

  private endTurn(turnId: string, stopReason: string, error?: string) {
    if (this.closed || this.activeTurn !== turnId) return;
    this.closeMessage();
    this.activeTurn = undefined;
    this.toolCalls.clear();
    const status = stopReason === 'end_turn' ? 'completed' : stopReason === 'cancelled' ? 'interrupted' : 'failed';
    this.emit('turn/completed', {
      threadId: this.sessionId,
      turn: { id: turnId, status, ...(status === 'failed' ? { error: { message: error ?? `${this.provider.label} stopped: ${stopReason}` } } : {}) },
    });
  }

  private closeMessage() {
    if (this.message?.text) this.emit('item/completed', { threadId: this.sessionId, item: { type: 'agentMessage', id: this.message.id, text: this.message.text } });
    this.message = undefined;
  }

  private update(update: any) {
    if (this.loading || !this.activeTurn || !update) return;
    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const text = update.content?.type === 'text' && typeof update.content.text === 'string' ? update.content.text : '';
      if (!text) return;
      this.message ??= { id: `acp-${this.activeTurn}-${++this.messages}`, text: '' };
      this.message.text += text;
      this.emit('item/agentMessage/delta', { threadId: this.sessionId, itemId: this.message.id, delta: text });
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = String(update.toolCallId ?? '');
      if (!id) return;
      let call = this.toolCalls.get(id);
      if (!call) {
        const request = acpPermission(update, this.tools.map(tool => tool.name));
        call = { command: request.command ?? `${request.kind}: ${request.title}`, alp: request.alpTool };
        this.toolCalls.set(id, call);
        this.closeMessage();
        // ALP's own tools show as ALP tool calls; the agent's call to the bridge would repeat them.
        if (!call.alp) this.emit('item/started', { threadId: this.sessionId, item: { type: 'commandExecution', id, command: call.command, cwd: this.cwd, status: 'inProgress', aggregatedOutput: '' } });
      }
      if ((update.status === 'completed' || update.status === 'failed') && !call.alp) {
        const output = (Array.isArray(update.content) ? update.content : [])
          .map((part: any) => part?.type === 'content' && part.content?.type === 'text' ? part.content.text : part?.type === 'diff' ? `diff ${part.path}` : '')
          .filter(Boolean).join('\n');
        this.emit('item/completed', { threadId: this.sessionId, item: { type: 'commandExecution', id, command: call.command, cwd: this.cwd, status: update.status, exitCode: update.status === 'failed' ? 1 : 0, aggregatedOutput: output } });
      }
      return;
    }
    if (kind === 'usage_update' && typeof update.used === 'number') {
      const last = { totalTokens: update.used };
      this.emit('thread/tokenUsage/updated', { threadId: this.sessionId, turnId: this.activeTurn, tokenUsage: { last, total: last, ...(typeof update.size === 'number' ? { modelContextWindow: update.size } : {}) } });
    }
  }

  /** The agent asks before using a tool; ALP's runtime decides, and the answer picks one of the agent's options. */
  private async permission(params: any) {
    const options: any[] = Array.isArray(params?.options) ? params.options : [];
    const pick = (...kinds: string[]) => kinds.map(kind => options.find(option => option?.kind === kind)).find(Boolean);
    if (!this.activeTurn || !this.requestHandler) return { outcome: { outcome: 'cancelled' } };
    const request = acpPermission(params?.toolCall, this.tools.map(tool => tool.name));
    const question = new Promise<unknown>(resolve => this.questions.add(resolve));
    const answer: any = await Promise.race([this.requestHandler('item/acp/permission', request), question]);
    if (answer?.outcome) return answer;
    const option = answer?.allow ? pick('allow_once', 'allow_always') : pick('reject_once', 'reject_always');
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
  }

  private receive(line: string) {
    if (line.length > 16 * 1024 * 1024) { this.fail(new Error(`${this.provider.label} sent a frame over the size limit`)); return; }
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      const answer = message.method === 'session/request_permission' ? this.permission(message.params)
        : Promise.reject(Object.assign(new Error(`ALP does not offer '${message.method}'`), { code: -32601 }));
      answer.then(
        result => { if (!this.closed) this.write({ jsonrpc: '2.0', id: message.id, result }); },
        error => { if (!this.closed) this.write({ jsonrpc: '2.0', id: message.id, error: { code: error?.code ?? -32603, message: error instanceof Error ? error.message : String(error) } }); },
      );
    } else if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) {
        const auth = message.error.code === -32000 || /auth/i.test(String(message.error.message ?? ''));
        waiter.reject(new Error(auth ? `${this.provider.label} needs you to sign in first: run it once in a terminal and log in (${message.error.message ?? 'authentication required'})` : `${this.provider.label}: ${message.error.message ?? 'request failed'}`));
      } else waiter.resolve(message.result);
    } else if (message.method === 'session/update' && message.params?.sessionId === this.sessionId) {
      this.update(message.params.update);
    }
  }

  private call(method: string, params: unknown, timeout?: number): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Runtime is closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.provider.label} did not answer ${method} within ${timeout / 1000} s`)); }, timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  private write(value: unknown) {
    if (this.closed || !this.child) throw new Error('Runtime is closed');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  /** Starts the socket ALP's MCP bridge connects to, and returns the server entry for the agent. */
  private async openBridge() {
    if (!this.bridge) {
      const token = randomBytes(16).toString('hex');
      const name = `alp-acp-${randomBytes(6).toString('hex')}`;
      const socket = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
      const connections = new Set<net.Socket>();
      const server = net.createServer(connection => {
        connections.add(connection);
        connection.once('close', () => connections.delete(connection));
        this.serveBridge(connection, token);
      });
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, () => resolve()); });
      this.bridge = { server, socket, token, connections };
    }
    return { name: 'alp', command: process.execPath, args: ['-e', BRIDGE], env: [{ name: 'ALP_BRIDGE_SOCKET', value: this.bridge.socket }, { name: 'ALP_BRIDGE_TOKEN', value: this.bridge.token }] };
  }

  private serveBridge(connection: net.Socket, token: string) {
    let trusted = false;
    connection.setEncoding('utf8');
    connection.on('error', () => {});
    const reply = (value: unknown) => { if (!connection.destroyed) connection.write(`${JSON.stringify(value)}\n`); };
    createInterface({ input: connection }).on('line', async line => {
      let message: any;
      try { message = JSON.parse(line); } catch { connection.destroy(); return; }
      if (!trusted) {
        if (message.token !== token) { connection.destroy(); return; }
        trusted = true;
        return;
      }
      if (message.op === 'list') {
        reply({ id: message.id, tools: this.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema ?? { type: 'object' } })) });
        return;
      }
      if (message.op === 'call') reply({ id: message.id, result: await this.toolCall(String(message.name), message.arguments ?? {}) });
    });
  }

  private async toolCall(tool: string, args: Record<string, unknown>) {
    if (!this.requestHandler || !this.activeTurn || !this.tools.some(candidate => candidate.name === tool)) {
      return { content: [{ type: 'text', text: this.activeTurn ? `Unknown ALP tool '${tool}'` : 'ALP tools are unavailable between turns' }], isError: true };
    }
    const callId = `acp-tool-${randomUUID()}`;
    const item = { type: 'dynamicToolCall', id: callId, callId, tool, arguments: args };
    this.closeMessage();
    this.emit('item/started', { threadId: this.sessionId, item: { ...item, status: 'inProgress' } });
    const result: any = await this.requestHandler('item/tool/call', { threadId: this.sessionId, turnId: this.activeTurn, callId, namespace: null, tool, arguments: args })
      .catch(error => ({ success: false, contentItems: [{ type: 'inputText', text: error instanceof Error ? error.message : String(error) }] }));
    const ok = result?.success !== false;
    this.emit('item/completed', { threadId: this.sessionId, item: { ...item, status: ok ? 'completed' : 'failed', success: ok, contentItems: result?.contentItems ?? [] } });
    return { content: (result?.contentItems ?? []).map((part: any) => ({ type: 'text', text: part.text ?? JSON.stringify(part) })), isError: !ok };
  }

  private emit(method: string, params: any) {
    for (const listener of this.listeners) listener(method, params);
  }

  private fail(error: Error) {
    if (this.closed) return;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
    for (const listener of this.failures) listener(error);
    void this.close();
  }

  async close() {
    if (this.closed) return this.exit;
    this.closed = true;
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Runtime closed')); }
    this.pending.clear(); this.listeners.clear(); this.failures.clear();
    for (const answer of this.questions) answer({ outcome: { outcome: 'cancelled' } });
    this.questions.clear();
    if (this.bridge) {
      this.bridge.server.close();
      for (const connection of this.bridge.connections) connection.destroy();
      if (process.platform !== 'win32') try { rmSync(this.bridge.socket, { force: true }); } catch {}
    }
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && child.pid) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else child.kill('SIGKILL');
    }, 1500);
    let deadline: NodeJS.Timeout | undefined;
    try { await Promise.race([this.exit, new Promise<void>(resolve => { deadline = setTimeout(resolve, 4000); })]); }
    finally { clearTimeout(timer); clearTimeout(deadline); }
  }
}
