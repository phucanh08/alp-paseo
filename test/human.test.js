import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { connect } from '../src/client/index.js';
import { createAlpRuntime } from '../dist/runtime/index.js';
import { createDaemonServer } from '../dist/daemon/index.js';
import { createProvider } from '../plugins/paseo/server/dist/index.js';
import { PROVIDER_CAPABILITIES, ProviderEventSchema } from '@getpaseo/plugin/server/provider';

async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}

let calls = 0;
function fakeTransport(runtimes) {
  return () => {
    const index = runtimes.length;
    const runtime = {
      calls: [], threadId: `thread-${index}`, turnId: `turn-${index}`,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() {},
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') return { turn: { id: this.turnId } };
        return {};
      },
      async call(tool, args, callId = `${tool}-${index}-${++calls}`) {
        return JSON.parse((await this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId, namespace: null, tool, arguments: args })).contentItems[0].text);
      },
      finish(text = 'done') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `output-${index}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function project(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-human-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  await initProject(root);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['peer'] } }));
  return { directory, root };
}

async function setup(t, options = {}) {
  const { directory, root } = await project(t);
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), runLogDir: path.join(directory, 'runs'), silentForMs: 40, ...options });
  t.after(() => runtime.shutdown());
  const envelopes = [];
  runtime.onEvent(envelope => envelopes.push(envelope));
  await runtime.open('root', { cwd: root, mode: 'workspace-write' });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
  const of = type => envelopes.filter(envelope => envelope.event.type === type);
  const log = async () => (await readFile(path.join(directory, 'runs', 'root.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { root, runtime, runtimes, envelopes, of, log };
}

test('an assignment asks the user; the tree shows it waiting, and the answer resumes it', async t => {
  const { runtime, runtimes, of, log } = await setup(t);
  const main = runtimes[0];
  const delegated = await main.call('alp_delegate', { agent: 'peer', task: 'Pick a database', wait: false });
  assert.equal(delegated.status, 'running');
  await until(() => runtimes.length === 2);
  const peer = runtimes[1];
  const asked = peer.call('alp_ask', { question: 'Postgres or SQLite?', to: 'user', options: ['Postgres', 'SQLite'] });
  await until(() => of('question').length === 1);
  const [{ sessionId, event: { question } }] = of('question');
  assert.equal(sessionId, delegated.assignmentId);
  assert.deepEqual({ agent: question.agent, rootId: question.rootId, body: question.body, options: question.options }, { agent: 'peer', rootId: 'root', body: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'] });
  assert.deepEqual(runtime.questions().map(pending => pending.id), [question.id]);

  // Waiting for the user is not silence: the watchdog (40 ms here) leaves the assignment alone.
  await new Promise(resolve => setTimeout(resolve, 150));
  const status = runtime.status(sessionId);
  assert.equal(status.rootId, 'root');
  assert.deepEqual(status.sessions.map(session => [session.agent, session.state]), [['main', 'running'], ['peer', 'waiting_user']]);
  assert.equal(status.assignments[0].status, 'waiting_user');
  assert.equal(status.questions[0].id, question.id);

  runtime.answer(question.id, { text: 'SQLite' });
  assert.deepEqual(await asked, { status: 'answered', from: 'user', answer: 'SQLite' });
  assert.deepEqual(of('question.resolved').map(envelope => envelope.event), [{ type: 'question.resolved', questionId: question.id, outcome: 'answered', answer: 'SQLite' }]);
  assert.deepEqual(runtime.questions(), []);
  assert.throws(() => runtime.answer(question.id, { text: 'again' }), /No question/);
  await until(async () => (await log().catch(() => [])).some(entry => entry.event === 'human.answer'));
  const entries = await log();
  assert.ok(entries.some(entry => entry.event === 'human.question' && entry.questionId === question.id && entry.agent === 'peer'));
  assert.ok(entries.some(entry => entry.event === 'human.answer' && entry.outcome === 'answered' && entry.answer === 'SQLite'));
});

test('a root asks the user mid-turn; dismissal, timeout and the end of the turn settle questions', async t => {
  const { runtime, runtimes, of } = await setup(t, { userAskTimeoutMs: 60 });
  const main = runtimes[0];
  const dismissed = main.call('alp_ask', { question: 'Ship now?' });
  await until(() => runtime.questions().length === 1);
  runtime.answer(runtime.questions()[0].id, { dismiss: true, reason: 'Not now' });
  assert.equal((await dismissed).status, 'dismissed');
  assert.equal((await dismissed).reason, 'Not now');

  assert.equal((await main.call('alp_ask', { question: 'Anyone there?' })).status, 'unanswered');

  const abandoned = main.call('alp_ask', { question: 'Still there?' });
  await until(() => runtime.questions().length === 1);
  main.finish();
  assert.match((await abandoned).error, /Turn ended/);
  assert.deepEqual(of('question.resolved').map(envelope => envelope.event.outcome), ['dismissed', 'timeout', 'canceled']);
  assert.deepEqual(runtime.questions(), []);
});

test('ask arguments are checked: a root has no requester, options are for the user, one question at a time', async t => {
  const { runtime, runtimes } = await setup(t);
  const main = runtimes[0];
  assert.match((await main.call('alp_ask', { question: 'Hm?', to: 'parent' })).error, /no requester/);
  await main.call('alp_delegate', { agent: 'peer', task: 'Work', wait: false });
  await until(() => runtimes.length === 2);
  const peer = runtimes[1];
  assert.match((await peer.call('alp_ask', { question: 'A or B?', options: ['A'] })).error, /options are up to 10 short answers, for questions to the user/);
  void peer.call('alp_ask', { question: 'First?', to: 'user' });
  await until(() => runtime.questions().length === 1);
  assert.match((await peer.call('alp_ask', { question: 'Second?' })).error, /already waiting/);
});

test('the user can mail an assignment directly; it arrives as a user instruction in the running turn', async t => {
  const { runtime, runtimes } = await setup(t);
  const delegated = await runtimes[0].call('alp_delegate', { agent: 'peer', task: 'Work', wait: false });
  await until(() => runtimes.length === 2);
  runtime.message(delegated.assignmentId, 'Use SQLite, not Postgres');
  await until(() => runtimes[1].calls.some(call => call.method === 'turn/steer'));
  const steer = runtimes[1].calls.find(call => call.method === 'turn/steer');
  assert.match(steer.params.input[0].text, /Mail sent by "user" is the user writing to you directly/);
  assert.match(steer.params.input[0].text, /note from user[\s\S]*Use SQLite, not Postgres/);
  assert.throws(() => runtime.message('nope', 'Hi'), /not open/);
});

test('alpd lists and answers questions by id prefix, reports tree status and the log, and re-announces pending questions', async t => {
  const { directory, root } = await project(t);
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), runLogDir: path.join(directory, 'runs') });
  const server = createDaemonServer({ runtime, socketPath: path.join(directory, 'd.sock'), version: 'test', runLogDir: path.join(directory, 'runs') });
  await server.listen();
  t.after(async () => { await server.close(); await runtime.shutdown(); });
  const client = await connect(path.join(directory, 'd.sock'));
  t.after(() => client.close());
  await client.request('session.create', { sessionId: 'root', spec: { cwd: root, mode: 'workspace-write' } });
  await client.request('session.prompt', { sessionId: 'root', clientMessageId: 'm1', content: [{ type: 'text', text: 'Go' }] });
  await until(() => runtimes[0]?.calls.some(call => call.method === 'turn/start'));
  const asked = runtimes[0].call('alp_ask', { question: 'Which name?' });
  await until(async () => (await client.request('question.list')).questions.length === 1);
  const [question] = (await client.request('question.list', { projectRoot: root })).questions;
  assert.deepEqual((await client.request('question.list', { projectRoot: '/elsewhere' })).questions, []);

  const { status } = await client.request('session.status', { sessionId: 'root' });
  assert.equal(status.sessions[0].state, 'waiting_user');

  // A second viewer attaching to the tree learns about the open question.
  const viewer = await connect(path.join(directory, 'd.sock'));
  t.after(() => viewer.close());
  const seen = [];
  viewer.onEvent(envelope => seen.push(envelope.event));
  await viewer.request('session.attach', { sessionId: 'root', replay: false });
  await until(() => seen.some(event => event.type === 'question' && event.question.id === question.id));

  assert.deepEqual(await client.request('question.answer', { questionId: question.id.slice(0, 5), text: 'Orchid' }), { questionId: question.id });
  assert.deepEqual(await asked, { status: 'answered', from: 'user', answer: 'Orchid' });
  await assert.rejects(client.request('question.answer', { questionId: question.id, text: 'x' }), error => error.code === 1001);
  await until(async () => (await client.request('session.log', { sessionId: 'root' })).entries.length === 2);
  const { entries } = await client.request('session.log', { sessionId: 'root' });
  assert.deepEqual(entries.map(entry => entry.event), ['human.question', 'human.answer']);
  await assert.rejects(client.request('session.status', { sessionId: 'nope' }), error => error.code === 1001);
});

test('Paseo shows a question to the user on the root agent and returns the answer, or the dismissal', async t => {
  const { root } = await project(t);
  const runtimes = [];
  const provider = createProvider({ transport: fakeTransport(runtimes) });
  const connection = await provider.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  t.after(() => connection.close());
  const events = [];
  connection.onEvent(event => { ProviderEventSchema.parse(event); events.push(event); });
  await connection.send({ type: 'session.open', requestId: 'open', sessionId: 'paseo-root', history: 'skip', config: { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: true, mode: 'workspace-write' } });
  await connection.send({ type: 'session.prompt', sessionId: 'paseo-root', prompt: { clientMessageId: 'first', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'Go' }] } } });
  await connection.send({ type: 'session.prompt', sessionId: 'paseo-root', prompt: { clientMessageId: 'second', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'Go' }] } } });
  const delegated = await runtimes[0].call('alp_delegate', { agent: 'peer', task: 'Work', wait: false });
  await until(() => runtimes.length === 2);

  const answered = runtimes[1].call('alp_ask', { question: 'Tabs or spaces?', to: 'user', options: ['Tabs', 'Spaces'] });
  await until(() => events.some(event => event.type === 'session.permission'));
  const permission = events.find(event => event.type === 'session.permission');
  assert.equal(permission.sessionId, 'paseo-root', 'questions from any agent appear on the root agent');
  assert.equal(permission.request.kind, 'question');
  assert.equal(permission.request.title, 'peer asks you');
  assert.deepEqual(permission.request.input.questions[0].options, [{ label: 'Tabs' }, { label: 'Spaces' }]);
  assert.equal(permission.request.metadata.alpSessionId, delegated.assignmentId);
  await connection.send({ type: 'session.permission', sessionId: 'paseo-root', permissionId: permission.request.id, response: { behavior: 'allow', updatedInput: { answers: { Answer: 'Spaces' } } } });
  assert.deepEqual(await answered, { status: 'answered', from: 'user', answer: 'Spaces' });
  await until(() => events.some(event => event.type === 'session.permission_resolved' && event.permissionId === permission.request.id));

  const dismissed = runtimes[1].call('alp_ask', { question: 'Again?', to: 'user' });
  await until(() => events.filter(event => event.type === 'session.permission').length === 2);
  const second = events.filter(event => event.type === 'session.permission')[1];
  await connection.send({ type: 'session.permission', sessionId: 'paseo-root', permissionId: second.request.id, response: { behavior: 'deny', message: 'Decide yourself' } });
  assert.deepEqual(await dismissed, { status: 'dismissed', question: second.request.id, reason: 'Decide yourself', next: 'Decide, and record the assumption in your handoff or final message; or report that you are blocked.' });
});
