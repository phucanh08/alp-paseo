import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_FRAME } from '../client/index.js';
import { bearerOf, type PaseoGateway } from './paseo/gateway.js';
import type { DaemonServer } from './server.js';

/**
 * The local web app (ALPD §61): alpd serves the page on 127.0.0.1 and the page speaks
 * alpd's own JSON-RPC over a WebSocket. The page is public; the socket needs the token
 * kept in $ALP_HOME/web.json, which `alp web` puts in the address it opens. Requests
 * must name this host and port (no DNS rebinding), and the socket must come from the
 * page's own origin (no other site in the browser).
 */

export const DEFAULT_WEB_PORT = 7433;
/** Ports tried after a busy one. */
const PORT_TRIES = 10;

export type WebAssets = Record<string, { type: string; body: string }>;

export type WebInfo = { port: number; token: string; url: string; pid: number; serverId: string };

/** The built ALP web app (Paseo's app, D31): served from a directory, its socket speaks Paseo's protocol. */
export type WebApp = { dir: string; gateway: PaseoGateway & { close?(): void } };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
};

export function webFile(home: string) {
  return path.join(home, 'web.json');
}

/** The token and the server id are made once and kept, so an open page survives alpd restarts. */
async function lastIdentity(home: string) {
  let kept: { token?: unknown; serverId?: unknown } = {};
  try { kept = JSON.parse(await readFile(webFile(home), 'utf8')); } catch {}
  return {
    token: typeof kept.token === 'string' && /^[a-f0-9]{64}$/.test(kept.token) ? kept.token : randomBytes(32).toString('hex'),
    serverId: typeof kept.serverId === 'string' && /^alp-[a-f0-9]{16}$/.test(kept.serverId) ? kept.serverId : `alp-${randomBytes(8).toString('hex')}`,
  };
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createWebServer({ daemon, assets, app, home, port = DEFAULT_WEB_PORT, log = () => {} }: {
  daemon: DaemonServer;
  /** The classic page (ALPD §61), served when no built app is given. */
  assets: WebAssets;
  app?: WebApp;
  home: string;
  port?: number;
  log?: (message: string) => void;
}) {
  let token = '';
  let serverId = '';
  let bound = 0;
  const hosts = () => new Set([`127.0.0.1:${bound}`, `localhost:${bound}`]);
  const origins = () => new Set([`http://127.0.0.1:${bound}`, `http://localhost:${bound}`]);

  const csp = (paseo: boolean) => paseo
    // Paseo's app inlines styles, builds images and workers from blobs, and may compile WebAssembly.
    ? `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' ws://127.0.0.1:${bound} ws://localhost:${bound}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`
    : `default-src 'self'; connect-src 'self' ws://127.0.0.1:${bound} ws://localhost:${bound}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`;
  const headers = (type: string, paseo: boolean) => ({
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': csp(paseo),
  });

  /** A file of the built app, with the compressed copy the browser takes; the page for any route. */
  async function serveApp(request: http.IncomingMessage, response: http.ServerResponse, dir: string, pathname: string) {
    let relative: string;
    try { relative = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, ''); } catch { response.writeHead(400).end(); return; }
    let file = path.join(dir, relative);
    if (!file.startsWith(dir + path.sep) && file !== dir) { response.writeHead(403).end(); return; }
    const found = await stat(file).then(info => info.isFile(), () => false);
    if (!found) {
      if (path.extname(relative)) { response.writeHead(404).end('Not found'); return; }
      file = path.join(dir, 'index.html');
    }
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    const accepts = String(request.headers['accept-encoding'] ?? '');
    let encoding: 'br' | 'gzip' | undefined;
    let body = file;
    for (const [name, suffix] of [['br', '.br'], ['gzip', '.gz']] as const) {
      if (accepts.includes(name) && await stat(file + suffix).then(info => info.isFile(), () => false)) { encoding = name; body = file + suffix; break; }
    }
    const { size } = await stat(body);
    response.writeHead(200, {
      ...headers(type, true),
      // Expo names its bundles by content; everything else may change with the next build.
      'cache-control': relative.startsWith('_expo/static/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'content-length': String(size),
      vary: 'accept-encoding',
      ...(encoding ? { 'content-encoding': encoding } : {}),
    });
    if (request.method === 'HEAD') { response.end(); return; }
    createReadStream(body).on('error', () => response.destroy()).pipe(response);
  }

  const server = http.createServer((request, response) => {
    if (!hosts().has(request.headers.host ?? '')) { response.writeHead(403).end('Forbidden host'); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (app) { serveApp(request, response, app.dir, pathname).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); }); return; }
    // The app routes in the page: any other path gets the page.
    const asset = assets[pathname] ?? (path.extname(pathname) ? undefined : assets['/index.html']);
    if (!asset) { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, { ...headers(asset.type, false), 'cache-control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : asset.body);
  });

  // A browser carries Paseo's password as a subprotocol and needs it echoed to keep the socket.
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, handleProtocols: protocols => (app && bearerOf(protocols)) ?? false });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const refuse = (status: string) => { socket.end(`HTTP/1.1 ${status}\r\n\r\n`); };
    if (url.pathname !== '/ws' || !hosts().has(request.headers.host ?? '')) return refuse('403 Forbidden');
    if (!origins().has(request.headers.origin ?? '')) return refuse('403 Forbidden');
    if (app) {
      // The token comes with the hello (or as the subprotocol) and the gateway checks it.
      sockets.handleUpgrade(request, socket, head, ws => app.gateway.attach(ws, { bearer: ws.protocol || undefined }));
      return;
    }
    if (!same(url.searchParams.get('token') ?? '', token)) return refuse('401 Unauthorized');
    sockets.handleUpgrade(request, socket, head, ws => bridge(ws));
  });

  function bridge(ws: WebSocket) {
    const connection = daemon.accept(message => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); });
    ws.on('message', (data, binary) => {
      if (binary) return;
      let message;
      try { message = JSON.parse(String(data)); } catch { ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); return; }
      connection.receive(message);
    });
    ws.on('close', () => connection.close());
    ws.on('error', () => connection.close());
  }

  return {
    get token() { return token; },
    get serverId() { return serverId; },
    /** Listens on the first free port from `port`, and records where in web.json. */
    async listen(): Promise<WebInfo> {
      ({ token, serverId } = await lastIdentity(home));
      for (let attempt = 0; ; attempt++) {
        const candidate = port + attempt;
        try {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(candidate, '127.0.0.1', () => { server.off('error', reject); resolve(); });
          });
          bound = candidate;
          break;
        } catch (error: any) {
          if (error?.code !== 'EADDRINUSE' || attempt + 1 >= PORT_TRIES || port === 0) throw error;
          log(`port ${candidate} is in use; trying ${candidate + 1}`);
        }
      }
      bound = (server.address() as { port: number }).port;
      const info: WebInfo = { port: bound, token, url: `http://127.0.0.1:${bound}/`, pid: process.pid, serverId };
      await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(`${webFile(home)}.tmp`, JSON.stringify(info), { mode: 0o600 });
      await rename(`${webFile(home)}.tmp`, webFile(home));
      return info;
    },

    async close() {
      for (const client of sockets.clients) client.terminate();
      app?.gateway.close?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
