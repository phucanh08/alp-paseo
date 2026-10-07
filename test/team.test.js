import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { createProvider } from '../plugins/paseo/server/dist/index.js';
import { PROVIDER_CAPABILITIES, ProviderEventSchema } from '@getpaseo/plugin/server/provider';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected event did not arrive');
}
async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-team-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const runtimes = [];
  const provider = createProvider({ delegationTimeoutMs: options.timeout ?? 2000, transport: () => {
    const index = runtimes.length;
    const runtime = {
      calls: [], closed: false, threadId: `thread-${index}`, turnId: `turn-${index}`, notifications: [],
      async initialize() { if (index > 0 && options.childGate) await options.childGate; },
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') return { turn: { id: this.turnId } };
        return {};
      },
      tool(agent, task = 'Return evidence for assigned read-only scope.', extra = {}, callId = `call-${index}`) {
        return this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId, namespace: null, tool: 'alp_delegate', arguments: { agent, task, ...extra } });
      },
      finish(text = 'Evidence complete', status = 'completed') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `output-${index}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status } });
      },
    };
    runtimes.push(runtime); return runtime;
  } });
  const connection = await provider.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  t.after(() => connection.close());
  const events = [];
  connection.onEvent(event => { ProviderEventSchema.parse(event); events.push(event); });
  const config = { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: true, mode: options.mode ?? 'read-only' };
  await connection.send({ type: 'session.open', requestId: 'open', sessionId: 'root', history: 'skip', config });
  assert.ok(events.some(e => e.type === 'session.ready'), JSON.stringify(events));
  await connection.send({ type: 'session.prompt', sessionId: 'root', prompt: { clientMessageId: 'first', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'Delegate' }] } } });
  return { root, connection, events, runtimes };
}
const decode = result => JSON.parse(result.contentItems[0].text);

test('real provider boundary routes main -> lead -> peer, isolates instructions and returns evidence', async t => {
  const { runtimes, events } = await setup(t);
  const leadResult = runtimes[0].tool('lead');
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  const peerResult = runtimes[1].tool('peer');
  await until(() => runtimes[2]?.calls.some(c => c.method === 'turn/start'));
  const peerConfig = runtimes[2].calls.find(c => c.method === 'thread/start').params;
  assert.deepEqual(peerConfig.dynamicTools, []);
  assert.match(peerConfig.developerInstructions, /Peer — independent bounded contributor/);
  assert.doesNotMatch(peerConfig.developerInstructions, /# Main —/);
  assert.equal(peerConfig.sandbox, 'read-only');
  assert.equal(peerConfig.approvalPolicy, 'never');
  runtimes[2].finish('peer proof');
  assert.equal(decode(await peerResult).output, 'peer proof');
  assert.equal(runtimes[2].closed, true);
  runtimes[1].finish('ACCEPT peer proof');
  assert.equal(decode(await leadResult).output, 'ACCEPT peer proof');
  assert.equal(runtimes[1].closed, true);
  assert.equal(runtimes[0].closed, false);
  const opened = events.filter(e => e.type === 'session.opened');
  assert.equal(opened[1].parentSessionId, 'root');
  assert.equal(opened[2].parentSessionId, opened[1].sessionId);
  assert.equal(opened[1].restoration, 'parent');
});

test('role identity, target, mode and arguments are enforced by the host', async t => {
  const { runtimes } = await setup(t);
  for (const [target, extra] of [['peer', {}], ['lead', { mode: 'workspace-write' }], ['lead', { from: 'main' }], ['../lead', {}]]) {
    assert.equal((await runtimes[0].tool(target, 'task', extra, JSON.stringify(extra) + target)).success, false);
  }
  assert.equal(runtimes.length, 1);
  const result = runtimes[0].tool('lead');
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  assert.equal((await runtimes[1].tool('main')).success, false);
  assert.equal((await runtimes[0].tool('lead', 'parallel', {}, 'parallel')).success, false);
  runtimes[1].finish(); await result;
});

test('duplicate tool calls do not create duplicate children', async t => {
  const { runtimes } = await setup(t);
  const first = runtimes[0].tool('lead');
  const duplicate = runtimes[0].tool('lead');
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  runtimes[1].finish();
  assert.deepEqual(await duplicate, await first);
  assert.equal(runtimes.length, 2);
});

test('parent interruption cancels the whole live tree and returns failed handoffs', async t => {
  const { runtimes, connection, events } = await setup(t);
  const lead = runtimes[0].tool('lead');
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  const peer = runtimes[1].tool('peer');
  await until(() => runtimes[2]?.calls.some(c => c.method === 'turn/start'));
  await connection.send({ type: 'session.interrupt', sessionId: 'root', requestId: 'stop' });
  assert.equal((await peer).success, false);
  assert.equal((await lead).success, false);
  assert.ok(runtimes.slice(1).every(r => r.closed));
  assert.equal(events.filter(e => e.type === 'session.turn' && e.sessionId === 'root' && e.state === 'canceled').length, 1);
});

test('timeout and child runtime failure return errors and release owned processes', async t => {
  const { runtimes } = await setup(t, { timeout: 30 });
  const timed = await runtimes[0].tool('lead');
  assert.equal(timed.success, false);
  assert.match(decode(timed).error, /timed out/);
  assert.equal(runtimes[1].closed, true);
  const failed = runtimes[0].tool('lead', 'task', {}, 'retry');
  await until(() => runtimes[2]?.calls.some(c => c.method === 'turn/start'));
  runtimes[2].failure(new Error('runtime crashed'));
  assert.equal((await failed).success, false);
  await tick();
  assert.equal(runtimes[2].closed, true);
});

test('missing target and malformed graph fail without silently switching agents', async t => {
  const { root, runtimes, connection, events } = await setup(t);
  await rm(path.join(root, '.alp/agents/lead'), { recursive: true });
  const failed = await runtimes[0].tool('lead');
  assert.equal(failed.success, false);
  assert.match(decode(failed).error, /not found/);
  assert.equal(runtimes.length, 1);
  await writeFile(path.join(root, '.alp/settings.json'), '{"delegation":{"main":["main"]}}');
  await connection.send({ type: 'session.open', requestId: 'bad', sessionId: 'bad', history: 'skip', config: { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: false } });
  assert.match(events.find(e => e.type === 'request.failed' && e.requestId === 'bad').error.message, /cycle/);
});

test('workspace-write parent can delegate read-only work without elevating descendants', async t => {
  const { runtimes } = await setup(t, { mode: 'workspace-write' });
  const lead = runtimes[0].tool('lead', 'Review only', { mode: 'read-only' });
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  assert.equal(runtimes[1].calls[0].params.sandbox, 'read-only');
  assert.equal((await runtimes[1].tool('peer', 'write', { mode: 'workspace-write' })).success, false);
  runtimes[1].finish(); await lead;
});

test('steering cancels descendants before the changed brief reaches the parent', async t => {
  const { runtimes, connection } = await setup(t);
  const lead = runtimes[0].tool('lead');
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  await connection.send({ type: 'session.prompt', sessionId: 'root', prompt: { clientMessageId: 'steer', delivery: 'steer', input: { type: 'message', content: [{ type: 'text', text: 'Change the assignment' }] } } });
  assert.equal((await lead).success, false);
  assert.equal(runtimes[1].closed, true);
  assert.ok(runtimes[0].calls.some(c => c.method === 'turn/steer'));
});

test('closing parent while child initializes prevents an orphan runtime', async t => {
  let release;
  const childGate = new Promise(resolve => { release = resolve; });
  const { runtimes, connection, events } = await setup(t, { childGate });
  const lead = runtimes[0].tool('lead');
  await until(() => runtimes.length === 2);
  await connection.send({ type: 'session.close', sessionId: 'root', requestId: 'close' });
  release();
  assert.equal((await lead).success, false);
  assert.ok(runtimes.every(r => r.closed));
  assert.equal(events.filter(e => e.type === 'session.opened').length, 1);
  assert.equal(events.filter(e => e.type === 'session.closed' && e.sessionId === 'root').length, 1);
});

test('a root turn has a bounded total number of child assignments', async t => {
  const { runtimes } = await setup(t);
  for (let i = 1; i <= 16; i++) {
    const result = runtimes[0].tool('lead', 'task', {}, `bounded-${i}`);
    await until(() => runtimes[i]?.calls.some(c => c.method === 'turn/start'));
    runtimes[i].finish(); assert.equal((await result).success, true);
  }
  assert.match(decode(await runtimes[0].tool('lead', 'task', {}, 'excess')).error, /limit reached/);
  assert.equal(runtimes.length, 17);
});
