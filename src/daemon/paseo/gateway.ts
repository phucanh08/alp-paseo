import { timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import type { WebSocket } from 'ws';

/**
 * The ALP web app is Paseo's app (D31, ALPD §62), so alpd speaks Paseo's daemon protocol to it
 * on the page's own origin: a `hello` with the token as its password (or the `paseo.bearer.*`
 * subprotocol), then `server_info`, then session messages. ALP answers what it has and refuses the
 * rest with `rpc_error` code `not_implemented`, whose text the app shows as it is ("Tính năng đang
 * phát triển" in the user's language), so no request waits out the client's timeout.
 */

/** Paseo's protocol version and close codes (packages/server/src/server/websocket-server.ts there). */
export const PASEO_PROTOCOL_VERSION = 1;
const CLOSE_AUTH_FAILED = 4401;
const CLOSE_INCOMPATIBLE = 4003;
const CLOSE_INVALID_HELLO = 4002;
/** How long a socket may stay open without a good hello. */
const HELLO_TIMEOUT_MS = 15_000;

export const NOT_IMPLEMENTED = 'not_implemented';
export const BEARER_PREFIX = 'paseo.bearer.';

export type SessionMessage = { type: string; requestId?: string; [key: string]: unknown };
export type Outbound = { type: string; payload?: unknown; [key: string]: unknown };

export type ClientContext = {
  clientId: string;
  /** Sends one session message to this client. */
  emit(message: Outbound): void;
};

/** A request handler: returns the reply, or emits by itself and returns nothing. */
export type Handler = (message: any, client: ClientContext) => Outbound | void | Promise<Outbound | void>;

export type GatewayOptions = {
  token: () => string;
  serverId: () => string;
  version: string;
  handlers: Record<string, Handler>;
  /** What the app may light up; anything absent stays hidden or answers "in development". */
  features: Record<string, boolean>;
  onClient?(client: ClientContext): () => void;
  /** The text of a not_implemented answer, in the user's language. */
  inDevelopment?: () => string | Promise<string>;
  log?: (message: string) => void;
};

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The subprotocol a browser offers to carry its password; alpd answers with the same one. */
export function bearerOf(protocols: Iterable<string>) {
  for (const protocol of protocols) if (protocol.startsWith(BEARER_PREFIX)) return protocol;
  return undefined;
}

export function createPaseoGateway(options: GatewayOptions) {
  const { handlers, log = () => {} } = options;
  const inDevelopment = async () => { try { return await options.inDevelopment?.() ?? 'This feature is in development'; } catch { return 'This feature is in development'; } };
  const clients = new Set<ClientContext>();

  async function serverInfo() {
    // Voice and dictation say why they are off, so the app shows it instead of waiting on them.
    const off = { enabled: false, reason: await inDevelopment() };
    return {
      type: 'status',
      payload: {
        status: 'server_info',
        protocolVersion: PASEO_PROTOCOL_VERSION,
        serverId: options.serverId(),
        hostname: os.hostname(),
        version: options.version,
        features: options.features,
        capabilities: { voice: { dictation: off, voice: off } },
      },
    };
  }

  function attach(ws: WebSocket, { bearer }: { bearer?: string } = {}) {
    let client: ClientContext | undefined;
    let detach: (() => void) | undefined;
    const send = (frame: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame)); };
    const close = (code: number, reason: string) => { try { ws.close(code, reason); } catch {} };
    const timer = setTimeout(() => { if (!client) close(CLOSE_AUTH_FAILED, 'Hello timed out'); }, HELLO_TIMEOUT_MS);
    const bearerOk = bearer !== undefined && same(bearer.slice(BEARER_PREFIX.length), options.token());

    async function hello(message: any) {
      if (typeof message.clientId !== 'string' || !message.clientId.trim()) return close(CLOSE_INVALID_HELLO, 'Invalid hello');
      const reject = (reason: 'password_required' | 'incorrect_password' | 'incompatible_protocol') => {
        send({ type: 'hello.rejected', reason, accepts: ['password'] });
        close(reason === 'incompatible_protocol' ? CLOSE_INCOMPATIBLE : CLOSE_AUTH_FAILED, reason === 'incompatible_protocol' ? 'Incompatible protocol version' : reason === 'password_required' ? 'Password required' : 'Incorrect password');
      };
      if (typeof message.protocolVersion !== 'number' || message.protocolVersion < 1) return reject('incompatible_protocol');
      const password = message.auth?.kind === 'password' && typeof message.auth.password === 'string' ? message.auth.password : undefined;
      if (!bearerOk && password === undefined) return reject('password_required');
      if (!bearerOk && !same(password!, options.token())) return reject('incorrect_password');
      clearTimeout(timer);
      if (!client) {
        client = { clientId: message.clientId.trim(), emit: outbound => send({ type: 'session', message: outbound }) };
        clients.add(client);
        detach = options.onClient?.(client);
      }
      client.emit(await serverInfo());
    }

    async function session(message: SessionMessage) {
      if (!client || !message || typeof message.type !== 'string') return;
      if (process.env.ALP_PASEO_DEBUG) log(`paseo <- ${message.type}${message.requestId ? ` ${message.requestId}` : ''}`);
      if (message.type === 'ping' && typeof message.requestId === 'string') {
        const now = Date.now();
        client.emit({ type: 'pong', payload: { requestId: message.requestId, ...(typeof message.clientSentAt === 'number' ? { clientSentAt: message.clientSentAt } : {}), serverReceivedAt: now, serverSentAt: Date.now() } });
        return;
      }
      const handler = handlers[message.type];
      const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
      if (!handler) {
        // One-way messages ALP has no use for are dropped; a request gets an answer at once.
        if (requestId) client.emit({ type: 'rpc_error', payload: { requestId, requestType: message.type, error: await inDevelopment(), code: NOT_IMPLEMENTED } });
        return;
      }
      try {
        const reply = await handler(message, client);
        if (reply) client.emit(reply);
      } catch (error: any) {
        log(`paseo ${message.type} failed: ${error?.message ?? error}`);
        if (requestId) client.emit({ type: 'rpc_error', payload: { requestId, requestType: message.type, error: error?.message ?? String(error), ...(error?.code ? { code: String(error.code) } : {}) } });
      }
    }

    ws.on('message', (data, binary) => {
      if (binary) return;
      let frame: any;
      try { frame = JSON.parse(String(data)); } catch { return; }
      if (process.env.ALP_PASEO_DEBUG && frame?.type !== 'session') log(`paseo <= ${frame?.type}`);
      if (frame?.type === 'ping') send({ type: 'pong' });
      else if (frame?.type === 'hello') void hello(frame);
      else if (frame?.type === 'session') void session(frame.message);
    });
    if (process.env.ALP_PASEO_DEBUG) ws.on('close', (code, reason) => log(`paseo socket closed ${code} ${String(reason)} (client ${client?.clientId ?? 'none'})`));
    const end = () => {
      clearTimeout(timer);
      if (client) clients.delete(client);
      detach?.();
      detach = undefined;
    };
    ws.on('close', end);
    ws.on('error', end);
  }

  return {
    attach,
    /** Sends a session message to every connected client. */
    broadcast(message: Outbound) { for (const client of clients) client.emit(message); },
    get clients() { return clients.size; },
  };
}

export type PaseoGateway = ReturnType<typeof createPaseoGateway>;
