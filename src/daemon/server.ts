import { createHash, randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { AlpRpcError, MAX_FRAME, PROTOCOL_VERSION } from '../client/index.js';
import { DEFAULT_MODEL, models, modes, thinkingOptions, type AlpEvent, type AlpRuntime, type Envelope, type SessionSnapshot } from '../runtime/index.js';
import type { Receipt, SessionRecord, SessionStatus, Store } from './store.js';

/**
 * alpd's JSON-RPC surface over one shared runtime (plans/reference/ALPD.md §3, §6, §14).
 * Clients attach to root sessions to receive the events of the whole tree. A root
 * with no attached client is closed as soon as it is idle, so work started by a
 * viewer finishes even after the viewer goes away. With a store, every session is
 * recorded and every tree's events are kept, so a closed root can be resumed later.
 */

export const ERROR = { failed: 1000, notFound: 1001, conflict: 1004, protocol: 1006 } as const;

class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) { super(message); }
}

/** A stable hash of JSON data, independent of key order (as Paseo's receipts). */
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value, (_key, candidate) =>
    candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
      ? Object.fromEntries(Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)))
      : candidate)).digest('hex');
}

type Connection = {
  socket?: net.Socket;
  helloed: boolean;
  roots: Set<string>;
  send(message: unknown): void;
};

/** Retained events per live tree, for attach and replay. */
const TREE_LOG_LIMIT = 20_000;
const SESSION_ID = /^[\w.:-]{1,128}$/;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LIVE: SessionStatus[] = ['initializing', 'idle', 'running'];

/** What clients need from a daemon connection; AlpClient implements it over the socket. */
export type DaemonConnection = {
  request(method: string, params?: unknown): Promise<any>;
  onEvent(listener: (envelope: Envelope) => void): () => void;
  onClose(listener: (error: Error) => void): () => void;
  close(): void;
};

export type DaemonServer = {
  listen(): Promise<void>;
  /** An in-process connection that delivers events synchronously, for embedding. */
  local(): DaemonConnection;
  close(): Promise<void>;
};

/** A session as clients list it: its last snapshot plus lifecycle. */
export type SessionSummary = SessionSnapshot & {
  status: SessionStatus;
  title?: string;
  lastError?: SessionRecord['lastError'];
  updatedAt?: string;
};

export function createDaemonServer({ runtime, socketPath, version, onShutdown, store, runLogDir }: {
  runtime: AlpRuntime;
  socketPath: string;
  version: string;
  onShutdown?: () => void;
  /** Durable records and timelines; without it sessions live only in memory. */
  store?: Store;
  /** Where crash reconciliation reports assignments it ends, as the runtime does. */
  runLogDir?: string;
}): DaemonServer {
  const connections = new Set<Connection>();
  /** Root of every live session. */
  const rootOf = new Map<string, string>();
  const attached = new Map<string, Set<Connection>>();
  const logs = new Map<string, Envelope[]>();
  const records = new Map<string, SessionRecord & { activeTurnId?: string }>();
  /** Prompt deliveries in flight, so a repeated clientMessageId waits for the first. */
  const delivering = new Map<string, Promise<object>>();
  let closing = false;
  const startedAt = new Date().toISOString();
  const restored = store ? restore() : Promise.resolve();

  const deliver = (connection: Connection, envelope: Envelope) => connection.send({ jsonrpc: '2.0', method: 'event', params: envelope });

  function save(record: SessionRecord & { activeTurnId?: string }, changes: Partial<SessionRecord & { activeTurnId?: string }> = {}) {
    Object.assign(record, changes, { updatedAt: new Date().toISOString() });
    records.set(record.id, record);
    void store?.put(record);
  }

  /** Lifecycle bookkeeping for one event; returns true when the record changed. */
  function track(sessionId: string, root: string, event: AlpEvent) {
    const now = new Date().toISOString();
    let record = records.get(sessionId);
    if (event.type === 'session.opened') {
      record ??= { version: 1, id: sessionId, rootId: root, status: 'initializing', createdAt: now, updatedAt: now };
      save(record, { rootId: root, session: event.session, status: 'idle', lastError: undefined, activeTurnId: undefined });
      return;
    }
    if (!record) return;
    if (event.type === 'session.updated') save(record, { session: { ...record.session, ...event.session, ...(event.session.parked ? {} : { parked: undefined }) } });
    else if (event.type === 'turn.started') save(record, { status: 'running', activeTurnId: event.turnId });
    else if (event.type === 'turn.ended') save(record, { status: 'idle', activeTurnId: undefined, ...(event.state === 'failed' ? { lastError: { message: event.error?.message ?? 'Turn failed' } } : {}) });
    else if (event.type === 'session.failed') save(record, { status: 'error', lastError: event.error });
    else if (event.type === 'session.closed') save(record, { status: record.status === 'error' ? 'error' : 'closed', activeTurnId: undefined });
    else if (event.type === 'item' && sessionId === root && !record.title && event.item.kind === 'user_message' && !event.item.clientMessageId?.startsWith('alp-')) {
      save(record, { title: event.item.text.replace(/\s+/g, ' ').trim().slice(0, 80) });
    }
  }

  runtime.onEvent(envelope => {
    const { sessionId, event } = envelope;
    if (event.type === 'session.opened') {
      const parent = event.session.parentId;
      rootOf.set(sessionId, parent ? rootOf.get(parent) ?? parent : sessionId);
    }
    const root = rootOf.get(sessionId) ?? sessionId;
    if (rootOf.has(sessionId)) {
      const log = logs.get(root) ?? [];
      log.push(envelope);
      if (log.length > TREE_LOG_LIMIT) log.splice(0, log.length - TREE_LOG_LIMIT);
      logs.set(root, log);
      void store?.append(root, envelope);
      track(sessionId, root, event);
    }
    for (const connection of attached.get(root) ?? []) deliver(connection, envelope);
    if (event.type === 'session.closed' && sessionId === root) {
      setImmediate(() => forget(root));
    } else {
      setImmediate(() => void reap(root));
    }
  });

  /** Loads records, settles sessions a crash left working, and prunes expired trees. */
  async function restore() {
    await store!.pruneReceipts(RECEIPT_RETENTION_MS);
    const loaded = await store!.list();
    const now = Date.now();
    const ended = { code: 'daemon_restarted', message: 'alpd stopped while this session was working' };
    const epoch = `restart-${startedAt}`;
    const byRoot = new Map<string, SessionRecord[]>();
    for (const record of loaded) byRoot.set(record.rootId, [...(byRoot.get(record.rootId) ?? []), record]);
    for (const [root, tree] of byRoot) {
      const head = tree.find(record => record.id === root);
      if (head && !LIVE.includes(head.status) && now - Date.parse(head.updatedAt) > RETENTION_MS) {
        await store!.remove(root, tree.map(record => record.id));
        continue;
      }
      for (const record of tree as Array<SessionRecord & { activeTurnId?: string }>) {
        records.set(record.id, record);
        if (!LIVE.includes(record.status)) continue;
        const envelope = (event: AlpEvent): Envelope => ({ sessionId: record.id, epoch, seq: 0, ts: new Date().toISOString(), event });
        if (record.activeTurnId) void store!.append(root, envelope({ type: 'turn.ended', turnId: record.activeTurnId, state: 'failed', error: { message: ended.message } }));
        if (record.id === root) {
          save(record, record.status === 'idle' ? { status: 'closed', activeTurnId: undefined } : { status: 'error', lastError: ended, activeTurnId: undefined });
        } else {
          // Children never survive their runtime; their requester learns the assignment failed.
          void store!.append(root, envelope({ type: 'session.closed' }));
          save(record, { status: 'closed', lastError: ended, activeTurnId: undefined });
          if (runLogDir) {
            const line = JSON.stringify({ ts: new Date().toISOString(), rootSessionId: root, event: 'assignment.finished', assignmentId: record.id, agent: record.session?.agent, sessionId: record.id, status: 'failed', error: ended.message, reconciled: true }) + '\n';
            await mkdir(runLogDir, { recursive: true }).then(() => appendFile(path.join(runLogDir, `${root.replace(/[^\w.-]/g, '_')}.jsonl`), line)).catch(() => {});
          }
        }
      }
    }
  }

  /**
   * Sends a prompt at most once per (session, clientMessageId), as Paseo's MessageReceipts:
   * a repeat with the same content is a no-op, with other content a conflict, and a
   * receipt left pending by a crash means the outcome is unknown.
   */
  function deliverOnce(sessionId: string, clientMessageId: string, fingerprint: string, send: () => Promise<void>) {
    const key = digest(['prompt', sessionId, clientMessageId]);
    const attempt = async () => {
      const existing = await store!.receipt(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new RpcError(ERROR.conflict, `Message ${clientMessageId} was already sent with different content`, { reason: 'key_conflict' });
        if (existing.state === 'completed') return { duplicate: true };
        throw new RpcError(ERROR.conflict, `alpd stopped while delivering message ${clientMessageId}; check the session, then send it again with a new id`, { reason: 'outcome_unknown' });
      }
      const receipt = (state: Receipt['state']): Receipt => ({ version: 1, sessionId, clientMessageId, fingerprint, state, updatedAt: new Date().toISOString() });
      live(sessionId);
      await store!.putReceipt(key, receipt('pending'));
      await send();
      await store!.putReceipt(key, receipt('completed'));
      return {};
    };
    const previous = delivering.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(attempt);
    delivering.set(key, result);
    void result.finally(() => { if (delivering.get(key) === result) delivering.delete(key); }).catch(() => {});
    return result;
  }

  function forget(root: string) {
    if (runtime.snapshot(root)) return;
    for (const [id, candidate] of rootOf) if (candidate === root) rootOf.delete(id);
    logs.delete(root);
  }

  /** Closes an idle root that no client watches. */
  async function reap(root: string) {
    if (closing || attached.get(root)?.size) return false;
    const session = runtime.snapshot(root);
    if (!session || session.busy) return false;
    await runtime.close(root).catch(() => {});
    return true;
  }

  function attach(connection: Connection, root: string) {
    const set = attached.get(root) ?? new Set();
    set.add(connection);
    attached.set(root, set);
    connection.roots.add(root);
  }

  function detach(connection: Connection, root: string) {
    attached.get(root)?.delete(connection);
    if (!attached.get(root)?.size) attached.delete(root);
    connection.roots.delete(root);
  }

  function summary(id: string): SessionSummary | undefined {
    const record = records.get(id);
    const live = runtime.snapshot(id);
    const session = live ?? record?.session;
    if (!session) return undefined;
    const status: SessionStatus = live ? (live.activeTurnId ? 'running' : 'idle') : record?.status === 'error' ? 'error' : 'closed';
    return { ...session, ...(live ? {} : { busy: false, activeTurnId: undefined }), status, title: record?.title, lastError: record?.lastError, updatedAt: record?.updatedAt };
  }

  function known(sessionId: string) {
    const found = summary(sessionId);
    if (!found) throw new RpcError(ERROR.notFound, 'Session is not open');
    return found;
  }

  function live(sessionId: string) {
    const session = runtime.snapshot(sessionId);
    if (!session) throw new RpcError(ERROR.notFound, 'Session is not open');
    return session;
  }

  async function treeLog(root: string) {
    return logs.get(root) ?? await store?.timeline(root) ?? [];
  }

  /**
   * Delivers a tree's history: the root's latest items, then the children's events in their
   * original order, so a grandchild opens while its parent is still open.
   */
  function replayHistory(connection: Connection, root: string, log: Envelope[], { children = true } = {}) {
    const items = new Map<string, Envelope>();
    for (const envelope of log) {
      if (envelope.sessionId === root && envelope.event.type === 'item') items.set(envelope.event.item.id, envelope);
    }
    for (const item of items.values()) deliver(connection, item);
    if (children) for (const envelope of log) if (envelope.sessionId !== root && current(envelope)) deliver(connection, envelope);
  }

  /** Questions in a log are history; announceQuestions delivers the ones still waiting. */
  function current(envelope: Envelope) {
    return envelope.event.type !== 'question' && envelope.event.type !== 'question.resolved';
  }

  function announceQuestions(connection: Connection, root: string) {
    for (const question of runtime.questions()) {
      if (question.rootId !== root) continue;
      deliver(connection, { sessionId: question.sessionId, epoch: `announce-${startedAt}`, seq: 0, ts: new Date().toISOString(), event: { type: 'question', question } });
    }
  }

  /**
   * Re-announces a live tree to a client that reopens its root: the root as it is now,
   * its timeline when asked, then live children and running turns.
   */
  function announce(connection: Connection, root: string, history: 'replay' | 'skip') {
    const log = logs.get(root) ?? [];
    const sessions = runtime.list().filter(session => (rootOf.get(session.id) ?? session.id) === root);
    for (const session of sessions) {
      const opened = log.find(envelope => envelope.sessionId === session.id && envelope.event.type === 'session.opened');
      if (!opened || opened.event.type !== 'session.opened') continue;
      const seq = Math.max(...log.filter(envelope => envelope.sessionId === session.id).map(envelope => envelope.seq));
      const envelope = (event: Envelope['event']): Envelope => ({ sessionId: session.id, epoch: opened.epoch, seq, ts: new Date().toISOString(), event });
      deliver(connection, envelope({ ...opened.event, session }));
      if (history === 'replay' && session.id === root) replayHistory(connection, root, log, { children: false });
      deliver(connection, envelope({ type: 'session.ready' }));
      if (session.activeTurnId) deliver(connection, envelope({ type: 'turn.started', turnId: session.activeTurnId, origin: 'user' }));
    }
    announceQuestions(connection, root);
  }

  /** Reopens a closed root from its record: the native thread resumes, alpd replays the history. */
  async function resume(connection: Connection, record: SessionRecord, spec: any, history: 'replay' | 'skip', delegation: boolean) {
    const session = record.session;
    if (record.rootId !== record.id) throw new RpcError(ERROR.failed, 'Only root sessions can be resumed');
    if (!session?.persistent || !session.threadId || !record.spec) throw new RpcError(ERROR.failed, 'This session cannot be resumed');
    const agent = spec.agent ?? spec.restore?.agent;
    if (agent !== undefined && agent !== session.agent) throw new RpcError(ERROR.failed, 'Cannot resume a session as a different ALP agent');
    const stored = await treeLog(record.id);
    logs.set(record.id, [...stored]);
    attach(connection, record.id);
    try {
      const opened = await runtime.open(record.id, {
        ...record.spec,
        ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
        ...(spec.thinking !== undefined ? { thinking: spec.thinking } : {}),
        persist: true,
        restore: { agent: session.agent, threadId: session.threadId, runtime: session.runtime, model: session.model, workflow: session.workflow },
      }, { history: stored.length ? 'skip' : history, delegation: record.delegation ?? delegation });
      if (history === 'replay') replayHistory(connection, record.id, stored);
      return opened;
    } catch (error) {
      detach(connection, record.id);
      throw error;
    }
  }

  const handlers: Record<string, (connection: Connection, params: any) => Promise<unknown> | unknown> = {
    'daemon.status': () => ({ pid: process.pid, startedAt, version, protocolVersion: PROTOCOL_VERSION, sessions: runtime.list().length, questions: runtime.questions().length }),

    'session.status'(_connection, { sessionId }) {
      if (typeof sessionId !== 'string') throw new RpcError(-32602, 'sessionId is required');
      const status = runtime.status(sessionId);
      if (!status) throw new RpcError(ERROR.notFound, `Session ${sessionId} is not live`);
      return { status };
    },

    'session.message'(_connection, { sessionId, text }) {
      runtime.message(sessionId, text);
      return {};
    },

    /** The assignment log of a session's tree, from the run log. */
    async 'session.log'(_connection, { sessionId }) {
      const root = rootOf.get(sessionId) ?? records.get(sessionId)?.rootId ?? sessionId;
      if (!runLogDir) return { rootId: root, entries: [] };
      const text = await readFile(path.join(runLogDir, `${root.replace(/[^\w.-]/g, '_')}.jsonl`), 'utf8').catch(() => '');
      const entries = text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      return { rootId: root, entries };
    },

    'question.list'(_connection, { projectRoot } = {}) {
      const questions = runtime.questions().filter(question => projectRoot === undefined || runtime.snapshot(question.rootId)?.projectRoot === projectRoot);
      return { questions };
    },

    /** The project board: live claims, decisions and findings (ALPD §18). */
    async 'board.list'(_connection, { projectRoot } = {}) {
      if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) throw new RpcError(-32602, 'An absolute projectRoot is required');
      return { pins: await runtime.board(projectRoot) };
    },

    /** Pauses delegation and wakes on a runtime, or everywhere (ALPD §29). */
    'daemon.pause'(_connection, { runtime: kind, now = false, reason } = {}) {
      try { return runtime.pause({ ...(kind === undefined ? {} : { runtime: kind }), now: now === true, ...(reason === undefined ? {} : { reason }) }); }
      catch (error: any) { throw new RpcError(-32602, error?.message ?? String(error)); }
    },

    'daemon.resume'(_connection, { runtime: kind } = {}) {
      try { return runtime.resume(kind === undefined ? {} : { runtime: kind }); }
      catch (error: any) { throw new RpcError(-32602, error?.message ?? String(error)); }
    },

    'daemon.pauses'() {
      return runtime.pauses();
    },

    /** Asks a finished assignment, or the last one on a task, about its work (ALPD §27). */
    async 'assignment.recall'(_connection, { assignmentId, taskId, projectRoot, question } = {}) {
      if (projectRoot !== undefined && (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot))) throw new RpcError(-32602, 'projectRoot must be absolute');
      try {
        return await runtime.recall({ assignmentId, taskId, projectRoot }, question);
      } catch (error: any) {
        throw new RpcError(ERROR.failed, error?.message ?? String(error));
      }
    },

    'question.answer'(_connection, { questionId, text, dismiss = false, reason }) {
      if (typeof questionId !== 'string') throw new RpcError(-32602, 'questionId is required');
      if (dismiss !== true && typeof text !== 'string') throw new RpcError(-32602, 'text or dismiss is required');
      // A unique prefix is enough, as in the CLI.
      const matches = runtime.questions().filter(question => question.id === questionId || question.id.startsWith(questionId));
      if (matches.length !== 1) throw new RpcError(ERROR.notFound, matches.length ? `Question id ${questionId} is ambiguous` : `No question ${questionId} waits for an answer`);
      runtime.answer(matches[0].id, dismiss === true ? { dismiss: true, reason } : { text });
      return { questionId: matches[0].id };
    },

    'daemon.shutdown': () => {
      setImmediate(() => onShutdown?.());
      return {};
    },

    'catalog.get': () => ({ models, modes, thinkingOptions, defaultModel: `codex:${DEFAULT_MODEL}` }),

    async 'session.create'(connection, { sessionId, spec, history = 'skip', delegation = true, resume: resuming = false }) {
      if (!spec || typeof spec !== 'object' || typeof spec.cwd !== 'string') throw new RpcError(-32602, 'spec.cwd is required');
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId))) throw new RpcError(-32602, 'Invalid session id');
      if (history !== 'replay' && history !== 'skip') throw new RpcError(-32602, 'history must be replay or skip');
      const id = sessionId ?? `ses_${randomBytes(8).toString('hex')}`;
      const existing = runtime.snapshot(id);
      if (existing) {
        // Reopening a root that kept working after its viewer left: attach to it.
        const agent = spec.agent ?? spec.restore?.agent;
        if (existing.parentId || (agent !== undefined && agent !== existing.agent)) throw new RpcError(ERROR.failed, 'Session is already open');
        attach(connection, id);
        announce(connection, id, history);
        return { session: existing, attached: true };
      }
      const record = records.get(id);
      if (!record && resuming) throw new RpcError(ERROR.notFound, `ALP session ${id} no longer exists in alpd`);
      if (record) return { session: await resume(connection, record, spec, history, delegation), attached: false, resumed: true };
      const { restore: _restore, ...kept } = spec;
      const now = new Date().toISOString();
      save({ version: 1, id, rootId: id, spec: kept, delegation, status: 'initializing', createdAt: now, updatedAt: now });
      attach(connection, id);
      try {
        return { session: await runtime.open(id, spec, { history, delegation }), attached: false };
      } catch (error) {
        detach(connection, id);
        records.delete(id);
        await store?.remove(id, [id]);
        throw error;
      }
    },

    async 'session.attach'(connection, { sessionId, replay = true }) {
      const found = known(sessionId);
      const root = rootOf.get(sessionId) ?? records.get(sessionId)?.rootId ?? sessionId;
      attach(connection, root);
      if (replay) for (const envelope of await treeLog(root)) if (current(envelope)) deliver(connection, envelope);
      announceQuestions(connection, root);
      return { session: root === found.id ? found : summary(root) };
    },

    async 'session.release'(connection, { sessionId }) {
      const root = rootOf.get(sessionId) ?? sessionId;
      detach(connection, root);
      return { closed: await reap(root) };
    },

    async 'session.prompt'(_connection, { sessionId, clientMessageId, delivery = 'auto', content }) {
      if (typeof clientMessageId !== 'string' || !Array.isArray(content)) throw new RpcError(-32602, 'clientMessageId and content are required');
      if (delivery !== 'auto' && delivery !== 'steer') throw new RpcError(-32602, 'delivery must be auto or steer');
      const send = async () => {
        // Failures of an open session arrive as prompt.failed events; an unknown session has no watcher.
        live(sessionId);
        await runtime.prompt(sessionId, { clientMessageId, delivery, content });
      };
      if (!store) {
        await send();
        return {};
      }
      return deliverOnce(sessionId, clientMessageId, digest({ delivery, content }), send);
    },

    async 'session.interrupt'(_connection, { sessionId }) {
      await runtime.interrupt(sessionId);
      return {};
    },

    async 'session.configure'(_connection, { sessionId, mode }) {
      return { session: await runtime.configure(sessionId, { mode }) };
    },

    async 'session.close'(_connection, { sessionId }) {
      await runtime.close(sessionId);
      return {};
    },

    'session.get'(_connection, { sessionId }) {
      return { session: known(sessionId) };
    },

    'session.list'(_connection, { projectRoot, rootsOnly = false, includeClosed = false } = {}): { sessions: SessionSummary[] } {
      const ids = new Set([...runtime.list().map(session => session.id), ...records.keys()]);
      const sessions = [...ids].map(summary).filter((session): session is SessionSummary => !!session)
        .filter(session => includeClosed || session.status === 'idle' || session.status === 'running')
        .filter(session => !rootsOnly || !session.parentId)
        .filter(session => projectRoot === undefined || session.projectRoot === projectRoot)
        .sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      return { sessions };
    },
  };

  async function dispatch(connection: Connection, message: any) {
    const { id, method, params } = message ?? {};
    const respond = (body: object) => { if (id !== undefined && id !== null) connection.send({ jsonrpc: '2.0', id, ...body }); };
    try {
      if (message?.jsonrpc !== '2.0' || typeof method !== 'string') throw new RpcError(-32600, 'Invalid request');
      if (method === 'daemon.hello') {
        if (params?.protocolVersion !== PROTOCOL_VERSION) throw new RpcError(ERROR.protocol, `ALP daemon speaks protocol ${PROTOCOL_VERSION}; restart it after upgrading (alp daemon restart)`);
        connection.helloed = true;
        respond({ result: { protocolVersion: PROTOCOL_VERSION, daemonVersion: version, pid: process.pid } });
        return;
      }
      if (!connection.helloed) throw new RpcError(ERROR.protocol, 'daemon.hello is required first');
      await restored;
      const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
      if (!handler) throw new RpcError(-32601, `Unknown method '${method}'`);
      respond({ result: await handler(connection, params ?? {}) });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : /is not open/.test(String((error as Error)?.message)) ? ERROR.notFound : ERROR.failed;
      const data = error instanceof RpcError && error.data !== undefined ? { data: error.data } : {};
      respond({ error: { code, message: error instanceof Error ? error.message : String(error), ...data } });
    }
  }

  function disconnect(connection: Connection) {
    connections.delete(connection);
    for (const root of [...connection.roots]) {
      detach(connection, root);
      void reap(root);
    }
  }

  const server = net.createServer(socket => {
    if (closing) { socket.destroy(); return; }
    const connection: Connection = {
      socket,
      helloed: false,
      roots: new Set(),
      send(message) { if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`); },
    };
    connections.add(connection);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME) { socket.destroy(); return; }
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { connection.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
        void dispatch(connection, message);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => disconnect(connection));
  });

  return {
    async listen() {
      await unlink(socketPath).catch(() => {});
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => { server.off('error', reject); resolve(); });
      });
      await chmod(socketPath, 0o600);
    },

    local() {
      const events = new Set<(envelope: Envelope) => void>();
      const closes = new Set<(error: Error) => void>();
      const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
      let sequence = 0;
      let ended = false;
      const connection: Connection = {
        helloed: true,
        roots: new Set(),
        send(message: any) {
          if (message.method === 'event') {
            for (const listener of events) listener(message.params);
            return;
          }
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          if (message.error) waiter.reject(new AlpRpcError(message.error));
          else waiter.resolve(message.result);
        },
      };
      connections.add(connection);
      return {
        request(method, params = {}) {
          if (ended) return Promise.reject(new Error('ALP daemon connection closed'));
          const id = ++sequence;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            void dispatch(connection, { jsonrpc: '2.0', id, method, params });
          });
        },
        onEvent(listener) { events.add(listener); return () => events.delete(listener); },
        onClose(listener) { closes.add(listener); return () => closes.delete(listener); },
        close() {
          if (ended) return;
          ended = true;
          disconnect(connection);
        },
      };
    },

    async close() {
      closing = true;
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      for (const connection of connections) connection.socket?.destroy();
      await stopped;
      await unlink(socketPath).catch(() => {});
      await store?.flush();
    },
  };
}
