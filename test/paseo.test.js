import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProvider, mapSession, default as contribute } from '../plugins/paseo/server/dist/index.js';
import { ProviderEventSchema, PROVIDER_CAPABILITIES } from '@getpaseo/plugin/server/provider';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-paseo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['main', 'custom']) {
    const dir = path.join(root, '.alp', 'agents', name);
    await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'AGENT.md'), `Agent ${name}`);
  }
  await writeFile(path.join(root, 'ALP.md'), 'Project instructions');
  return root;
}
const config = cwd => ({ cwd, env: { ALP_TEST: 'session' }, systemPrompt: 'Host instructions', mcpServers: {}, settings: {}, persist: true });
function fakeRuntime() {
  let notification;
  return {
    calls: [], closed: false, fail: undefined,
    initialize: async () => {},
    onNotification(fn) { notification = fn; }, onFailure(fn) { this.fail = fn; },
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

test('plugin registers ALP with public SDK contract', async () => {
  let registration; contribute({ registerProvider(p) { registration = p; } });
  assert.equal(registration.id, 'alp');
  await assert.rejects(registration.connect({ versions: [99], capabilities: [] }), /protocol/);
  const conn = await registration.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  const events = []; conn.onEvent(e => events.push(e));
  await conn.send({ type: 'catalog', requestId: 'catalog' });
  assert.equal(events[0].catalog.defaultModel, 'codex:gpt-5.6-sol');
  assert.ok(events[0].catalog.models.some(model => model.id === 'claude:sonnet'));
  assert.equal(events[0].catalog.models.filter(model => model.id.startsWith('codex:')).length, 7);
  assert.equal(events[0].catalog.models.filter(model => model.id.startsWith('claude:')).length, 17);
  assert.ok(events[0].catalog.models.find(model => model.id === 'codex:gpt-6.1-sol').thinkingOptions.some(option => option.id === 'ultra'));
  assert.ok(events[0].catalog.models.find(model => model.id === 'claude:claude-opus-5-5').thinkingOptions.some(option => option.id === 'ultracode'));
  assert.equal(conn.capabilities.includes('permission'), false);
  await conn.close();
});
test('opening the first session in an empty repository installs the ALP starter', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-paseo-new-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await mapSession(config(root));
  assert.equal(result.agent.name, 'main');
  assert.match(result.instructions, /ALP/);
  assert.equal(JSON.parse(await readFile(path.join(root, '.alp', 'settings.json'), 'utf8')).defaultAgent, 'main');
  for (const name of ['main', 'lead', 'peer']) {
    assert.match(await readFile(path.join(root, '.alp', 'agents', name, 'AGENT.md'), 'utf8'), new RegExp(name, 'i'));
  }
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
  assert.ok((await readFile(path.join(root, '.alp', 'agents', 'main', 'AGENT.md'), 'utf8')).length > 0);
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
  const custom = await mapSession({ ...config(root), model: 'explicit-model', thinkingOption: 'low', mode: 'workspace-write', providerOptions: { agent: 'custom' } });
  assert.equal(custom.agent.name, 'custom'); assert.equal(custom.model, 'explicit-model'); assert.equal(custom.thinking, 'low'); assert.equal(custom.mode, 'workspace-write');
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ runtime: { provider: 'claude', model: 'opus', reasoning: 'high' } }));
  const claude = await mapSession(config(root));
  assert.equal(claude.runtimeKind, 'claude'); assert.equal(claude.model, 'opus');
  const selected = await mapSession({ ...config(root), model: 'codex:gpt-5.6-sol' });
  assert.equal(selected.runtimeKind, 'codex'); assert.equal(selected.model, 'gpt-5.6-sol');
  const newestCodex = await mapSession({ ...config(root), model: 'codex:gpt-6.1-sol', thinkingOption: 'ultra' });
  assert.equal(newestCodex.runtimeKind, 'codex'); assert.equal(newestCodex.thinking, 'ultra');
  const newestClaude = await mapSession({ ...config(root), model: 'claude:claude-opus-5-5', thinkingOption: 'ultracode' });
  assert.equal(newestClaude.runtimeKind, 'claude'); assert.equal(newestClaude.thinking, 'ultracode');
  for (const change of [{ cwd: '.' }, { mode: 'danger-full-access' }, { thinkingOption: 'invalid' }, { providerOptions: { unknown: true } }, { settings: { x: true } }, { mcpServers: { local: { type: 'stdio', command: 'node' } } }, { mcpServers: { remote2: { type: 'sse', url: 'https://example.test' } } }]) await assert.rejects(mapSession({ ...config(root), ...change }));
});
test('lifecycle: open, prompt, steering, cancellation, persistence/reload preserve project files', async t => {
  const root = await fixture(t);
  const { conn, events, runtimes, environments } = await connection(t, root);
  assert.deepEqual(environments[0], { PATH: 'baseline', ALP_TEST: 'session' });
  const start = runtimes[0].calls[0]; assert.equal(start.method, 'thread/start');
  assert.equal(start.params.approvalPolicy, 'never'); assert.equal(start.params.sandbox, 'read-only');
  assert.match(start.params.developerInstructions, /Project instructions[\s\S]*Agent main/);
  await conn.send(prompt('m1')); await conn.send(prompt('m1'));
  assert.equal(events.filter(e => e.type === 'session.prompt_result' && e.clientMessageId === 'm1').length, 1);
  assert.equal(runtimes[0].calls.filter(c => c.method === 'turn/start').length, 1);
  await conn.send(prompt('m2', 'steer'));
  assert.equal(events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === 'm2').result.type, 'steer');
  await conn.send({ type: 'session.interrupt', sessionId: 's', requestId: 'stop' });
  assert.equal(events.filter(e => e.type === 'session.turn' && e.state === 'canceled').length, 1);
  const persistence = events.find(e => e.type === 'session.opened').persistence;
  assert.deepEqual(Object.keys(persistence.data).sort(), ['agent', 'cwd', 'model', 'runtime', 'threadId']);
  await conn.send({ type: 'session.close', sessionId: 's', requestId: 'close' });
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
