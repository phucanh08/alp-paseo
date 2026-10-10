import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import WebSocket from 'ws';
import { validateWSOutboundMessage } from '@getpaseo/protocol/validation/ws-outbound';
import { createAlpRuntime } from '../dist/runtime/index.js';
import { createDaemonServer, createPaseoBridge, createWebServer } from '../dist/daemon/index.js';
import { fakeTransport } from './support/fake-agent.js';

/** alpd in this process serving a stand-in for the built ALP web app (Paseo's app, ALPD §62). */
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-paseo-web-'));
  const home = path.join(directory, 'home');
  const dir = path.join(directory, 'web-app');
  await mkdir(path.join(dir, '_expo/static/js/web'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>ALP</title><script src="/_expo/static/js/web/index-1.js" defer></script>');
  const bundle = `console.log(${JSON.stringify('x'.repeat(4000))})`;
  await writeFile(path.join(dir, '_expo/static/js/web/index-1.js'), bundle);
  await writeFile(path.join(dir, '_expo/static/js/web/index-1.js.br'), brotliCompressSync(bundle));
  await writeFile(path.join(directory, 'secret.txt'), 'no');
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport([]), supervisor: false, libraryDir: home });
  const daemon = createDaemonServer({ runtime, socketPath: '', version: 'test' });
  let web;
  const gateway = createPaseoBridge({ daemon, version: 'test', token: () => web.token, serverId: () => web.serverId });
  web = createWebServer({ daemon, home, port: 0, assets: {}, app: { dir, gateway } });
  const info = await web.listen();
  t.after(async () => { await web.close(); await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const origin = `http://127.0.0.1:${info.port}`;
  /** A socket as the app opens it: every frame alpd sends must pass Paseo's own validator. */
  const socket = (options = {}) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, options.protocols ?? [], { headers: { Origin: options.origin ?? origin } });
    const frames = [];
    const waiting = [];
    ws.on('message', data => {
      const frame = JSON.parse(String(data));
      const checked = validateWSOutboundMessage(frame);
      assert.ok(checked.success, `alpd sent a frame Paseo's app drops: ${JSON.stringify(frame).slice(0, 300)}\n${checked.error}`);
      frames.push(frame);
      for (const wait of [...waiting]) if (wait.test(frame)) { waiting.splice(waiting.indexOf(wait), 1); wait.resolve(frame); }
    });
    ws.on('unexpected-response', (_request, response) => reject(new Error(`refused ${response.statusCode}`)));
    ws.on('error', reject);
    ws.on('open', () => {
      t.after(() => ws.close());
      const next = test => new Promise(done => { const found = frames.find(test); if (found) done(found); else waiting.push({ test, resolve: done }); });
      const closed = new Promise(done => ws.on('close', (code, reason) => done({ code, reason: String(reason) })));
      resolve({ ws, frames, next, closed, send: frame => ws.send(JSON.stringify(frame)) });
    });
  });
  const hello = (extra = {}) => ({ type: 'hello', clientId: 'cid-test', clientType: 'browser', protocolVersion: 1, capabilities: { helloRejection: true }, ...extra });
  const session = (client, message) => client.send({ type: 'session', message });
  return { info, origin, socket, hello, session };
}

test('alpd serves the built app: compressed bundles, the page for any route, nothing outside it', async t => {
  const { origin } = await setup(t);
  const page = await fetch(`${origin}/workspace/abc`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>ALP/);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const bundle = await fetch(`${origin}/_expo/static/js/web/index-1.js`, { headers: { 'accept-encoding': 'br' } });
  assert.equal(bundle.headers.get('content-encoding'), 'br');
  assert.equal(bundle.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(await bundle.text(), /^console\.log/);
  assert.equal((await fetch(`${origin}/_expo/static/js/web/missing.js`)).status, 404);
  // Encoded climbs stay inside the app's directory.
  const climb = await fetch(`${origin}/_expo/..%2f..%2f..%2fsecret.txt`);
  assert.equal(climb.status, 404);
});

test('the socket wants the token at hello, then speaks Paseo: server_info, pongs, and "in development" for the rest', async t => {
  const { socket, hello, session, info } = await setup(t);
  await assert.rejects(socket({ origin: 'https://attacker.example' }), /refused 403/);

  const anonymous = await socket();
  anonymous.send(hello());
  assert.equal((await anonymous.next(frame => frame.type === 'hello.rejected')).reason, 'password_required');
  assert.equal((await anonymous.closed).code, 4401);

  const wrong = await socket();
  wrong.send(hello({ auth: { kind: 'password', password: '0'.repeat(64) } }));
  assert.equal((await wrong.next(frame => frame.type === 'hello.rejected')).reason, 'incorrect_password');

  const client = await socket();
  client.send(hello({ auth: { kind: 'password', password: info.token } }));
  const serverInfo = await client.next(frame => frame.message?.payload?.status === 'server_info');
  assert.equal(serverInfo.message.payload.serverId, info.serverId);
  assert.match(info.serverId, /^alp-[0-9a-f]{16}$/);
  client.send({ type: 'ping' });
  await client.next(frame => frame.type === 'pong');
  session(client, { type: 'ping', requestId: 'p1', clientSentAt: 5 });
  assert.equal((await client.next(frame => frame.message?.type === 'pong')).message.payload.clientSentAt, 5);
  session(client, { type: 'list_terminals_request', requestId: 'r1', cwd: '/' });
  const refused = await client.next(frame => frame.message?.type === 'rpc_error');
  assert.deepEqual(refused.message.payload, { requestId: 'r1', requestType: 'list_terminals_request', error: 'list_terminals_request is not in ALP yet', code: 'not_implemented' });
});

test('a browser may carry the token as the paseo.bearer subprotocol, and gets it echoed', async t => {
  const { socket, hello, info } = await setup(t);
  const client = await socket({ protocols: [`paseo.bearer.${info.token}`] });
  assert.equal(client.ws.protocol, `paseo.bearer.${info.token}`);
  client.send(hello());
  await client.next(frame => frame.message?.payload?.status === 'server_info');
});
