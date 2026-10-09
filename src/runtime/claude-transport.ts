import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { optionalRead, claudeUsage } from './runtime-context.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PIN_KINDS } from './board.js';
import { CLOSE_REASONS, GATE_KINDS, TASK_STATUSES, TASK_TYPES } from '../core/tasks.js';

// Keep the Claude SDK behind the runtime boundary. Paseo inspects static
// imports while compiling plugin entrypoints, including their declaration
// graph; the SDK is a daemon-only optional runtime dependency.
const CLAUDE_SDK = ['@anthropic-ai', 'claude-agent-sdk'].join('/');

type SDKUserMessage = any;
type SDKMessage = any;
type ClaudeQuery = AsyncGenerator<SDKMessage, void> & {
  supportedModels(): Promise<Array<{ value: string; displayName: string; description: string; supportedEffortLevels?: string[] }>>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options: { skipBehaviors: boolean }): Promise<any>;
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: 'default' | 'acceptEdits' | 'bypassPermissions'): Promise<void>;
  close(): void;
};

// Zod mirrors of the provider's dynamic tool schemas; the provider validates again.
const handoffList = z.array(z.string().min(1)).max(100).optional();
const taskIds = z.array(z.string().min(1)).max(50).optional();
const taskLinks = z.object({ blockedBy: taskIds, related: taskIds, parent: z.string().min(1).optional() }).strict().optional();
export const toolShapes: Record<string, Record<string, z.ZodType>> = {
  alp_delegate: {
    agent: z.string().min(1),
    task: z.string().min(1).max(32_000),
    model: z.string().min(1).optional(),
    thinking: z.string().min(1).optional(),
    modelReason: z.string().min(1).optional(),
    mode: z.enum(['read-only', 'workspace-write', 'full-access']).optional(),
    isolation: z.enum(['shared', 'worktree']).optional(),
    wait: z.boolean().optional(),
    taskId: z.string().min(1).optional(),
  },
  alp_merge: {
    assignmentId: z.string().min(1),
  },
  alp_lesson: {
    scope: z.enum(['project', 'user']),
    lesson: z.string().min(1).max(600),
  },
  alp_skill: {
    name: z.string().min(1),
    description: z.string().min(1).max(300),
    body: z.string().min(1).max(20_000),
    roles: z.array(z.string().min(1)).min(1).max(10),
    lessons: z.array(z.string().min(1).max(600)).max(50).optional(),
    replace: z.boolean().optional(),
  },
  alp_issue: {
    action: z.enum(['search', 'create', 'comment']),
    target: z.enum(['project', 'alp']),
    query: z.string().min(1).max(200).optional(),
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(20_000).optional(),
    issue: z.number().int().positive().optional(),
    labels: z.array(z.string().min(1).max(50)).max(10).optional(),
  },
  alp_task: {
    action: z.enum(['create', 'update', 'link', 'start', 'close', 'reopen', 'gate', 'clear', 'pour', 'formulas', 'show', 'list', 'ready']),
    id: z.string().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(8000).optional(),
    type: z.enum(TASK_TYPES as [string, ...string[]]).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    labels: z.array(z.string().min(1).max(50)).max(10).optional(),
    paths: z.array(z.string().min(1)).max(50).optional(),
    parent: z.string().min(1).optional(),
    blockedBy: taskIds,
    discoveredFrom: z.string().min(1).optional(),
    add: taskLinks,
    remove: taskLinks,
    reason: z.enum(CLOSE_REASONS as [string, ...string[]]).optional(),
    kind: z.enum(GATE_KINDS as [string, ...string[]]).optional(),
    until: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
    gate: z.string().min(1).optional(),
    formula: z.string().min(1).optional(),
    vars: z.record(z.string(), z.string()).optional(),
    summary: z.string().min(1).max(2000).optional(),
    note: z.string().min(1).max(2000).optional(),
    status: z.enum(TASK_STATUSES as [string, ...string[]]).optional(),
    label: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
  },
  alp_discard: {
    assignmentId: z.string().min(1),
  },
  alp_pin: {
    kind: z.enum(PIN_KINDS),
    body: z.string().min(1),
    paths: z.array(z.string().min(1)).optional(),
  },
  alp_board: {
    kinds: z.array(z.enum(PIN_KINDS)).optional(),
    limit: z.number().int().positive().optional(),
  },
  alp_unpin: {
    pinId: z.string().min(1),
  },
  alp_wait: {
    assignments: z.array(z.string().min(1)).max(32).optional(),
    timeoutMs: z.number().int().positive().optional(),
  },
  alp_send: {
    to: z.string().min(1),
    kind: z.enum(['answer', 'note', 'steer']),
    body: z.string().min(1).max(8000),
    replyTo: z.string().min(1).optional(),
  },
  alp_ask: {
    question: z.string().min(1).max(8000),
    to: z.enum(['parent', 'user']).optional(),
    options: z.array(z.string().min(1).max(200)).max(10).optional(),
  },
  alp_handoff: {
    outcome: z.enum(['complete', 'partial', 'blocked', 'reconsider']),
    summary: z.string().min(1),
    candidate: handoffList,
    scope: handoffList,
    verification: handoffList,
    risks: handoffList,
    discovered: handoffList,
    ownership: z.string().optional(),
  },
};

type Listener = (method: string, params: any) => void;
type RequestHandler = (method: string, params: any) => Promise<unknown>;

type NativeConfig = {
  cwd: string;
  model: string;
  sandbox: string;
  developerInstructions: string;
  mcpServers: Record<string, any>;
  thinking: string;
  dynamicTools: Array<{
    name: string;
    description: string;
  }>;
  ephemeral?: boolean;
  threadId?: string;
  /** The session's permission profile: rules Claude enforces itself, in every permission mode. */
  permissions?: { allow: string[]; deny: string[] } | null;
};

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private ended = false;

  push(value: SDKUserMessage) {
    if (this.ended) throw new Error('Claude input is closed');
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close() {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Claude's permission mode for an ALP mode; full-access skips every permission check. */
export const claudePermissionMode = (sandbox: string) => sandbox === 'read-only' ? 'default' : sandbox === 'full-access' ? 'bypassPermissions' : 'acceptEdits';

export function claudePermissions(sandbox: string, currentSandbox?: () => string, rules?: { allow: string[]; deny: string[] } | null) {
  const readOnly = sandbox === 'read-only';
  const readers = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
  return {
    // Plan mode permits writes to plan files and requires ExitPlanMode approval.
    // Fixed read-only callers restrict the tool surface; live sessions keep
    // tools available and consult the current sandbox at the permission gate.
    permissionMode: claudePermissionMode(sandbox),
    // Lets a live session switch to full-access later; it bypasses nothing by itself.
    allowDangerouslySkipPermissions: true,
    ...(readOnly && !currentSandbox ? { tools: readers } : {}),
    // Allow rules run without asking, even in a read-only session; deny rules hold even with full access.
    ...(rules?.allow.length ? { allowedTools: rules.allow } : {}),
    disallowedTools: ['Agent', 'Task', 'TeamCreate', 'EnterPlanMode', 'ExitPlanMode', ...(rules?.deny ?? [])],
    canUseTool: async (name: string, input: Record<string, unknown>) => {
      if ((currentSandbox ? currentSandbox() === 'read-only' : readOnly) && !readers.includes(name) && !name.startsWith('mcp__alp__')) {
        return { behavior: 'deny', message: 'ALP session is read-only' };
      }
      return { behavior: 'allow', updatedInput: input };
    },
  };
}

/** Maps Claude Agent SDK streaming sessions to the normalized runtime protocol. */
export class ClaudeTransport {
  private listeners = new Set<Listener>();
  private failures = new Set<(error: Error) => void>();
  private requestHandler?: RequestHandler;
  private input = new InputQueue();
  private query?: ClaudeQuery;
  private pump?: Promise<void>;
  private config?: NativeConfig;
  private threadId = '';
  private activeTurn?: string;
  private closed = false;
  private assistantText = new Map<string, string>();
  private toolCalls = new Map<string, { name: string; command: string }>();

  constructor(
    private readonly command: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    if (!path.isAbsolute(command)) {
      const names = process.platform === 'win32' && !path.extname(command) ? [command, `${command}.exe`] : [command];
      const candidates = (env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap(directory => names.map(name => path.resolve(directory, name)));
      const executable = candidates.find(candidate => {
        try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); } catch { return false; }
      });
      if (!executable) throw new Error('Claude executable not found on PATH; set ALP_CLAUDE_BIN to an absolute native executable');
      this.command = realpathSync(executable);
    }
    if (/\.(cmd|bat|ps1)$/i.test(this.command)) {
      throw new Error('Claude executable must be a native binary, not a shell launcher');
    }
  }

  async orchestrationContext() {
    const [catalog, usage] = await Promise.all([
      optionalRead(async () => this.query ? this.query.supportedModels() : undefined),
      optionalRead(async () => this.query ? this.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }) : undefined),
    ]);
    return { runtime: 'claude', observedAt: new Date().toISOString(), catalogAvailable: Array.isArray(catalog),
      models: (catalog ?? []).map(model => ({ id: `claude:${model.value}`, label: model.displayName,
        description: model.description, thinking: model.supportedEffortLevels })), usage: claudeUsage(usage) };
  }
  async initialize() {}

  onNotification(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void) {
    this.failures.add(listener);
    return () => this.failures.delete(listener);
  }

  onRequest(handler: RequestHandler) {
    this.requestHandler = handler;
  }

  async request(method: string, params: any): Promise<any> {
    if (this.closed) throw new Error('Runtime is closed');

    if (method === 'session/configure') {
      if (!this.query || !this.config) throw new Error('Claude thread is not initialized');
      await this.query.setPermissionMode(claudePermissionMode(params.sandbox));
      this.config.sandbox = params.sandbox;
      return {};
    }

    if (method === 'thread/start' || method === 'thread/resume') {
      this.config = params as NativeConfig;
      this.threadId =
        method === 'thread/resume' ? params.threadId : randomUUID();
      await this.start(method === 'thread/resume');
      return {
        thread: { id: this.threadId, turns: [] },
        cwd: this.cwd,
        model: params.model,
        reasoningEffort: params.thinking,
      };
    }

    if (method === 'turn/start' || method === 'turn/steer') {
      if (!this.query) throw new Error('Claude thread is not initialized');
      const turnId = method === 'turn/steer'
        ? params.expectedTurnId
        : randomUUID();
      if (method === 'turn/start') this.activeTurn = turnId;
      this.input.push({
        type: 'user',
        message: {
          role: 'user',
          content: params.input.map((part: any) => ({
            type: 'text',
            text: part.text,
          })),
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: this.threadId,
      });
      return method === 'turn/start' ? { turn: { id: turnId } } : {};
    }

    if (method === 'turn/interrupt') {
      await this.query?.interrupt();
      return {};
    }

    throw new Error(`Unsupported Claude runtime operation '${method}'`);
  }

  private async start(resume: boolean) {
    const { createSdkMcpServer, query, tool } = await import(CLAUDE_SDK);
    const config = this.config!;
    const mcpServers = this.convertMcp(config.mcpServers);

    if (config.dynamicTools.length) {
      const tools = config.dynamicTools.map(definition => {
        const base = toolShapes[definition.name];
        if (!base) throw new Error(`Unsupported ALP tool '${definition.name}'`);
        // A role's definition may offer fewer actions (alp_task) and fewer fields than the full shape.
        const schema = (definition as { inputSchema?: { properties?: Record<string, { enum?: string[] }> } }).inputSchema?.properties;
        const actions = schema?.action?.enum;
        const shape = Object.fromEntries(Object.entries(base)
          .filter(([key]) => !schema || key in schema)
          .map(([key, value]) => [key, key === 'action' && actions?.length ? z.enum(actions as [string, ...string[]]) : value]));
        return tool(definition.name, definition.description, shape, async (args: Record<string, unknown>) => {
          if (!this.requestHandler || !this.activeTurn) {
            return {
              content: [{ type: 'text', text: 'ALP tools are unavailable' }],
              isError: true,
            };
          }
          const callId = `claude-tool-${randomUUID()}`;
          this.emit('item/started', {
            threadId: this.threadId,
            item: {
              type: 'dynamicToolCall',
              id: callId,
              callId,
              tool: definition.name,
              arguments: args,
              status: 'inProgress',
            },
          });
          const result: any = await this.requestHandler('item/tool/call', {
            threadId: this.threadId,
            turnId: this.activeTurn,
            callId,
            namespace: null,
            tool: definition.name,
            arguments: args,
          });
          this.emit('item/completed', {
            threadId: this.threadId,
            item: {
              type: 'dynamicToolCall',
              id: callId,
              callId,
              tool: definition.name,
              arguments: args,
              status: result?.success === false ? 'failed' : 'completed',
              success: result?.success !== false,
              contentItems: result?.contentItems ?? [],
            },
          });
          return {
            content: (result?.contentItems ?? []).map((item: any) => ({
              type: 'text' as const,
              text: item.text ?? JSON.stringify(item),
            })),
            isError: result?.success === false,
          };
        });
      });
      mcpServers.alp = createSdkMcpServer({
        name: 'alp',
        version: '0.0.0',
        tools,
      });
    }

    const options = {
      cwd: config.cwd,
      env: this.env,
      model: config.model,
      effort: ['none', 'off', 'ultracode'].includes(config.thinking) ? undefined : config.thinking,
      thinking: ['none', 'off'].includes(config.thinking) ? { type: 'disabled' } : { type: 'adaptive' },
      ...(config.thinking === 'ultracode' ? { settings: { ultracode: true } } : {}),
      systemPrompt: config.developerInstructions,
      ...claudePermissions(config.sandbox, () => config.sandbox, config.permissions),
      mcpServers,
      strictMcpConfig: true,
      settingSources: [],
      persistSession: !config.ephemeral,
      promptSuggestions: false,
      includePartialMessages: false,
      ...(resume ? { resume: this.threadId } : { sessionId: this.threadId }),
      // Explicit native path avoids SDK optional binaries inside Electron app.asar.
      pathToClaudeCodeExecutable: this.command,
    };

    this.query = query({ prompt: this.input, options }) as ClaudeQuery;
    this.pump = this.consume(this.query).catch((error) => this.fail(error));
  }

  private convertMcp(values: Record<string, any>) {
    const result: Record<string, any> = {};
    for (const [name, value] of Object.entries(values)) {
      result[name] = value.url
        ? {
            type: 'http',
            url: value.url,
            headers: value.http_headers ?? {},
          }
        : {
            type: 'stdio',
            command: value.command,
            args: value.args ?? [],
            env: value.env ?? {},
          };
    }
    return result;
  }

  private async consume(stream: ClaudeQuery) {
    for await (const message of stream) this.handle(message);
    if (!this.closed) this.fail(new Error('Claude session exited'));
  }

  private handle(message: SDKMessage) {
    if (message.type === 'assistant' && !message.parent_tool_use_id) {
      for (const block of message.message.content as any[]) {
        if (block.type === 'text') {
          const id = message.message.id;
          const text = (this.assistantText.get(id) ?? '') + block.text;
          this.assistantText.set(id, text);
          this.emit('item/completed', {
            threadId: this.threadId,
            item: { type: 'agentMessage', id, text },
          });
        } else if (block.type === 'tool_use') {
          const command = block.name === 'Bash'
            ? String(block.input?.command ?? '')
            : `${block.name} ${JSON.stringify(block.input ?? {})}`;
          this.toolCalls.set(block.id, { name: block.name, command });
          this.emit('item/started', {
            threadId: this.threadId,
            item: {
              type: 'commandExecution',
              id: block.id,
              command,
              cwd: this.cwd,
              status: 'inProgress',
              aggregatedOutput: '',
            },
          });
        }
      }
      return;
    }

    if (message.type === 'user') {
      const content = Array.isArray(message.message.content)
        ? message.message.content as any[]
        : [];
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const call = this.toolCalls.get(block.tool_use_id);
        if (!call) continue;
        const output = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content ?? '');
        this.emit('item/completed', {
          threadId: this.threadId,
          item: {
            type: 'commandExecution',
            id: block.tool_use_id,
            command: call.command,
            cwd: this.cwd,
            status: block.is_error ? 'failed' : 'completed',
            exitCode: block.is_error ? 1 : 0,
            aggregatedOutput: output,
          },
        });
        this.toolCalls.delete(block.tool_use_id);
      }
      return;
    }

    if (message.type === 'result' && this.activeTurn) {
      const turnId = this.activeTurn;
      this.activeTurn = undefined;
      this.emit('turn/completed', {
        threadId: this.threadId,
        turn: {
          id: turnId,
          status: message.is_error ? 'failed' : 'completed',
          ...(message.is_error
            ? { error: { message: 'errors' in message ? message.errors.join('; ') : 'Claude turn failed' } }
            : {}),
        },
      });
    }
  }

  private emit(method: string, params: any) {
    for (const listener of this.listeners) listener(method, params);
  }

  private fail(value: unknown) {
    if (this.closed) return;
    const error = value instanceof Error ? value : new Error(String(value));
    for (const listener of this.failures) listener(error);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    this.query?.close();
    await this.pump?.catch(() => {});
    this.listeners.clear();
    this.failures.clear();
  }
}
