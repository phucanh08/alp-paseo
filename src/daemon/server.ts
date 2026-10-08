import { randomBytes } from 'node:crypto';
import { chmod, unlink } from 'node:fs/promises';
import net from 'node:net';
import { AlpRpcError, MAX_FRAME, PROTOCOL_VERSION } from '../client/index.js';
import { DEFAULT_MODEL, models, modes, thinkingOptions, type AlpRuntime, type Envelope, type SessionSnapshot } from '../runtime/index.js';

/**
 * alpd's JSON-RPC surface over one shared runtime (plans/reference/ALPD.md §3, §6).
 * Clients attach to root sessions to receive the events of the whole tree. A root
 * with no attached client is closed as soon as it is idle, so work started by a
 * viewer finishes even after the viewer goes away.
 */

export const ERROR = { failed: 1000, notFound: 1001, protocol: 1006 } as const;

class RpcError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

type Connection = {
  socket?: net.Socket;
  helloed: boolean;
  roots: Set<string>;
  send(message: unknown): void;
};

type Logged = { order: number; envelope: Envelope };

/** Retained events per tree, for attach and replay. */
const TREE_LOG_LIMIT = 20_000;
const SESSION_ID = /^[\w.:-]{1,128}$/;

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

export function createDaemonServer({ runtime, socketPath, version, onShutdown }: {
  runtime: AlpRuntime;
  socketPath: string;
  version: string;
  onShutdown?: () => void;
}): DaemonServer {
  const connections = new Set<Connection>();
  /** Root of every session seen, until its root closes. */
  const rootOf = new Map<string, string>();
  const attached = new Map<string, Set<Connection>>();
  const logs = new Map<string, Logged[]>();
  let order = 0;
  let closing = false;
  const startedAt = new Date().toISOString();

  const deliver = (connection: Connection, envelope: Envelope) => connection.send({ jsonrpc: '2.0', method: 'event', params: envelope });

  runtime.onEvent(envelope => {
    const { sessionId, event } = envelope;
    if (event.type === 'session.opened') {
      const parent = event.session.parentId;
      rootOf.set(sessionId, parent ? rootOf.get(parent) ?? parent : sessionId);
    }
    const root = rootOf.get(sessionId) ?? sessionId;
    if (rootOf.has(sessionId)) {
      const log = logs.get(root) ?? [];
      log.push({ order: ++order, envelope });
      if (log.length > TREE_LOG_LIMIT) log.splice(0, log.length - TREE_LOG_LIMIT);
      logs.set(root, log);
    }
    for (const connection of attached.get(root) ?? []) deliver(connection, envelope);
    if (event.type === 'session.closed' && sessionId === root) {
      setImmediate(() => forget(root));
    } else {
      setImmediate(() => void reap(root));
    }
  });

  function forget(root: string) {
    if (runtime.snapshot(root)) return;
    for (const [id, candidate] of rootOf) if (candidate === root) rootOf.delete(id);
    logs.delete(root);
    for (const connection of attached.get(root) ?? []) connection.roots.delete(root);
    attached.delete(root);
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
    connection.roots.delete(root);
  }

  function live(sessionId: string) {
    const session = runtime.snapshot(sessionId);
    if (!session) throw new RpcError(ERROR.notFound, 'Session is not open');
    return session;
  }

  function treeRoot(sessionId: string) {
    live(sessionId);
    return rootOf.get(sessionId) ?? sessionId;
  }

  /**
   * Re-announces a live tree to a client that reopens its root: the root as it is now,
   * its timeline when asked, then live children and running turns.
   */
  function announce(connection: Connection, root: string, history: 'replay' | 'skip') {
    const log = (logs.get(root) ?? []).map(entry => entry.envelope);
    const sessions = runtime.list().filter(session => (rootOf.get(session.id) ?? session.id) === root);
    for (const session of sessions) {
      const opened = log.find(envelope => envelope.sessionId === session.id && envelope.event.type === 'session.opened');
      if (!opened || opened.event.type !== 'session.opened') continue;
      const seq = Math.max(...log.filter(envelope => envelope.sessionId === session.id).map(envelope => envelope.seq));
      const envelope = (event: Envelope['event']): Envelope => ({ sessionId: session.id, epoch: opened.epoch, seq, ts: new Date().toISOString(), event });
      deliver(connection, envelope({ ...opened.event, session }));
      if (history === 'replay' && session.id === root) {
        const items = new Map<string, Envelope>();
        for (const candidate of log) {
          if (candidate.sessionId === root && candidate.event.type === 'item') items.set(candidate.event.item.id, candidate);
        }
        for (const item of items.values()) deliver(connection, item);
      }
      deliver(connection, envelope({ type: 'session.ready' }));
      if (session.activeTurnId) deliver(connection, envelope({ type: 'turn.started', turnId: session.activeTurnId, origin: 'user' }));
    }
  }

  const handlers: Record<string, (connection: Connection, params: any) => Promise<unknown> | unknown> = {
    'daemon.status': () => ({ pid: process.pid, startedAt, version, protocolVersion: PROTOCOL_VERSION, sessions: runtime.list().length }),

    'daemon.shutdown': () => {
      setImmediate(() => onShutdown?.());
      return {};
    },

    'catalog.get': () => ({ models, modes, thinkingOptions, defaultModel: `codex:${DEFAULT_MODEL}` }),

    async 'session.create'(connection, { sessionId, spec, history = 'skip', delegation = true }) {
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
      attach(connection, id);
      try {
        return { session: await runtime.open(id, spec, { history, delegation }), attached: false };
      } catch (error) {
        detach(connection, id);
        throw error;
      }
    },

    'session.attach'(connection, { sessionId, replay = true }) {
      const root = treeRoot(sessionId);
      attach(connection, root);
      if (replay) for (const { envelope } of logs.get(root) ?? []) deliver(connection, envelope);
      return { session: runtime.snapshot(root) };
    },

    async 'session.release'(connection, { sessionId }) {
      const root = rootOf.get(sessionId) ?? sessionId;
      detach(connection, root);
      return { closed: await reap(root) };
    },

    async 'session.prompt'(_connection, { sessionId, clientMessageId, delivery = 'auto', content }) {
      if (typeof clientMessageId !== 'string' || !Array.isArray(content)) throw new RpcError(-32602, 'clientMessageId and content are required');
      if (delivery !== 'auto' && delivery !== 'steer') throw new RpcError(-32602, 'delivery must be auto or steer');
      // Failures of an open session arrive as prompt.failed events; an unknown session has no watcher.
      live(sessionId);
      await runtime.prompt(sessionId, { clientMessageId, delivery, content });
      return {};
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
      return { session: live(sessionId) };
    },

    'session.list'(): { sessions: SessionSnapshot[] } {
      return { sessions: runtime.list() };
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
      const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
      if (!handler) throw new RpcError(-32601, `Unknown method '${method}'`);
      respond({ result: await handler(connection, params ?? {}) });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : /is not open/.test(String((error as Error)?.message)) ? ERROR.notFound : ERROR.failed;
      respond({ error: { code, message: error instanceof Error ? error.message : String(error) } });
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
    },
  };
}
