import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProvider, mapSession, default as contribute } from '../plugins/paseo/server/dist/index.js';
import { ProviderEventSchema, PROVIDER_CAPABILITIES } from '@getpaseo/plugin/server/provider';
import { connect, readLock } from '../src/client/index.js';
import { createTask } from '../src/core/tasks.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-paseo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['main', 'custom']) {
    const dir = path.join(root, '.alp', 'agents', name);
    await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'AGENT.md'), `Agent ${name}`);
  }
  await writeFile(path.join(root, 'ALP.md'), 'Project instructions');
  // The built-in supervisor would review each turn and keep a released tree running; these tests are not about it.
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  return root;
}
const config = cwd => ({ cwd, env: { ALP_TEST: 'session' }, systemPrompt: 'Host instructions', mcpServers: {}, settings: {}, persist: true });
function fakeRuntime() {
  let notification;
  return {
    calls: [], closed: false, fail: undefined,
    initialize: async () => {},
    onNotification(fn) { notification = fn; }, onFailure(fn) { this.fail = fn; }, onRequest(fn) { this.serverRequest = fn; },
    notify(method, params) { notification(method, params); },
    async close() { this.closed = true; },
    async request(method, params) {
      this.calls.push({ method, params });
      if (method.startsWith('thread/')) return { thread: { id: 'native-thread', turns: method === 'thread/resume' ? [{ items: [{ type: 'agentMessage', id: 'old', text: 'Previous output' }] }] : [] }, cwd: params.cwd, model: params.model, reasoningEffort: 'low' };
      if (method === 'turn/start') return { turn: { id: `turn-${this.calls.length}` } };
      return {};
    },
  };
}
async function connection(t, root) {
  const runtimes = []; const environments = [];
  const registration = createProvider({ environment: { PATH: 'baseline', PASEO_TOKEN: 'removed', CODEX_THREAD_ID: 'removed' }, transport: (cwd, env) => { environments.push(env); const r = fakeRuntime(); runtimes.push(r); return r; } });
  const conn = await registration.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  t.after(() => conn.close());
  const events = []; conn.onEvent(e => { ProviderEventSchema.parse(e); events.push(e); });
  await conn.send({ type: 'session.open', requestId: 'open', sessionId: 's', config: config(root), history: 'skip' });
  assert.ok(events.some(e => e.type === 'session.ready'), JSON.stringify(events));
  return { conn, events, runtimes, environments };
}
const prompt = (id, delivery = 'auto') => ({ type: 'session.prompt', sessionId: 's', prompt: { clientMessageId: id, delivery, input: { type: 'message', content: [{ type: 'text', text: 'Hello' }] } } });

test('plugin registers ALP with public SDK contract', async t => {
  // The registered provider starts the user's alpd; keep it in a throwaway home.
  const home = await mkdtemp(path.join(tmpdir(), 'alp-home-'));
  const previous = process.env.ALP_HOME;
  process.env.ALP_HOME = home;
  let dispose = () => {};
  t.after(async () => {
    // The plugin keeps alpd up while it is loaded; unload it first.
    await dispose();
    const lock = await readLock(home);
    if (lock?.ready) await connect(lock.socket).then(client => client.request('daemon.shutdown').finally(() => client.close())).catch(() => {});
    for (let i = 0; i < 100 && await readLock(home); i++) await new Promise(resolve => setTimeout(resolve, 20));
    if (previous === undefined) delete process.env.ALP_HOME; else process.env.ALP_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  let registration; const rpc = [];
  dispose = contribute({ registerProvider(p) { registration = p; }, handle(contract) { rpc.push(contract.name); } });
  assert.equal(registration.id, 'alp');
  assert.deepEqual(rpc, ['alp.tasks.list', 'alp.tasks.add', 'alp.tasks.change', 'alp.library.list', 'alp.library.get', 'alp.library.save', 'alp.library.skills', 'alp.library.delete', 'alp.library.duplicate', 'alp.library.rename', 'alp.library.test']);
  await assert.rejects(registration.connect({ versions: [99], capabilities: [] }), /protocol/);
  const conn = await registration.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  const events = []; conn.onEvent(e => events.push(e));
  await conn.send({ type: 'catalog', requestId: 'catalog' });
  // Paseo offers the two profiles in place of models; each fixes main's model and effort.
  assert.equal(events[0].catalog.defaultModel, 'pho');
  assert.deepEqual(events[0].catalog.models.map(model => [model.id, model.label, model.thinkingOptions.length]), [['pho', 'Phở', 0], ['cafe', 'Cafe', 0]]);
  assert.deepEqual(events[0].catalog.thinkingOptions, []);
  assert.equal(events[0].catalog.defaultMode, 'full-access');
  assert.ok(events[0].catalog.modes.some(mode => mode.id === 'full-access'));
  // Permission prompts carry questions agents ask the user; per-tool approval stays unsupported.
  assert.equal(conn.capabilities.includes('permission'), true);
  assert.equal(conn.capabilities.includes('permission.tool_policy'), false);
  await conn.close();
});
test('opening the first session in an empty repository installs the ALP starter', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-paseo-new-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await mapSession(config(root));
  assert.equal(result.agent.name, 'main');
  assert.match(result.instructions, /ALP/);
  assert.equal(JSON.parse(await readFile(path.join(root, '.alp', 'settings.json'), 'utf8')).defaultAgent, 'main');
  // Agents come from ALP's built-ins; the project gets no copies (ALPD §41).
  assert.equal(result.agent.source, 'builtin');
  await assert.rejects(readFile(path.join(root, '.alp', 'agents', 'main', 'AGENT.md'), 'utf8'), { code: 'ENOENT' });
  assert.ok((await readFile(path.join(root, 'ALP.md'), 'utf8')).length > 0);
});
test('opening a session repairs a partial ALP directory without replacing user files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-paseo-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.alp'), { recursive: true });
  await writeFile(path.join(root, '.alp', 'custom.txt'), 'keep me');
  const result = await mapSession(config(root));
  assert.equal(result.agent.name, 'main');
  assert.equal(await readFile(path.join(root, '.alp', 'custom.txt'), 'utf8'), 'keep me');
  assert.ok((await readFile(path.join(root, '.alp', 'settings.json'), 'utf8')).length > 0);
});
test('mapping resolves defaults/custom, combines instructions, normalizes MCP and validates overrides', async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ runtime: { model: 'configured-model', reasoning: 'high' } }));
  await writeFile(path.join(root, '.alp', 'agents', 'main', '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'node', cwd: '.', args: ['server.js'] }, remote: { url: 'https://example.test/mcp', headers: { Accept: 'application/json' } } } }));
  const result = await mapSession(config(root));
  assert.equal(result.agent.name, 'main'); assert.equal(result.model, 'configured-model'); assert.equal(result.thinking, 'high');
  assert.equal(result.instructions, 'Project instructions\n\nAgent main\n\nHost instructions');
  assert.equal(result.mcp.local.cwd, path.join(root, '.alp', 'agents', 'main'));
  assert.equal(result.mcp.remote.http_headers.Accept, 'application/json');
  // Paseo picks a profile, never a model or effort: those come from settings or the profile.
  const custom = await mapSession({ ...config(root), model: 'codex:explicit-model', thinkingOption: 'low', mode: 'workspace-write', providerOptions: { agent: 'custom' } });
  assert.equal(custom.agent.name, 'custom'); assert.equal(custom.model, 'configured-model'); assert.equal(custom.thinking, 'high'); assert.equal(custom.mode, 'workspace-write');
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ runtime: { provider: 'claude', model: 'opus', reasoning: 'high' } }));
  const claude = await mapSession(config(root));
  assert.equal(claude.runtimeKind, 'claude'); assert.equal(claude.model, 'opus');
  await writeFile(path.join(root, '.alp', 'settings.json'), '{}');
  const profile = await mapSession({ ...config(root), model: 'cafe', thinkingOption: 'low' });
  assert.deepEqual([profile.runtimeKind, profile.model, profile.thinking, profile.mode, profile.workflow.mode], ['claude', 'claude-opus-5-5', 'high', 'full-access', 'cafe']);
  for (const change of [{ cwd: '.' }, { mode: 'danger-full-access' }, { providerOptions: { unknown: true } }, { settings: { x: true } }, { mcpServers: { local: { type: 'stdio', command: 'node' } } }, { mcpServers: { remote2: { type: 'sse', url: 'https://example.test' } } }]) await assert.rejects(mapSession({ ...config(root), ...change }));
});
test('lifecycle: open, prompt, steering, cancellation, persistence/reload preserve project files', async t => {
  const root = await fixture(t);
  const { conn, events, runtimes, environments } = await connection(t, root);
  assert.deepEqual(environments[0], { PATH: 'baseline', ALP_TEST: 'session' });
  const start = runtimes[0].calls[0]; assert.equal(start.method, 'thread/start');
  assert.equal(start.params.approvalPolicy, 'never'); assert.equal(start.params.sandbox, 'full-access');
  assert.equal(start.params.model, 'claude-opus-5-5'); assert.equal(start.params.thinking, 'high');
  assert.match(start.params.developerInstructions, /Project instructions[\s\S]*Agent main/);
  await conn.send(prompt('m1')); await conn.send(prompt('m1'));
  assert.equal(events.filter(e => e.type === 'session.prompt_result' && e.clientMessageId === 'm1').length, 1);
  assert.equal(runtimes[0].calls.filter(c => c.method === 'turn/start').length, 1);
  await conn.send(prompt('m2', 'steer'));
  assert.equal(events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === 'm2').result.type, 'steer');
  await conn.send({ type: 'session.interrupt', sessionId: 's', requestId: 'stop' });
  assert.equal(events.filter(e => e.type === 'session.turn' && e.state === 'canceled').length, 1);
  const persistence = events.find(e => e.type === 'session.opened').persistence;
  // Paseo stores only a pointer to the alpd session, which owns the native thread.
  assert.equal(persistence.version, 2);
  assert.deepEqual(persistence.data, { alpdSessionId: 's', agent: 'main', cwd: root });
  await conn.send({ type: 'session.close', sessionId: 's', requestId: 'close' });
  console.log('DBG', runtimes.map(r => [r.closed, r.calls.map(c => c.method + ':' + (c.params?.developerInstructions ?? '').slice(0, 60))]));
  assert.equal(runtimes[0].closed, true);
  await writeFile(path.join(root, 'ALP.md'), 'Updated project');
  await conn.send({ type: 'session.open', sessionId: 's', requestId: 'resume', config: config(root), persistence, history: 'replay' });
  assert.equal(runtimes[1].calls[0].method, 'thread/resume');
  assert.match(runtimes[1].calls[0].params.developerInstructions, /Updated project/);
  assert.ok(events.some(e => e.type === 'timeline.item' && e.item.id === 'old'));
  assert.equal(await readFile(path.join(root, 'ALP.md'), 'utf8'), 'Updated project');
  assert.equal(await readFile(path.join(root, '.alp', 'agents', 'main', 'AGENT.md'), 'utf8'), 'Agent main');
  await assert.rejects(mapSession({ ...config(root), providerOptions: { agent: 'custom' } }, persistence), /different ALP agent/);
});
test('runtime notifications publish complete snapshots and exactly one terminal event', async t => {
  const root = await fixture(t); const { conn, events, runtimes } = await connection(t, root);
  await conn.send(prompt('m1')); const turnId = events.find(e => e.type === 'session.turn').turnId;
  runtimes[0].notify('item/agentMessage/delta', { threadId: 'native-thread', itemId: 'a', delta: 'Hello' });
  runtimes[0].notify('item/agentMessage/delta', { threadId: 'native-thread', itemId: 'a', delta: ' world' });
  runtimes[0].notify('turn/completed', { threadId: 'native-thread', turn: { id: turnId, status: 'completed' } });
  runtimes[0].notify('turn/completed', { threadId: 'native-thread', turn: { id: turnId, status: 'completed' } });
  assert.equal(events.filter(e => e.type === 'timeline.item' && e.item.id === 'a').at(-1).item.text, 'Hello world');
  assert.equal(events.filter(e => e.type === 'session.turn' && e.state === 'completed').length, 1);
  await conn.send(prompt('m2', 'steer'));
  assert.equal(events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === 'm2').result.type, 'failed');
});
test('early completion is buffered until turn acknowledgement; failed opens release runtime', async t => {
  const root = await fixture(t);
  const runtime = fakeRuntime(); const original = runtime.request.bind(runtime);
  runtime.request = async (method, params) => {
    const result = await original(method, params);
    if (method === 'turn/start') runtime.notify('turn/completed', { threadId: 'native-thread', turn: { id: result.turn.id, status: 'completed' } });
    return result;
  };
  const conn = await createProvider({ transport: () => runtime }).connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  t.after(() => conn.close()); const events = []; conn.onEvent(e => events.push(e));
  await conn.send({ type: 'session.open', sessionId: 's', requestId: 'o', config: config(root), history: 'skip' });
  await conn.send(prompt('m1'));
  assert.deepEqual(events.filter(e => e.type === 'session.turn').map(e => e.state), ['started', 'completed']);
  await conn.send({ type: 'session.close', sessionId: 's', requestId: 'c' });
  runtime.initialize = async () => { throw new Error('auth unavailable'); };
  await conn.send({ type: 'session.open', sessionId: 's', requestId: 'bad', config: config(root), history: 'skip' });
  assert.ok(events.some(e => e.type === 'request.failed' && e.requestId === 'bad'));
  assert.equal(runtime.closed, true);
});

test('session permissions can change while idle and apply to the next Codex turn', async t => {
  const root = await fixture(t);
  const { conn, events, runtimes } = await connection(t, root);
  await conn.send({ type: 'session.configure', requestId: 'mode', sessionId: 's', changes: { mode: 'workspace-write' } });
  assert.ok(events.some(e => e.type === 'request.completed' && e.requestId === 'mode'), JSON.stringify(events));
  assert.ok(events.some(e => e.type === 'session.config' && e.config?.mode === 'workspace-write'));
  await conn.send(prompt('write'));
  const params = runtimes[0].calls.find(c => c.method === 'turn/start').params;
  assert.equal(params.sandboxPolicy.type, 'workspaceWrite');
  await conn.send({ type: 'session.configure', requestId: 'busy', sessionId: 's', changes: { mode: 'read-only' } });
  assert.ok(events.some(e => e.type === 'request.failed' && e.requestId === 'busy'));
});

test('invalid permission changes leave the session mode unchanged', async t => {
  const root = await fixture(t);
  const { conn, events, runtimes } = await connection(t, root);
  for (const [requestId, changes] of [['invalid', { mode: 'danger-full-access' }], ['model', { model: 'cafe' }], ['workflow', { settings: { workflow: 'cafe' } }], ['thinking', { thinkingOption: 'low' }]]) {
    await conn.send({ type: 'session.configure', sessionId: 's', requestId, changes });
    assert.ok(events.some(e => e.type === 'request.failed' && e.requestId === requestId));
  }
  assert.match(events.find(e => e.type === 'request.failed' && e.requestId === 'model').error.message, /team is fixed/);
  await conn.send(prompt('still-full-access'));
  assert.equal(runtimes[0].calls.find(c => c.method === 'turn/start').params.sandboxPolicy.type, 'dangerFullAccess');
});

test('Claude permission changes reach the runtime and failed changes are not published', async t => {
  const root = await fixture(t);
  const runtime = fakeRuntime();
  const conn = await createProvider({ transport: () => runtime }).connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  t.after(() => conn.close());
  const events = []; conn.onEvent(e => { ProviderEventSchema.parse(e); events.push(e); });
  await conn.send({ type: 'session.open', requestId: 'open', sessionId: 's', config: { ...config(root), model: 'claude:sonnet' }, history: 'skip' });
  await conn.send({ type: 'session.configure', requestId: 'write', sessionId: 's', changes: { mode: 'workspace-write' } });
  assert.deepEqual(runtime.calls.at(-1), { method: 'session/configure', params: { sandbox: 'workspace-write' } });
  runtime.request = async () => { throw new Error('Mode update failed'); };
  await conn.send({ type: 'session.configure', requestId: 'failed', sessionId: 's', changes: { mode: 'read-only' } });
  assert.ok(events.some(e => e.type === 'request.failed' && e.requestId === 'failed'));
  assert.equal(events.filter(e => e.type === 'session.config').at(-1).config.mode, 'workspace-write');
});

test('a 0.2 handle is adopted by alpd and upgraded to a version 2 handle', async t => {
  const root = await fixture(t);
  const { conn, events, runtimes } = await connection(t, root);
  const legacy = { version: 1, data: { threadId: 'native-thread', agent: 'main', cwd: root, runtime: 'codex', model: 'gpt-5.6-sol', workflow: { mode: 'custom', maxPeers: 2 } } };
  await conn.send({ type: 'session.open', requestId: 'legacy', sessionId: 'old-agent', config: config(root), persistence: legacy, history: 'replay' });
  assert.equal(runtimes[1].calls[0].method, 'thread/resume');
  assert.equal(runtimes[1].calls[0].params.threadId, 'native-thread');
  const opened = events.find(e => e.type === 'session.opened' && e.sessionId === 'old-agent');
  assert.deepEqual(opened.persistence, { version: 2, data: { alpdSessionId: 'old-agent', agent: 'main', cwd: root } });
});

test('Paseo lists alpd roots for import and reopens one under its own id', async t => {
  const root = await fixture(t);
  const { conn, events, runtimes } = await connection(t, root);
  await conn.send(prompt('m1'));
  runtimes[0].notify('turn/completed', { threadId: 'native-thread', turn: { id: events.find(e => e.type === 'session.turn').turnId, status: 'completed' } });
  await conn.send({ type: 'session.close', sessionId: 's', requestId: 'close' });
  await conn.send({ type: 'sessions', requestId: 'list', cwd: root });
  const listed = events.find(e => e.type === 'sessions');
  assert.equal(listed.sessions.length, 1);
  assert.deepEqual(listed.sessions[0].persistence, { version: 2, data: { alpdSessionId: 's', agent: 'main', cwd: root } });
  assert.equal(listed.sessions[0].title, 'main: Hello');
  // Paseo imports under a new agent id; the plugin maps it to the alpd session.
  await conn.send({ type: 'session.open', requestId: 'import', sessionId: 'imported', config: config(root), persistence: listed.sessions[0].persistence, history: 'replay' });
  assert.equal(runtimes[1].calls[0].method, 'thread/resume');
  assert.ok(events.some(e => e.type === 'session.ready' && e.sessionId === 'imported' && e.requestId === 'import'));
  await conn.send({ type: 'session.prompt', sessionId: 'imported', prompt: { clientMessageId: 'm2', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'Again' }] } } });
  assert.equal(events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === 'm2').sessionId, 'imported');
  const missing = { version: 2, data: { alpdSessionId: 'gone', agent: 'main', cwd: root } };
  await conn.send({ type: 'session.open', requestId: 'gone', sessionId: 'x', config: config(root), persistence: missing, history: 'skip' });
  assert.match(events.find(e => e.type === 'request.failed' && e.requestId === 'gone').error.message, /no longer exists/);
});

test('a team session shows its team, and main starts its supervisor as a child on Sonnet 5', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-paseo-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimes = [];
  const conn = await createProvider({ transport: () => { const r = fakeRuntime(); r.onRequest = fn => { r.serverRequest = fn; }; runtimes.push(r); return r; } }).connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  t.after(() => conn.close());
  const events = []; conn.onEvent(e => { ProviderEventSchema.parse(e); events.push(e); });
  await conn.send({ type: 'session.open', requestId: 'open', sessionId: 's', config: { ...config(root), model: 'cafe' }, history: 'skip' });
  assert.ok(events.some(e => e.type === 'session.ready' && e.sessionId === 's'), JSON.stringify(events));
  const rootConfig = events.find(e => e.type === 'session.config' && e.sessionId === 's').config;
  assert.equal(rootConfig.model, 'cafe');
  // The team is fixed for the session, so its config offers only that team; the catalog lists every team.
  assert.deepEqual(rootConfig.models.map(model => model.label), ['Cafe']);
  assert.deepEqual(rootConfig.settings, []);
  for (let i = 0; i < 100 && !events.some(e => e.type === 'session.ready' && e.sessionId !== 's'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const child = events.find(e => e.type === 'session.opened' && e.sessionId !== 's');
  assert.equal(child.parentSessionId, 's');
  assert.equal(child.title, 'ALP supervisor (claude)');
  const childConfig = events.find(e => e.type === 'session.config' && e.sessionId === child.sessionId).config;
  assert.equal(childConfig.model, 'claude:claude-sonnet-5');
  assert.equal(childConfig.mode, 'read-only');
  const start = runtimes[1].calls.find(c => c.method === 'thread/start').params;
  assert.deepEqual(start.dynamicTools.map(tool => tool.name), ['alp_send', 'alp_board', 'alp_task']);
  assert.match(start.developerInstructions, /Supervisor — process reviewer for main/);
  assert.ok(runtimes[0].calls.find(c => c.method === 'thread/start').params.dynamicTools.some(tool => tool.name === 'alp_lesson'));
});

test('tasks main worked on appear in Paseo as a todo list when its turn ends', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, '.alp'), { recursive: true });
  const task = await createTask(root, { title: 'Add --json' }, 'user');
  const { conn, events, runtimes } = await connection(t, root);
  await conn.send(prompt('m1'));
  const turnId = events.find(e => e.type === 'session.turn').turnId;
  const started = JSON.parse((await runtimes[0].serverRequest('item/tool/call', { threadId: 'native-thread', turnId, callId: 'c1', namespace: null, tool: 'alp_task', arguments: { action: 'start', id: task.id } })).contentItems[0].text);
  assert.equal(started.task.status, 'in_progress');
  runtimes[0].notify('turn/completed', { threadId: 'native-thread', turn: { id: turnId, status: 'completed' } });
  for (let i = 0; i < 100 && !events.some(e => e.type === 'timeline.item' && e.item.type === 'todo'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const todo = events.find(e => e.type === 'timeline.item' && e.item.type === 'todo');
  assert.deepEqual(todo.item.items, [{ id: task.id, text: `${task.id} · Add --json`, status: 'in_progress', completed: false }]);
});

test('the plugin loads where import.meta.url is no URL, as when Paseo bundles it', async t => {
  const { build } = await import('esbuild');
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-paseo-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, 'index.mjs');
  // Paseo re-bundles plugin code; there import.meta.url does not resolve. Nothing may need it while loading.
  await build({ entryPoints: ['plugins/paseo/server/dist/index.js'], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20', external: ['@anthropic-ai/claude-agent-sdk'], define: { 'import.meta.url': 'undefined' }, logLevel: 'silent' });
  const plugin = await import(outfile);
  assert.equal(typeof plugin.default, 'function');
  assert.equal(typeof plugin.createProvider, 'function');
});
