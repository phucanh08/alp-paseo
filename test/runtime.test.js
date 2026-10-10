import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { claudeToolShapes, createAlpRuntime } from '../dist/runtime/index.js';

async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected event did not arrive');
}

function fakeTransport(runtimes) {
  return () => {
    const index = runtimes.length;
    const runtime = {
      calls: [], closed: false, threadId: `thread-${index}`, turnId: `turn-${index}`,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') return { turn: { id: this.turnId } };
        return {};
      },
      call(tool, args, callId = `${tool}-${index}`) {
        return this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId, namespace: null, tool, arguments: args });
      },
      finish(text = 'done', status = 'completed') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `output-${index}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'], lead: ['peer'] } }));
  const runtimes = [];
  const runtime = createAlpRuntime({ silentForMs: 2000, transport: fakeTransport(runtimes) });
  t.after(() => runtime.shutdown());
  const envelopes = [];
  runtime.onEvent(envelope => envelopes.push(envelope));
  const of = (sessionId, type) => envelopes.filter(e => e.sessionId === sessionId && (!type || e.event.type === type)).map(e => e.event);
  return { root, runtime, runtimes, envelopes, of };
}

const prompt = (clientMessageId, text) => ({ clientMessageId, delivery: 'auto', content: [{ type: 'text', text }] });
const decode = result => JSON.parse(result.contentItems[0].text);

test('runtime sources never import a viewer SDK or the plugin', async () => {
  const directory = new URL('../src/runtime/', import.meta.url);
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.ts')) continue;
    const source = await readFile(new URL(file, directory), 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
      const target = match[1];
      assert.ok(target.startsWith('node:') || /^\.\/[^/]+$/.test(target) || /^\.\.\/core\/[^/]+$/.test(target) || target === 'zod' || target === 'smol-toml', `${file} imports ${target}`);
    }
  }
});

test('a root session opens, prompts and ends a turn with ordered events', async t => {
  const { root, runtime, runtimes, envelopes, of } = await setup(t);
  const opened = await runtime.open('root', { cwd: root, persist: true, mode: 'read-only' });
  assert.equal(opened.agent, 'main');
  assert.equal(opened.persistent, true);
  assert.equal(opened.threadId, 'thread-0');
  await runtime.prompt('root', prompt('first', 'Hello'));
  runtimes[0].finish('Hi');
  assert.deepEqual(of('root').map(event => event.type), ['session.opened', 'session.ready', 'item', 'prompt.accepted', 'turn.started', 'item', 'turn.ended']);
  assert.deepEqual(of('root', 'turn.started')[0], { type: 'turn.started', turnId: 'turn-0', origin: 'user' });
  assert.deepEqual(of('root', 'item').map(event => event.item.kind), ['user_message', 'assistant_message']);
  const sequence = envelopes.filter(e => e.sessionId === 'root').map(e => e.seq);
  assert.deepEqual(sequence, sequence.map((_, i) => i + 1));
  assert.equal(new Set(envelopes.map(e => e.epoch)).size, 1);
});

test('delegation opens children inside the runtime and reports assignments and mail', async t => {
  const { root, runtime, runtimes, of } = await setup(t);
  await runtime.open('root', { cwd: root, persist: true });
  await runtime.prompt('root', prompt('first', 'Delegate'));
  const lead = runtimes[0].call('alp_delegate', { agent: 'lead', wait: true, task: 'Investigate' });
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  const [childOpened] = of('root', 'assignment');
  const childId = childOpened.assignment.id;
  const child = of(childId, 'session.opened')[0].session;
  assert.equal(child.parentId, 'root');
  assert.equal(child.toolCallId, 'alp_delegate-0');
  assert.equal(child.agent, 'lead');
  assert.equal(child.persistent, false);
  assert.equal(runtime.snapshot(childId).parentId, 'root');
  assert.equal(of(childId, 'turn.started')[0].origin, 'assignment');
  assert.equal((await runtimes[1].call('alp_handoff', { outcome: 'complete', summary: 'Found it' })).success, true);
  runtimes[1].finish('lead proof');
  const result = decode(await lead);
  assert.equal(result.handoff.summary, 'Found it');
  assert.deepEqual(of('root', 'assignment').map(event => event.assignment.status), ['running', 'completed']);
  assert.equal(of('root', 'mail')[0].mail.kind, 'result');
  assert.equal(of(childId, 'session.closed').length, 1);
  assert.equal(runtime.snapshot(childId), undefined);
});

test('mail to an idle requester starts a wake turn', async t => {
  const { root, runtime, runtimes, of } = await setup(t);
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', prompt('first', 'Delegate'));
  assert.equal(decode(await runtimes[0].call('alp_delegate', { agent: 'lead', task: 'Work', wait: false })).status, 'running');
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  runtimes[0].finish('waiting');
  runtimes[0].turnId = 'turn-wake';
  runtimes[1].finish('lead proof');
  await until(() => of('root', 'turn.started').length === 2);
  assert.equal(of('root', 'turn.started')[1].origin, 'wake');
  assert.match(of('root', 'item').at(-1).item.text, /result from lead/);
});

test('interrupt closes the subtree and a failed prompt is reported once', async t => {
  const { root, runtime, runtimes, of } = await setup(t);
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', prompt('first', 'Delegate'));
  const lead = runtimes[0].call('alp_delegate', { agent: 'lead', wait: true, task: 'Work' });
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  const childId = of('root', 'assignment')[0].assignment.id;
  await runtime.interrupt('root');
  assert.equal((await lead).success, false);
  assert.equal(of(childId, 'session.closed').length, 1);
  assert.equal(runtimes[1].closed, true);
  assert.deepEqual(of('root', 'turn.ended').map(event => event.state), ['canceled']);
  await runtime.prompt('root', { clientMessageId: 'image', delivery: 'auto', content: [{ type: 'image' }] });
  await runtime.prompt('root', { clientMessageId: 'image', delivery: 'auto', content: [{ type: 'image' }] });
  assert.deepEqual(of('root', 'prompt.failed'), [{ type: 'prompt.failed', clientMessageId: 'image', error: { message: 'Only text prompts are supported' } }]);
  await assert.rejects(runtime.configure('missing', {}), /Session is not open/);
});

test('every ALP tool the runtime offers has a Claude tool schema with the same properties', async t => {
  const { root, runtime, runtimes } = await setup(t);
  await runtime.open('root', { cwd: root, mode: 'read-only' });
  await runtime.prompt('root', prompt('first', 'Delegate'));
  void runtimes[0].call('alp_delegate', { agent: 'lead', wait: true, task: 'Work' });
  await until(() => runtimes[1]?.calls.some(call => call.method === 'thread/start'));
  const offered = new Map();
  for (const harness of runtimes) {
    for (const tool of harness.calls.find(call => call.method === 'thread/start').params.dynamicTools) offered.set(tool.name, Object.keys(tool.inputSchema.properties).sort());
  }
  assert.deepEqual([...offered.keys()].sort(), ['alp_ask', 'alp_board', 'alp_cancel', 'alp_delegate', 'alp_discard', 'alp_handoff', 'alp_issue', 'alp_merge', 'alp_pin', 'alp_recall', 'alp_send', 'alp_task', 'alp_unpin', 'alp_verify', 'alp_wait']);
  for (const [name, properties] of offered) {
    assert.ok(claudeToolShapes[name], `${name} has no Claude schema`);
    const shape = Object.keys(claudeToolShapes[name]).sort();
    // alp_task and alp_delegate offer each role a subset of their fields; the Claude transport narrows the shape to match.
    if (name === 'alp_task' || name === 'alp_delegate') assert.ok(properties.every(property => shape.includes(property)), `${name} has a field Claude lacks`);
    else assert.deepEqual(shape, properties, `${name} properties differ for Claude`);
  }
});
