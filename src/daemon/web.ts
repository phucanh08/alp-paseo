import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_FRAME } from '../client/index.js';
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

export type WebInfo = { port: number; token: string; url: string; pid: number };

export function webFile(home: string) {
  return path.join(home, 'web.json');
}

/** The token is made once and kept, so an open page survives alpd restarts. */
async function lastToken(home: string) {
  try {
    const { token } = JSON.parse(await readFile(webFile(home), 'utf8'));
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) return token;
  } catch {}
  return randomBytes(32).toString('hex');
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createWebServer({ daemon, assets, home, port = DEFAULT_WEB_PORT, log = () => {} }: {
  daemon: DaemonServer;
  assets: WebAssets;
  home: string;
  port?: number;
  log?: (message: string) => void;
}) {
  let token = '';
  let bound = 0;
  const hosts = () => new Set([`127.0.0.1:${bound}`, `localhost:${bound}`]);
  const origins = () => new Set([`http://127.0.0.1:${bound}`, `http://localhost:${bound}`]);

  const server = http.createServer((request, response) => {
    if (!hosts().has(request.headers.host ?? '')) { response.writeHead(403).end('Forbidden host'); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    // The app routes in the page: any other path gets the page.
    const asset = assets[pathname] ?? (path.extname(pathname) ? undefined : assets['/index.html']);
    if (!asset) { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, {
      'content-type': asset.type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'self'; connect-src 'self' ws://127.0.0.1:${bound} ws://localhost:${bound}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`,
    });
    response.end(request.method === 'HEAD' ? undefined : asset.body);
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const offered = url.searchParams.get('token') ?? '';
    const refuse = (status: string) => { socket.end(`HTTP/1.1 ${status}\r\n\r\n`); };
    if (url.pathname !== '/ws' || !hosts().has(request.headers.host ?? '')) return refuse('403 Forbidden');
    if (!origins().has(request.headers.origin ?? '')) return refuse('403 Forbidden');
    if (!same(offered, token)) return refuse('401 Unauthorized');
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
    /** Listens on the first free port from `port`, and records where in web.json. */
    async listen(): Promise<WebInfo> {
      token = await lastToken(home);
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
      const info: WebInfo = { port: bound, token, url: `http://127.0.0.1:${bound}/`, pid: process.pid };
      await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(`${webFile(home)}.tmp`, JSON.stringify(info), { mode: 0o600 });
      await rename(`${webFile(home)}.tmp`, webFile(home));
      return info;
    },

    async close() {
      for (const client of sockets.clients) client.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
