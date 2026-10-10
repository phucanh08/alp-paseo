import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { initProject } from '../src/core/init.js';
import { validateUserSettings } from '../src/core/validation.js';
import { createAlpRuntime } from '../dist/runtime/index.js';
import { createDaemonServer, createWebServer, webFile } from '../dist/daemon/index.js';
import { fakeTransport } from './support/fake-agent.js';

const run = promisify(execFile);

/** alpd in this process with scripted agents, serving the web app on a free port. */
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-web-'));
  const home = path.join(directory, 'home');
  const root = path.join(directory, 'project');
  await initProject(root);
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport([]), supervisor: false, libraryDir: home });
  const daemon = createDaemonServer({ runtime, socketPath: '', version: 'test' });
  const web = createWebServer({ daemon, home, port: 0, assets: { '/index.html': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>ALP</title>' }, '/app.js': { type: 'text/javascript', body: 'export {}' } } });
  const info = await web.listen();
  t.after(async () => { await web.close(); await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const origin = `http://127.0.0.1:${info.port}`;
  /** A socket as the page opens it; resolves with a request function once open, or rejects with the refusal. */
  const socket = (options = {}) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws?token=${options.token ?? info.token}`, { headers: { Origin: options.origin ?? origin } });
    let id = 0;
    const pending = new Map();
    ws.on('message', data => { const message = JSON.parse(String(data)); pending.get(message.id)?.(message); });
    ws.on('unexpected-response', (_request, response) => reject(new Error(`refused ${response.statusCode}`)));
    ws.on('error', reject);
    ws.on('open', () => {
      t.after(() => ws.close());
      resolve((method, params = {}) => new Promise(done => { const n = ++id; pending.set(n, done); ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params })); }));
    });
  });
  return { directory, home, root, info, origin, socket };
}

test('alpd serves the page on 127.0.0.1, any route gets the page, and other hosts are refused', async t => {
  const { home, info, origin } = await setup(t);
  assert.equal(info.url, `${origin}/`);
  assert.deepEqual(JSON.parse(await readFile(webFile(home), 'utf8')), info);
  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(await page.text(), /<title>ALP/);
  assert.equal((await fetch(`${origin}/session/abc`)).status, 200);
  assert.equal((await fetch(`${origin}/missing.js`)).status, 404);
  // DNS rebinding: a name that resolves here is still refused.
  const { stdout } = await run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'Host: attacker.example', `${origin}/`]);
  assert.equal(stdout, '403');
});

test('the socket needs the token and the page\'s own origin, then speaks alpd\'s JSON-RPC', async t => {
  const { socket, root } = await setup(t);
  await assert.rejects(socket({ token: '0'.repeat(64) }), /refused 401/);
  await assert.rejects(socket({ origin: 'https://attacker.example' }), /refused 403/);
  const request = await socket();
  assert.match((await request('session.list')).error.message, /daemon.hello is required first/);
  assert.equal((await request('daemon.hello', { protocolVersion: 1, client: { name: 'test', version: '1' } })).result.daemonVersion, 'test');
  const { result } = await request('session.preview', { spec: { cwd: root } });
  assert.equal(result.preview.team, 'pho');
  assert.deepEqual(result.preview.teams.map(team => team.id).slice(0, 2), ['pho', 'cafe']);
});

test('the page reads and changes tasks, browses folders and sees the checkout\'s changes', async t => {
  const { socket, root, directory } = await setup(t);
  const request = await socket();
  await request('daemon.hello', { protocolVersion: 1, client: { name: 'test', version: '1' } });
  const { result: added } = await request('tasks.add', { projectRoot: root, title: 'Write the README' });
  const { result: listed } = await request('tasks.list', { projectRoot: root });
  assert.deepEqual(listed.tasks.map(task => [task.id, task.title, task.ready]), [[added.id, 'Write the README', true]]);
  assert.equal((await request('tasks.change', { projectRoot: root, id: added.id, action: 'close' })).result.status, 'closed');
  assert.match((await request('tasks.add', { projectRoot: directory, title: 'x' })).error.message, /not an ALP project/);

  const { result: folders } = await request('project.browse', { path: directory });
  assert.equal(folders.parent, path.dirname(directory));
  assert.deepEqual(folders.directories, [{ name: 'home', project: false }, { name: 'project', project: true }]);
  assert.match((await request('project.browse', { path: 'relative' })).error.message, /absolute/);

  assert.deepEqual((await request('project.changes', { projectRoot: root })).result, { git: false, files: [], diff: '' });
  await run('git', ['init', '-q'], { cwd: root });
  await run('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'start'], { cwd: root });
  await writeFile(path.join(root, 'ALP.md'), 'changed\n');
  const { result: changes } = await request('project.changes', { projectRoot: root });
  assert.equal(changes.git, true);
  assert.ok(changes.files.some(file => file.path === 'ALP.md' && file.status === '??'));
});

test('settings may turn the web app off or move its port', () => {
  assert.doesNotThrow(() => validateUserSettings({ web: { enabled: false, port: 8000 } }, 'settings.json'));
  assert.throws(() => validateUserSettings({ web: { port: 80 } }, 'settings.json'), /web.port must be a port from 1024/);
  assert.throws(() => validateUserSettings({ web: { host: '0.0.0.0' } }, 'settings.json'), /unsupported web field 'host'/);
});
