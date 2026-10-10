import * as acp from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { DaemonConnection } from '../daemon/server.js';
import type { Envelope, HostMcpServer, SessionPreview, TimelineItem, UserQuestion } from '../runtime/index.js';

/**
 * ALP as an ACP agent (ALPD §60): an editor such as Zed starts `alp acp` and speaks
 * the Agent Client Protocol on stdio. Each ACP session is a root in alpd; this process
 * only translates, as the Paseo plugin does. A session opens in alpd on its first
 * prompt, so the user can choose its team first; its tree keeps working in alpd after
 * the editor goes away, and session/load picks it up again.
 */

export type AcpAgentOptions = {
  /** Opens a connection to alpd, starting it when needed. */
  connect(): Promise<DaemonConnection>;
  version: string;
  /** Where diagnostics go; stdout belongs to the protocol. */
  log?: (message: string) => void;
};

type Team = SessionPreview['teams'][number];

type Session = {
  id: string;
  cwd: string;
  mcpServers: Record<string, HostMcpServer>;
  preview: SessionPreview;
  /** Open in alpd: the team is fixed from then on. */
  opened: boolean;
  /** Prompts this connection sent, which the editor already shows. */
  ours: Set<string>;
  /** Assistant text sent so far, per item, so only what is new goes out. */
  texts: Map<string, string>;
  /** Tool calls announced, so later states go out as updates. */
  tools: Set<string>;
  /** Questions to the user that wait in this tree. */
  questions: Map<string, UserQuestion>;
  /** Updates go out in order; a prompt answers after its updates. */
  queue: Promise<void>;
  /** The prompt waiting for its turn to end. */
  waiting?: { clientMessageId: string; turnId?: string; done(result: { state: 'completed' | 'failed' | 'canceled'; error?: string }): void };
};

const MODES = [
  { id: 'read-only', name: 'Read only', description: 'Agents read and search; nothing is changed' },
  { id: 'workspace-write', name: 'Workspace write', description: 'Agents change files and run commands inside the project' },
  { id: 'full-access', name: 'Full access', description: 'Agents may do anything, without a sandbox' },
];

/** How much of a command's output a tool call shows. */
const OUTPUT_CHARS = 20_000;

const COMMANDS: acp.AvailableCommand[] = [
  { name: 'answer', description: 'Answer the question an agent asked you', input: { hint: 'your answer' } },
  { name: 'dismiss', description: 'Dismiss the question an agent asked you', input: { hint: 'why (optional)' } },
];

/** ACP's MCP servers, as ALP hosts them beside the agents' own. */
export function hostServers(servers: acp.McpServer[] = []): Record<string, HostMcpServer> {
  const host: Record<string, HostMcpServer> = {};
  for (const server of servers) {
    if ('command' in server) host[server.name] = { type: 'stdio', command: server.command, args: server.args, env: Object.fromEntries(server.env.map(variable => [variable.name, variable.value])) };
    else if (server.type === 'http' || server.type === 'sse') host[server.name] = { type: server.type, url: server.url, headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])) };
  }
  return host;
}

/** A prompt's content as the text ALP gives the agent: files the editor attaches are named or inlined. */
export function promptText(blocks: acp.ContentBlock[]) {
  let text = '';
  for (const block of blocks) {
    if (block.type === 'text') { text += block.text; continue; }
    let part = '';
    if (block.type === 'resource_link') part = `@${block.uri.replace(/^file:\/\//, '')}`;
    else if (block.type === 'resource') {
      const { resource } = block;
      const where = resource.uri.replace(/^file:\/\//, '');
      part = 'text' in resource ? `\n<file path="${where}">\n${resource.text}\n</file>\n` : `@${where}`;
    }
    // A mention stands apart from the words around it.
    if (part && text && !/\s$/.test(text) && !part.startsWith('\n')) text += ' ';
    text += part;
  }
  return text.trim();
}

/** What kind of work a tool call is, from its name or its command's first word (Claude reports tools as `Read {…}`). */
export function toolKind(item: Extract<TimelineItem, { kind: 'tool_call' }>): acp.ToolKind {
  const word = item.detail.type === 'shell' ? String(item.detail.command ?? '').trim().split(/[\s{(]/)[0] : item.name;
  if (/^(Read|NotebookRead|LS)$/.test(word)) return 'read';
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(word)) return 'edit';
  if (/^(Grep|Glob)$/.test(word)) return 'search';
  if (/^(WebFetch|WebSearch)$/.test(word)) return 'fetch';
  if (/^(Skill|Task|TodoWrite)$/.test(word) || item.name.startsWith('alp_')) return 'other';
  return item.detail.type === 'shell' ? 'execute' : 'other';
}

function toolTitle(item: Extract<TimelineItem, { kind: 'tool_call' }>) {
  if (item.detail.type === 'shell') return clip(String(item.detail.command ?? '').split('\n')[0], 160);
  const input = (item.detail.input ?? {}) as Record<string, unknown>;
  if (item.name === 'alp_delegate') return clip(`Delegate to ${input.agent ?? 'an agent'}: ${String(input.task ?? '').split('\n')[0]}`, 160);
  return clip(`${item.name} ${JSON.stringify(input)}`, 160);
}

function toolOutput(item: Extract<TimelineItem, { kind: 'tool_call' }>): acp.ToolCallContent[] {
  let text = '';
  if (item.detail.type === 'shell') text = item.detail.output ?? '';
  else {
    const output = item.detail.output as unknown;
    text = Array.isArray(output) ? output.map(part => typeof part?.text === 'string' ? part.text : JSON.stringify(part)).join('\n') : output == null ? '' : typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  }
  if (item.error) text = text ? `${text}\n${item.error}` : item.error;
  if (!text) return [];
  if (text.length > OUTPUT_CHARS) text = `${text.slice(0, OUTPUT_CHARS)}\n… (${text.length - OUTPUT_CHARS} more characters)`;
  return [{ type: 'content', content: { type: 'text', text } }];
}

const clip = (text: string, chars: number) => text.length > chars ? `${text.slice(0, chars - 1)}…` : text;

const status = (state: 'running' | 'completed' | 'failed'): acp.ToolCallStatus => state === 'running' ? 'in_progress' : state;

export function createAcpAgent(options: AcpAgentOptions) {
  const log = options.log ?? (() => {});
  const sessions = new Map<string, Session>();
  let alpd: Promise<DaemonConnection> | undefined;
  let editor: acp.AgentContext | undefined;
  /** The editor went away and this process lets go of alpd. */
  let leaving = false;

  async function daemon() {
    alpd ??= options.connect().then(connection => {
      connection.onEvent(project);
      connection.onClose(error => {
        if (leaving) return;
        log(`alp acp: lost alpd (${error.message})`);
        alpd = undefined;
        for (const session of sessions.values()) {
          session.opened = false;
          session.waiting?.done({ state: 'failed', error: `ALP lost its connection to alpd: ${error.message}` });
        }
      });
      return connection;
    }, error => { alpd = undefined; throw error; });
    return alpd;
  }

  const request = async (method: string, params: unknown) => (await daemon()).request(method, params);

  function send(session: Session, update: acp.SessionUpdate) {
    const client = editor;
    if (!client) return;
    session.queue = session.queue.then(() => client.notify('session/update', { sessionId: session.id, update })).catch(error => log(`alp acp: update failed: ${error?.message ?? error}`));
  }

  const say = (session: Session, text: string) => send(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

  function configOptions(session: Session): acp.SessionConfigOption[] {
    const teams: Team[] = session.opened ? session.preview.teams.filter(team => team.id === session.preview.team) : session.preview.teams;
    return [
      {
        id: 'team', name: 'Team', category: 'model', type: 'select', currentValue: session.preview.team,
        description: session.opened ? 'A session keeps its team; start a new one for another team' : 'The team that works on this session',
        options: (teams.length ? teams : [{ id: session.preview.team, label: session.preview.teamLabel ?? session.preview.team }]).map(team => ({ value: team.id, name: team.label, ...(team.description ? { description: team.description } : {}) })),
      },
      { id: 'mode', name: 'Permissions', category: 'mode', type: 'select', currentValue: session.preview.mode, options: MODES.map(mode => ({ value: mode.id, name: mode.name, description: mode.description })) },
    ];
  }

  const modeState = (session: Session): acp.SessionModeState => ({ currentModeId: session.preview.mode, availableModes: MODES });

  function track(id: string, cwd: string, mcpServers: Record<string, HostMcpServer>, preview: SessionPreview, opened: boolean) {
    const session: Session = { id, cwd, mcpServers, preview, opened, ours: new Set(), texts: new Map(), tools: new Set(), questions: new Map(), queue: Promise.resolve() };
    sessions.set(id, session);
    return session;
  }

  function known(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session) throw acp.RequestError.resourceNotFound(sessionId);
    return session;
  }

  /** alpd events of this connection's trees, as ACP updates on their roots. */
  function project(envelope: Envelope) {
    const session = sessions.get(envelope.sessionId);
    const { event } = envelope;
    // Questions belong to the root, whichever agent of its tree asks.
    if (event.type === 'question') {
      const root = sessions.get(event.question.rootId);
      if (!root || root.questions.has(event.question.id)) return;
      root.questions.set(event.question.id, event.question);
      const options = event.question.options?.length ? `\nOptions: ${event.question.options.join(' · ')}` : '';
      say(root, `\n\n**${event.question.agent} asks you:** ${event.question.body}${options}\n\nReply with /answer <your answer>, or /dismiss.\n\n`);
      return;
    }
    if (event.type === 'question.resolved') {
      for (const root of sessions.values()) root.questions.delete(event.questionId);
      return;
    }
    // Children show through their requester's alp_delegate call.
    if (!session) return;
    switch (event.type) {
      case 'session.updated':
        if (event.session.mode !== session.preview.mode) {
          session.preview = { ...session.preview, mode: event.session.mode };
          send(session, { sessionUpdate: 'current_mode_update', currentModeId: event.session.mode });
          send(session, { sessionUpdate: 'config_option_update', configOptions: configOptions(session) });
        }
        return;
      case 'prompt.accepted':
        if (session.waiting?.clientMessageId === event.clientMessageId) session.waiting.turnId = event.turnId;
        return;
      case 'prompt.failed':
        if (session.waiting?.clientMessageId === event.clientMessageId) session.waiting.done({ state: 'failed', error: event.error.message });
        return;
      case 'turn.ended':
        if (session.waiting?.turnId === event.turnId) session.waiting.done({ state: event.state, ...(event.error ? { error: event.error.message } : {}) });
        return;
      case 'session.failed':
        session.opened = false;
        session.waiting?.done({ state: 'failed', error: event.error.message });
        return;
      case 'session.closed':
        session.opened = false;
        return;
      case 'item':
        item(session, event.item);
        return;
    }
  }

  function item(session: Session, item: TimelineItem) {
    switch (item.kind) {
      case 'user_message': {
        if (item.clientMessageId && session.ours.has(item.clientMessageId)) return;
        // Mail and ALP's own prompts to main are not the user's words: they show as a step.
        if (item.clientMessageId?.startsWith('alp-') || item.id.startsWith('user:alp-')) {
          send(session, { sessionUpdate: 'tool_call', toolCallId: item.id, title: clip(`ALP: ${item.text.split('\n').find(line => line.trim()) ?? 'note'}`, 160), kind: 'other', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: item.text } }] });
          return;
        }
        send(session, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: item.text } });
        return;
      }
      case 'assistant_message': {
        const before = session.texts.get(item.id) ?? '';
        session.texts.set(item.id, item.text);
        const fresh = item.text.startsWith(before) ? item.text.slice(before.length) : `\n${item.text}`;
        if (fresh) say(session, fresh);
        return;
      }
      case 'notice':
        say(session, `\n\n> ALP: ${item.text}\n\n`);
        return;
      case 'compaction':
        if (item.status !== 'running') say(session, `\n\n> ALP: ${item.status === 'completed' ? `the context was compacted${item.preTokens ? ` from ${Math.round(item.preTokens / 1000)}k tokens` : ''}` : 'compacting the context failed'}\n\n`);
        return;
      case 'todo':
        send(session, { sessionUpdate: 'plan', entries: item.items.map(entry => ({ content: entry.text, priority: 'medium', status: entry.status })) });
        return;
      case 'tool_call': {
        const fields = { title: toolTitle(item), kind: toolKind(item), status: status(item.status), content: toolOutput(item), rawInput: item.detail.type === 'shell' ? { command: item.detail.command, cwd: item.detail.cwd } : item.detail.input };
        if (session.tools.has(item.id)) send(session, { sessionUpdate: 'tool_call_update', toolCallId: item.id, ...fields });
        else {
          session.tools.add(item.id);
          send(session, { sessionUpdate: 'tool_call', toolCallId: item.id, ...fields });
        }
        return;
      }
    }
  }

  /** Opens the session's root in alpd with what the user chose; a reopened one resumes. */
  async function open(session: Session, resume: boolean) {
    await request('session.create', {
      sessionId: session.id,
      spec: { cwd: session.cwd, persist: true, workflow: session.preview.team, mode: session.preview.mode, mcpServers: session.mcpServers },
      history: 'skip',
      ...(resume ? { resume: true } : {}),
    });
    session.opened = true;
  }

  async function prompt(session: Session, blocks: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    const text = promptText(blocks);
    const command = /^\/(answer|dismiss)\b\s*([\s\S]*)$/.exec(text);
    if (command) {
      const [question] = session.questions.values();
      if (!question) say(session, 'No agent is waiting for an answer from you.');
      else {
        await request('question.answer', command[1] === 'answer' ? { questionId: question.id, text: command[2].trim() || 'yes' } : { questionId: question.id, dismiss: true, ...(command[2].trim() ? { reason: command[2].trim() } : {}) });
        session.questions.delete(question.id);
        say(session, command[1] === 'answer' ? `Sent your answer to ${question.agent}.` : `Dismissed ${question.agent}'s question.`);
      }
      await session.queue;
      return { stopReason: 'end_turn' };
    }
    if (!text) throw acp.RequestError.invalidParams(undefined, 'The prompt is empty');
    if (!session.opened) {
      const { session: snapshot } = await request('session.get', { sessionId: session.id }).catch(() => ({ session: undefined }));
      await open(session, !!snapshot);
      send(session, { sessionUpdate: 'config_option_update', configOptions: configOptions(session) });
    }
    if (session.waiting) throw acp.RequestError.invalidRequest(undefined, 'A prompt is already running in this session');
    const clientMessageId = randomUUID();
    session.ours.add(clientMessageId);
    let done!: NonNullable<Session['waiting']>['done'];
    const ended = new Promise<{ state: 'completed' | 'failed' | 'canceled'; error?: string }>(resolve => {
      done = result => { if (session.waiting?.clientMessageId === clientMessageId) session.waiting = undefined; resolve(result); };
    });
    session.waiting = { clientMessageId, done };
    try {
      // A turn main started by itself (mail from its team) takes the user's words as a steer.
      await request('session.prompt', { sessionId: session.id, clientMessageId, delivery: 'auto', content: [{ type: 'text', text }] });
    } catch (error) {
      done({ state: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
    const result = await ended;
    await session.queue;
    if (result.state === 'canceled') return { stopReason: 'cancelled' };
    if (result.state === 'failed') throw acp.RequestError.internalError(undefined, result.error ?? 'The turn failed');
    return { stopReason: 'end_turn' };
  }

  async function preview(cwd: string, mcpServers: Record<string, HostMcpServer>, team?: string, mode?: string): Promise<SessionPreview> {
    const { preview } = await request('session.preview', { spec: { cwd, mcpServers, ...(team ? { workflow: team } : {}), ...(mode ? { mode } : {}) } });
    return preview;
  }

  const absolute = (cwd: string) => {
    if (!path.isAbsolute(cwd)) throw acp.RequestError.invalidParams(undefined, 'cwd must be an absolute path');
    return path.resolve(cwd);
  };

  return acp.agent({ name: 'alp' })
    .onConnect(connection => { editor = connection.client; void connection.closed.then(() => release()); })
    .onRequest('initialize', () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { list: {}, close: {} },
      },
      agentInfo: { name: 'alp', title: 'ALP', version: options.version },
      authMethods: [],
    }))
    .onRequest('authenticate', () => ({}))
    .onRequest('session/new', async ({ params }) => {
      const cwd = absolute(params.cwd);
      const mcpServers = hostServers(params.mcpServers);
      const session = track(`acp-${randomUUID()}`, cwd, mcpServers, await preview(cwd, mcpServers), false);
      queueMicrotask(() => send(session, { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS }));
      return { sessionId: session.id, configOptions: configOptions(session), modes: modeState(session) };
    })
    .onRequest('session/load', async ({ params }) => {
      const cwd = absolute(params.cwd);
      const { session: record } = await request('session.get', { sessionId: params.sessionId }).catch(() => { throw acp.RequestError.resourceNotFound(params.sessionId); });
      if (record.parentId || path.resolve(record.projectRoot) !== cwd) throw acp.RequestError.invalidParams(undefined, 'That ALP session belongs to another project');
      const session = track(params.sessionId, cwd, hostServers(params.mcpServers), {
        teams: [{ id: record.workflow?.mode ?? 'pho', label: record.teamLabel ?? record.workflow?.mode ?? 'pho' }],
        team: record.workflow?.mode ?? 'pho', ...(record.teamLabel ? { teamLabel: record.teamLabel } : {}),
        agent: record.agent, runtime: record.runtime, model: record.model, mode: record.mode, thinking: record.thinking,
      }, true);
      // The history comes as updates before the answer, as ACP asks; a live root is followed, a closed one reopens on its next prompt.
      const live = record.status === 'idle' || record.status === 'running';
      await request('session.attach', { sessionId: session.id, replay: true });
      session.opened = live;
      await session.queue;
      send(session, { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS });
      return { configOptions: configOptions(session), modes: modeState(session) };
    })
    .onRequest('session/list', async ({ params }) => {
      const { sessions: rows } = await request('session.list', { ...(params.cwd ? { projectRoot: path.resolve(params.cwd) } : {}), rootsOnly: true, includeClosed: true });
      return {
        sessions: rows.filter((row: any) => row.persistent).slice(0, 100).map((row: any) => ({
          sessionId: row.id,
          cwd: row.projectRoot,
          title: row.title ?? `ALP ${row.agent}`,
          ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
        })),
      };
    })
    .onRequest('session/prompt', ({ params }) => prompt(known(params.sessionId), params.prompt))
    .onNotification('session/cancel', async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (!session?.opened) return;
      await request('session.interrupt', { sessionId: session.id }).catch(error => log(`alp acp: interrupt failed: ${error?.message ?? error}`));
    })
    .onRequest('session/set_mode', async ({ params }) => {
      await setMode(known(params.sessionId), params.modeId);
      return {};
    })
    .onRequest('session/set_config_option', async ({ params }) => {
      const session = known(params.sessionId);
      const value = String(params.value);
      if (params.configId === 'mode') await setMode(session, value);
      else if (params.configId === 'team') {
        if (session.opened && value !== session.preview.team) throw acp.RequestError.invalidParams(undefined, 'A session keeps its team; start a new one for another team');
        if (!session.preview.teams.some(team => team.id === value)) throw acp.RequestError.invalidParams(undefined, `Unknown team ${value}`);
        session.preview = { ...await preview(session.cwd, session.mcpServers, value), mode: session.preview.mode };
      } else throw acp.RequestError.invalidParams(undefined, `Unknown option ${params.configId}`);
      return { configOptions: configOptions(session) };
    })
    .onRequest('session/close', async ({ params }) => {
      const session = known(params.sessionId);
      sessions.delete(session.id);
      if (session.opened) await request('session.release', { sessionId: session.id }).catch(() => {});
      return {};
    });

  async function setMode(session: Session, mode: string) {
    if (!MODES.some(entry => entry.id === mode)) throw acp.RequestError.invalidParams(undefined, `Unknown mode ${mode}`);
    if (session.opened) await request('session.configure', { sessionId: session.id, mode });
    session.preview = { ...session.preview, mode };
  }

  /** The editor went away: alpd closes each root once idle, and lets running work finish. */
  async function release() {
    leaving = true;
    const connection = await alpd?.catch(() => undefined);
    if (!connection) return;
    await Promise.all([...sessions.values()].filter(session => session.opened).map(session => connection.request('session.release', { sessionId: session.id }).catch(() => {})));
    sessions.clear();
    connection.close();
  }
}
