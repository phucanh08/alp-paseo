import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  // The runtime's watchdog is unref'd; keep the loop alive while a test waits on it (Node 22 cancels otherwise).
  const alive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(alive));
  const root = await mkdtemp(path.join(tmpdir(), 'alp-team-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify(options.workflow ? { workflow: { mode: options.workflow, maxPeers: options.maxPeers ?? 2 } } : { delegation: { main: ['lead'], lead: ['peer'] } }));
  const runtimes = [];
  const provider = createProvider({ silentForMs: options.timeout ?? 2000, askTimeoutMs: options.askTimeout, runLogDir: options.runLogDir, transport: () => {
    const index = runtimes.length;
    const runtime = {
      calls: [], closed: false, threadId: `thread-${index}`, turnId: `turn-${index}`, notifications: [],
      async initialize() { if (index > 0 && options.childGate) await options.childGate; },
      async orchestrationContext() { return { runtime: 'codex', usage: { available: false }, models: [{ id: 'codex:premium-test', description: 'Highest capability' }] }; },
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') return { turn: { id: this.turnId } };
        return {};
      },
      call(tool, args, callId) {
        return this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId, namespace: null, tool, arguments: args });
      },
      tool(agent, task = 'Return evidence for assigned read-only scope.', extra = {}, callId = `call-${index}`) {
        return this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId, namespace: null, tool: 'alp_delegate', arguments: { agent, task, ...extra } });
      },
      handoff(args, callId = `handoff-${index}`) {
        return this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId, namespace: null, tool: 'alp_handoff', arguments: args });
      },
      say(text, id) {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id, text } });
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
  assert.deepEqual(peerConfig.dynamicTools.map(tool => tool.name), ['alp_send', 'alp_handoff', 'alp_ask', 'alp_pin', 'alp_board', 'alp_unpin']);
  assert.match(peerConfig.developerInstructions, /assignment from lead\. You do not talk to the user: lead does, through main\. If a decision is genuinely theirs, ask with alp_ask[\s\S]*Before ending your turn, call alp_handoff/);
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

test('user steering reaches the parent and keeps live assignments running', async t => {
  const { runtimes, connection } = await setup(t);
  const lead = runtimes[0].tool('lead');
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  await connection.send({ type: 'session.prompt', sessionId: 'root', prompt: { clientMessageId: 'steer', delivery: 'steer', input: { type: 'message', content: [{ type: 'text', text: 'Change the assignment' }] } } });
  assert.ok(runtimes[0].calls.some(c => c.method === 'turn/steer'));
  assert.equal(runtimes[1].closed, false);
  runtimes[1].finish('lead still delivered');
  const result = await lead;
  assert.equal(result.success, true);
  assert.equal(decode(result).output, 'lead still delivered');
});

test('interrupting parent while child initializes prevents an orphan runtime', async t => {
  let release;
  const childGate = new Promise(resolve => { release = resolve; });
  const { runtimes, connection, events } = await setup(t, { childGate });
  const lead = runtimes[0].tool('lead');
  await until(() => runtimes.length === 2);
  await connection.send({ type: 'session.interrupt', sessionId: 'root', requestId: 'stop' });
  release();
  assert.equal((await lead).success, false);
  assert.equal(runtimes[1].closed, true);
  assert.equal(runtimes[0].closed, false);
  assert.equal(events.filter(e => e.type === 'session.opened').length, 1);
});

test('closing a working root in Paseo lets its tree finish; alpd closes it once idle', async t => {
  const { runtimes, connection, events } = await setup(t);
  const lead = runtimes[0].tool('lead');
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  await connection.send({ type: 'session.close', sessionId: 'root', requestId: 'close' });
  assert.ok(events.some(e => e.type === 'request.completed' && e.requestId === 'close'));
  assert.equal(runtimes[0].closed, false);
  assert.equal(runtimes[1].closed, false);
  runtimes[1].finish('lead finished without a viewer');
  assert.equal(decode(await lead).output, 'lead finished without a viewer');
  assert.equal(runtimes[0].closed, false);
  runtimes[0].finish('root done');
  await until(() => runtimes[0].closed);
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

test('Smart delegates directly, caps concurrent peers at two, releases slots, and forwards selected model/effort', async t => {
  const { runtimes } = await setup(t, { workflow: 'smart' });
  assert.equal((await runtimes[0].tool('lead')).success, false);
  const first = runtimes[0].tool('peer', 'Inspect A', { model: 'claude:claude-sonnet-5-5', thinking: 'high' }, 'p1');
  const second = runtimes[0].tool('peer', 'Inspect B', {}, 'p2');
  await until(() => runtimes[2]?.calls.some(c => c.method === 'turn/start'));
  assert.match(decode(await runtimes[0].tool('peer', 'Inspect C', {}, 'p3')).error, /peer limit/);
  await until(() => runtimes.slice(1).every(r => r.calls.some(c => c.method === 'turn/start')));
  const selected = runtimes.find(r => r.calls.some(c => c.method === 'thread/start' && c.params.model === 'claude-sonnet-5-5'));
  assert.ok(selected);
  const child = selected.calls.find(c => c.method === 'thread/start').params;
  assert.equal(child.model, 'claude-sonnet-5-5');
  assert.equal(child.thinking, 'high');
  assert.equal(child.runtime, 'claude');
  selected.finish(); await first;
  const third = runtimes[0].tool('peer', 'Inspect C', {}, 'p4');
  await until(() => runtimes[3]?.calls.some(c => c.method === 'turn/start'));
  runtimes.filter(r => r !== runtimes[0] && r !== selected).forEach(r => r.finish());
  assert.equal((await second).success, true); assert.equal((await third).success, true);
});

test('configured peer increase and single writer constraint are enforced', async t => {
  const { runtimes } = await setup(t, { workflow: 'smart', maxPeers: 3, mode: 'workspace-write' });
  const jobs = [0, 1, 2].map(i => runtimes[0].tool('peer', 'Inspect', { mode: 'read-only' }, `read-${i}`));
  await until(() => runtimes[3]?.calls.some(c => c.method === 'turn/start'));
  assert.equal((await runtimes[0].tool('peer', 'Write', {}, 'write')).success, false);
  runtimes.slice(1).forEach(r => r.finish()); await Promise.all(jobs);
  const writer = runtimes[0].tool('peer', 'Write A', {}, 'writer');
  await until(() => runtimes[4]?.calls.some(c => c.method === 'turn/start'));
  assert.equal((await runtimes[0].tool('peer', 'Read B', { mode: 'read-only' }, 'reader')).success, false);
  runtimes[4].finish(); await writer;
});

test('oracle requires explicit premium selection and advisors are forced read-only', async t => {
  const { runtimes } = await setup(t, { workflow: 'smart', mode: 'workspace-write' });
  assert.equal((await runtimes[0].tool('oracle')).success, false);
  assert.equal((await runtimes[0].tool('oracle', 'Advice', { model: 'codex:premium-test', thinking: 'high' }, 'missing-reason')).success, false);
  const advice = runtimes[0].tool('oracle', 'Advice', { model: 'codex:premium-test', thinking: 'high', modelReason: 'Runtime catalog describes highest capability', mode: 'workspace-write' }, 'oracle');
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  const cfg = runtimes[1].calls.find(c => c.method === 'thread/start').params;
  assert.equal(cfg.model, 'premium-test'); assert.equal(cfg.sandbox, 'read-only'); assert.deepEqual(cfg.dynamicTools.map(tool => tool.name), ['alp_send', 'alp_handoff', 'alp_ask', 'alp_pin', 'alp_board', 'alp_unpin']);
  runtimes[1].finish(); await advice;
  const review = runtimes[0].tool('reviewer', 'Review diff', {}, 'review');
  await until(() => runtimes[2]?.calls.some(c => c.method === 'turn/start'));
  assert.equal(runtimes[2].calls.find(c => c.method === 'thread/start').params.sandbox, 'read-only');
  runtimes[2].finish(); await review;
});

test('Supervised keeps peer ownership with lead and snapshots limits for descendants', async t => {
  const { runtimes, root } = await setup(t, { workflow: 'supervised' });
  assert.equal((await runtimes[0].tool('peer')).success, false);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ workflow: { mode: 'smart', maxPeers: 8 } }));
  const lead = runtimes[0].tool('lead', 'Execute', {}, 'lead-after-peer-denied');
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  const cfg = runtimes[1].calls.find(c => c.method === 'thread/start').params;
  assert.match(cfg.developerInstructions, /Workflow: supervised/);
  assert.match(cfg.developerInstructions, /At most 2 peers/);
  assert.deepEqual(cfg.dynamicTools[0].inputSchema.properties.agent.enum, ['peer', 'oracle', 'reviewer']);
  runtimes[1].finish(); await lead;
});

test('usage and catalog evidence reaches orchestration prompt without substituting for the brief', async t => {
  const { runtimes } = await setup(t, { workflow: 'smart' });
  const input = runtimes[0].calls.find(c => c.method === 'turn/start').params.input;
  assert.match(input[0].text, /"available":false/);
  assert.match(input[0].text, /premium-test/);
  assert.equal(input[1].text, 'Delegate');
});

test('interrupt closes both concurrent peers and releases their handoffs', async t => {
  const { runtimes, connection } = await setup(t, { workflow: 'smart' });
  const first = runtimes[0].tool('peer', 'A', {}, 'a');
  const second = runtimes[0].tool('peer', 'B', {}, 'b');
  await until(() => runtimes[2]?.calls.some(c => c.method === 'turn/start'));
  await connection.send({ type: 'session.interrupt', requestId: 'stop', sessionId: 'root' });
  assert.equal((await first).success, false);
  assert.equal((await second).success, false);
  assert.equal(runtimes[1].closed, true);
  assert.equal(runtimes[2].closed, true);
});

test('child files a structured handoff; parent gets it with only the final message', async t => {
  const runLogDir = await mkdtemp(path.join(tmpdir(), 'alp-runs-'));
  t.after(() => rm(runLogDir, { recursive: true, force: true }));
  const { runtimes, root } = await setup(t, { workflow: 'smart', runLogDir });
  const result = runtimes[0].tool('peer', 'Read proof.txt', {}, 'peer-call');
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  const assignment = runtimes[1].calls.find(c => c.method === 'turn/start').params.input[1].text;
  assert.match(assignment, /^Assignment from main\. Finish by filing your handoff for that agent with alp_handoff\./);
  const handoff = { outcome: 'partial', summary: 'Read the file', scope: ['proof.txt'], verification: ['cat proof.txt: PROOF_1'] };
  assert.equal((await runtimes[1].handoff({ ...handoff, outcome: 'done' }, 'bad-outcome')).success, false);
  assert.equal((await runtimes[1].handoff({ ...handoff, extra: true }, 'bad-field')).success, false);
  assert.equal((await runtimes[1].handoff({ ...handoff, risks: [''] }, 'bad-list')).success, false);
  assert.equal((await runtimes[1].handoff({ ...handoff, summary: 'x'.repeat(33_000) }, 'too-long')).success, false);
  const recorded = await runtimes[1].handoff(handoff, 'first');
  assert.equal(recorded.success, true);
  assert.equal(decode(recorded).to, 'main');
  await runtimes[1].handoff({ ...handoff, outcome: 'complete' }, 'replace');
  runtimes[1].say('Reading proof.txt now', 'interim');
  runtimes[1].finish('PROOF_1');
  const value = decode(await result);
  assert.deepEqual(value.handoff, { ...handoff, outcome: 'complete' });
  assert.equal(value.output, 'PROOF_1');
  let lines = [];
  for (let i = 0; i < 200 && lines.length < 2; i++) {
    lines = (await readFile(path.join(runLogDir, 'root.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const [started, finished] = lines;
  assert.equal(started.event, 'assignment.started');
  assert.equal(started.rootSessionId, 'root');
  assert.equal(started.parentAgent, 'main');
  assert.equal(started.agent, 'peer');
  assert.equal(started.project, root);
  assert.equal(started.task, 'Read proof.txt');
  assert.equal(finished.event, 'assignment.finished');
  assert.equal(finished.assignmentId, started.assignmentId);
  assert.equal(finished.status, 'completed');
  assert.deepEqual(finished.handoff, value.handoff);
  assert.equal(finished.output, 'PROOF_1');
});

test('missing handoff is null and root sessions cannot file one', async t => {
  const { runtimes } = await setup(t, { workflow: 'smart' });
  const root = await runtimes[0].handoff({ outcome: 'complete', summary: 'Not an assignment' }, 'root-handoff');
  assert.equal(root.success, false);
  assert.match(decode(root).error, /Only assignment sessions/);
  const result = runtimes[0].tool('peer', 'Answer', {}, 'no-handoff');
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  runtimes[1].finish('plain answer');
  const value = decode(await result);
  assert.equal(value.handoff, null);
  assert.equal(value.output, 'plain answer');
});

const turns = runtime => runtime.calls.filter(c => c.method === 'turn/start');
const started = (runtimes, index) => until(() => runtimes[index]?.calls.some(c => c.method === 'turn/start'));

test('async assignment: alp_wait returns the result and the snapshot of running work', async t => {
  const { runtimes } = await setup(t, { workflow: 'smart' });
  const start = decode(await runtimes[0].tool('peer', 'Read proof', { wait: false }, 'async'));
  assert.equal(start.status, 'running');
  await started(runtimes, 1);
  const quick = decode(await runtimes[0].call('alp_wait', { timeoutMs: 5 }, 'quick'));
  assert.deepEqual(quick.events, []);
  assert.equal(quick.running[0].assignmentId, start.assignmentId);
  assert.equal((await runtimes[0].call('alp_wait', { assignments: ['alp-child-unknown'] }, 'unknown')).success, false);
  const waiting = runtimes[0].call('alp_wait', { assignments: [start.assignmentId] }, 'wait');
  runtimes[1].finish('PROOF');
  const { events, running } = decode(await waiting);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'result');
  assert.equal(events[0].result.output, 'PROOF');
  assert.equal(events[0].result.status, 'completed');
  assert.deepEqual(running, []);
  assert.equal(runtimes[1].closed, true);
});

test('a question returns a waiting delegate early; the answer resumes the child', async t => {
  const { runtimes } = await setup(t, { workflow: 'smart' });
  const delegated = runtimes[0].tool('peer', 'Pick an API', {}, 'sync');
  await started(runtimes, 1);
  const asked = runtimes[1].call('alp_ask', { question: 'v1 or v2?' }, 'ask');
  const early = decode(await delegated);
  assert.equal(early.status, 'running');
  assert.equal(early.events[0].kind, 'question');
  assert.equal(early.events[0].body, 'v1 or v2?');
  const { assignmentId } = early;
  const replyTo = early.events[0].id;
  assert.equal((await runtimes[1].call('alp_ask', { question: 'again?' }, 'ask-twice')).success, false);
  assert.equal((await runtimes[0].call('alp_send', { to: assignmentId, kind: 'answer', replyTo: '#999', body: 'v2' }, 'wrong-reply')).success, false);
  assert.equal((await runtimes[0].call('alp_send', { to: 'alp-child-sibling', kind: 'note', body: 'hi' }, 'sibling')).success, false);
  assert.equal((await runtimes[0].call('alp_send', { to: assignmentId, kind: 'answer', replyTo, body: 'v2' }, 'answer')).success, true);
  const answer = decode(await asked);
  assert.deepEqual(answer, { status: 'answered', from: 'main', answer: 'v2' });
  const waiting = runtimes[0].call('alp_wait', {}, 'wait');
  runtimes[1].finish('used v2');
  assert.equal(decode(await waiting).events[0].result.output, 'used v2');
});

test('unanswered questions time out and children only mail notes to their requester', async t => {
  const { runtimes } = await setup(t, { workflow: 'smart', askTimeout: 20 });
  const start = decode(await runtimes[0].tool('peer', 'Work', { wait: false }, 'async'));
  await started(runtimes, 1);
  assert.equal((await runtimes[1].call('alp_send', { to: 'parent', kind: 'steer', body: 'do it' }, 'child-steer')).success, false);
  assert.equal((await runtimes[1].call('alp_send', { to: start.assignmentId, kind: 'note', body: 'self' }, 'child-self')).success, false);
  assert.match(decode(await runtimes[0].call('alp_ask', { question: 'root has no requester', to: 'parent' }, 'root-ask')).error, /no requester/);
  const unanswered = decode(await runtimes[1].call('alp_ask', { question: 'anyone?' }, 'ask'));
  assert.equal(unanswered.status, 'unanswered');
  const waited = decode(await runtimes[0].call('alp_wait', { timeoutMs: 5 }, 'stale'));
  assert.deepEqual(waited.events, [], 'an expired question is not delivered');
  runtimes[1].finish();
});

test('mail reaches a busy parent by steering its running turn', async t => {
  const { runtimes } = await setup(t, { workflow: 'smart' });
  const start = decode(await runtimes[0].tool('peer', 'Work', { wait: false }, 'async'));
  await started(runtimes, 1);
  assert.equal((await runtimes[1].call('alp_send', { to: 'parent', kind: 'note', body: 'found the config in src/x' }, 'note')).success, true);
  await until(() => runtimes[0].calls.some(c => c.method === 'turn/steer'));
  const text = runtimes[0].calls.find(c => c.method === 'turn/steer').params.input[0].text;
  assert.match(text, /note from peer/);
  assert.match(text, new RegExp(start.assignmentId));
  assert.match(text, /found the config in src\/x/);
  assert.equal((await runtimes[0].call('alp_send', { to: start.assignmentId, kind: 'steer', body: 'Only read src/x' }, 'down')).success, true);
  await until(() => runtimes[1].calls.some(c => c.method === 'turn/steer'));
  assert.match(runtimes[1].calls.find(c => c.method === 'turn/steer').params.input[0].text, /Follow steer messages from main[\s\S]*steer from main[\s\S]*Only read src\/x/);
  runtimes[1].finish();
});

test('an idle parent is woken by mail, without resetting its per-turn limits', async t => {
  const runLogDir = await mkdtemp(path.join(tmpdir(), 'alp-runs-'));
  t.after(() => rm(runLogDir, { recursive: true, force: true }));
  const { runtimes, events } = await setup(t, { workflow: 'smart', runLogDir });
  decode(await runtimes[0].tool('peer', 'Work', { wait: false }, 'async'));
  await started(runtimes, 1);
  runtimes[0].finish('main idle');
  assert.equal(turns(runtimes[0]).length, 1);
  runtimes[1].finish('peer result');
  await until(() => turns(runtimes[0]).length === 2);
  const wake = turns(runtimes[0])[1].params;
  assert.match(wake.input[1].text, /result from peer/);
  assert.match(wake.input[1].text, /peer result/);
  assert.equal(events.filter(e => e.type === 'session.turn' && e.sessionId === 'root' && e.state === 'started').length, 2);
  runtimes[0].finish('main final');
  let lines = [];
  for (let i = 0; i < 200 && !lines.some(l => l.event === 'mail'); i++) {
    lines = (await readFile(path.join(runLogDir, 'root.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const mail = lines.find(l => l.event === 'mail');
  assert.equal(mail.kind, 'result');
  assert.equal(mail.result, undefined, 'results are logged once, by assignment.finished');
});

test('interrupt blocks wakes; held mail rides on the next user prompt', async t => {
  const { runtimes, connection } = await setup(t, { workflow: 'smart' });
  decode(await runtimes[0].tool('peer', 'Work', { wait: false }, 'async'));
  await started(runtimes, 1);
  await connection.send({ type: 'session.interrupt', sessionId: 'root', requestId: 'stop' });
  assert.equal(runtimes[1].closed, true);
  await tick();
  assert.equal(turns(runtimes[0]).length, 1, 'no wake after interrupt');
  await connection.send({ type: 'session.prompt', sessionId: 'root', prompt: { clientMessageId: 'next', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'Continue' }] } } });
  const input = turns(runtimes[0])[1].params.input;
  assert.equal(input[1].text, 'Continue');
  assert.match(input[2].text, /result from peer/);
  assert.match(input[2].text, /canceled/);
});

test('mail received by a failed turn is redelivered', async t => {
  const { runtimes, connection } = await setup(t, { workflow: 'smart' });
  const start = decode(await runtimes[0].tool('peer', 'Work', { wait: false }, 'async'));
  await started(runtimes, 1);
  const waiting = runtimes[0].call('alp_wait', {}, 'wait');
  runtimes[1].finish('first copy');
  assert.equal(decode(await waiting).events[0].assignment, start.assignmentId);
  runtimes[0].finish('', 'failed');
  await connection.send({ type: 'session.prompt', sessionId: 'root', prompt: { clientMessageId: 'retry', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'Retry' }] } } });
  const text = turns(runtimes[0])[1].params.input[2].text;
  assert.match(text, /redelivered/);
  assert.match(text, /first copy/);
});

test('a requester whose turn ends with live assignments finishes only after handling their mail', async t => {
  const { runtimes } = await setup(t);
  const lead = runtimes[0].tool('lead', 'Coordinate', {}, 'lead');
  await started(runtimes, 1);
  decode(await runtimes[1].tool('peer', 'Read', { wait: false }, 'peer'));
  await started(runtimes, 2);
  runtimes[1].finish('lead interim');
  await tick();
  assert.equal(runtimes[1].closed, false);
  runtimes[2].finish('peer evidence');
  await until(() => turns(runtimes[1]).length === 2);
  assert.match(turns(runtimes[1])[1].params.input[1].text, /peer evidence/);
  runtimes[1].finish('ACCEPT peer evidence');
  assert.equal(decode(await lead).output, 'ACCEPT peer evidence');
});

test('silent assignments are reported once, then fail at twice the limit', async t => {
  const { runtimes } = await setup(t, { workflow: 'smart', timeout: 40 });
  const start = decode(await runtimes[0].tool('peer', 'Work', { wait: false }, 'async'));
  await started(runtimes, 1);
  const first = decode(await runtimes[0].call('alp_wait', { timeoutMs: 1000 }, 'stall'));
  assert.equal(first.events[0].kind, 'stalled');
  assert.equal(first.events[0].assignment, start.assignmentId);
  const second = decode(await runtimes[0].call('alp_wait', { timeoutMs: 1000 }, 'fail'));
  assert.equal(second.events[0].kind, 'result');
  assert.equal(second.events[0].result.status, 'failed');
  assert.match(second.events[0].result.error, /no activity for 80 ms/);
  assert.equal(runtimes[1].closed, true);
});

test('a concurrent catch-all alp_wait does not take a waiting delegate\'s result', async t => {
  const { runtimes } = await setup(t, { workflow: 'smart' });
  const delegated = runtimes[0].tool('peer', 'A', {}, 'sync');
  await started(runtimes, 1);
  const waiting = runtimes[0].call('alp_wait', { timeoutMs: 50 }, 'all');
  runtimes[1].finish('sync result');
  assert.equal(decode(await delegated).output, 'sync result');
  assert.deepEqual(decode(await waiting).events, []);
});

function gateWake(runtime) {
  let release; let entered = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const original = runtime.orchestrationContext.bind(runtime);
  runtime.orchestrationContext = async () => { entered++; await gate; return original(); };
  return { release, entered: () => entered };
}
const userPrompt = (id, text = 'Next') => ({ type: 'session.prompt', sessionId: 'root', prompt: { clientMessageId: id, delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text }] } } });

test('a user prompt arriving while a wake starts does not start a second turn', async t => {
  const { runtimes, connection, events } = await setup(t, { workflow: 'smart' });
  decode(await runtimes[0].tool('peer', 'Work', { wait: false }, 'async'));
  await started(runtimes, 1);
  runtimes[0].finish('main idle');
  const wake = gateWake(runtimes[0]);
  runtimes[1].finish('peer result');
  await until(() => wake.entered() === 1);
  const user = connection.send(userPrompt('next'));
  wake.release();
  await user;
  assert.equal(turns(runtimes[0]).length, 2);
  assert.equal(events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === 'next').result.type, 'failed');
});

test('an interrupt during wake startup cancels the woken turn', async t => {
  const { runtimes, connection, events } = await setup(t, { workflow: 'smart' });
  decode(await runtimes[0].tool('peer', 'Work', { wait: false }, 'async'));
  await started(runtimes, 1);
  runtimes[0].finish('main idle');
  const wake = gateWake(runtimes[0]);
  runtimes[1].finish('peer result');
  await until(() => wake.entered() === 1);
  const stop = connection.send({ type: 'session.interrupt', sessionId: 'root', requestId: 'stop' });
  wake.release();
  await stop;
  assert.ok(runtimes[0].calls.some(c => c.method === 'turn/interrupt'));
  assert.equal(events.filter(e => e.type === 'session.turn' && e.sessionId === 'root').at(-1).state, 'canceled');
});

test('interrupting an idle requester ends its assignment for the parent', async t => {
  const { runtimes, connection, events } = await setup(t);
  const lead = runtimes[0].tool('lead', 'Coordinate', {}, 'lead');
  await started(runtimes, 1);
  decode(await runtimes[1].tool('peer', 'Read', { wait: false }, 'peer'));
  await started(runtimes, 2);
  runtimes[1].finish('lead waiting on peer');
  await tick();
  const leadId = events.find(e => e.type === 'session.opened' && e.parentSessionId === 'root').sessionId;
  await connection.send({ type: 'session.interrupt', sessionId: leadId, requestId: 'stop-lead' });
  const result = decode(await lead);
  assert.equal(result.status, 'canceled');
  assert.equal(runtimes[2].closed, true);
});

test('a child requester that exhausts its wakes fails instead of hanging', async t => {
  const { runtimes } = await setup(t);
  const lead = runtimes[0].tool('lead', 'Coordinate', {}, 'lead');
  await started(runtimes, 1);
  decode(await runtimes[1].tool('peer', 'Read', { wait: false }, 'peer'));
  await started(runtimes, 2);
  runtimes[1].finish('lead waiting');
  for (let wake = 1; wake <= 8; wake++) {
    await runtimes[2].call('alp_send', { to: 'parent', kind: 'note', body: `note ${wake}` }, `note-${wake}`);
    await until(() => turns(runtimes[1]).length === wake + 1);
    runtimes[1].finish(`handled ${wake}`);
  }
  await runtimes[2].call('alp_send', { to: 'parent', kind: 'note', body: 'one too many' }, 'note-9');
  const result = decode(await lead);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Wake limit \(8\)/);
});

test('alp_send accepts an agent name only when it names one live assignment', async t => {
  const { runtimes } = await setup(t, { workflow: 'smart' });
  const first = decode(await runtimes[0].tool('peer', 'A', { wait: false }, 'a'));
  await started(runtimes, 1);
  const waiting = runtimes[0].call('alp_wait', {}, 'wait');
  const asked = runtimes[1].call('alp_ask', { question: 'Which?' }, 'ask');
  const { events } = decode(await waiting);
  assert.equal((await runtimes[0].call('alp_send', { to: 'peer', kind: 'answer', replyTo: events[0].id, body: 'this one' }, 'by-name')).success, true);
  assert.equal(decode(await asked).answer, 'this one');
  decode(await runtimes[0].tool('peer', 'B', { wait: false }, 'b'));
  await started(runtimes, 2);
  const ambiguous = await runtimes[0].call('alp_send', { to: 'peer', kind: 'note', body: 'which peer?' }, 'ambiguous');
  assert.match(decode(ambiguous).error, /Several live peer assignments/);
  assert.equal((await runtimes[0].call('alp_send', { to: first.assignmentId, kind: 'note', body: 'by id' }, 'by-id')).success, true);
  runtimes[1].finish(); runtimes[2].finish();
});
