import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { createTask, getTask } from '../src/core/tasks.js';
import { ClaudeTransport, createAlpRuntime } from '../dist/runtime/index.js';

let calls = 0;
function fakeTransport(runtimes) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      kind, cwd, calls: [], threadId: `thread-${index}`, turnId: undefined,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      get started() { return this.calls.filter(call => call.method === 'turn/start'); },
      get config() { return this.calls.find(call => call.method === 'thread/start')?.params; },
      async call(tool, args) {
        return JSON.parse((await this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId: `${tool}-${index}-${++calls}`, namespace: null, tool, arguments: args })).contentItems[0].text);
      },
      finish(text = 'done', turn = {}) {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `output-${index}-${turns}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed', ...turn } });
      },
      limit() {
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'failed', error: { message: 'You have hit your usage limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function until(check) {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}

async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-pause-'));
  const root = path.join(directory, 'project');
  await initProject(root);
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'pho', maxPeers: 2, supervisor: false } }));
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs'), boardDir: path.join(directory, 'boards'), ...options(directory) });
  t.after(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const events = [];
  runtime.onEvent(envelope => events.push(envelope));
  // Main runs on Codex here, so a Codex pause holds its wakes.
  await runtime.open('root', { cwd: root, model: 'codex:gpt-5.6-sol' });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Work' }] });
  return { directory, root, runtime, runtimes, events, main: runtimes[0] };
}
const none = () => ({});
const notices = (events, sessionId = 'root') => events.filter(envelope => envelope.sessionId === sessionId && envelope.event.type === 'item' && envelope.event.item.kind === 'notice').map(envelope => envelope.event.item);

test('a usage limit pauses its runtime and parks the assignment it stopped, until the user resumes', async t => {
  const { root, runtime, runtimes, events, main } = await setup(t, directory => ({ silentForMs: 40, pauseFile: path.join(directory, 'home', 'state', 'pause.json') }));
  const task = await createTask(root, { title: 'Long job' }, 'user');
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Do the long job', taskId: task.id, mode: 'read-only', wait: false });
  await until(() => runtimes[1]?.started.length === 1);
  const peer = runtimes[1];
  // Codex reports the used-up window before the turn fails.
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  peer.notification('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt }, secondary: null } });
  peer.limit();

  await until(() => runtime.pauses().runtimes.codex);
  const state = runtime.pauses();
  assert.deepEqual([state.runtimes.codex.by, state.runtimes.codex.reason, state.runtimes.codex.resetsAt], ['alpd', 'Codex usage limit reached', new Date(resetsAt * 1000).toISOString()]);
  assert.deepEqual(state.parked.map(entry => [entry.assignmentId, entry.agent, entry.runtime]), [[assignmentId, 'peer', 'codex']]);
  assert.match(notices(events)[0].text, /^Codex usage limit reached; it resets .*ALP paused delegation to Codex agents and parked their assignments; Claude agents keep working\. Run alp resume codex when it has reset\.$/);
  assert.equal(notices(events)[0].level, 'error');
  assert.deepEqual(JSON.parse(await readFile(path.join(path.dirname(root), 'home', 'state', 'pause.json'), 'utf8')).runtimes.codex.by, 'alpd');

  // The requester learns why, the task stays with the assignment, and the watchdog leaves it alone.
  // It is steered into main's running turn: main must decide, so it is not left for a later wait.
  const steered = () => main.calls.filter(call => call.method === 'turn/steer').map(call => call.params.input.at(-1).text).join('\n');
  await until(() => /Parked:/.test(steered()));
  assert.match(steered(), /stalled from peer[\s\S]*Parked: the Codex usage limit was reached\. ALP continues this assignment where it stopped when Codex is resumed/);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await getTask(root, task.id)).status, 'in_progress');
  assert.equal(runtime.status('root').assignments.length, 1);

  // No new Codex assignments; Claude still takes them.
  const refused = await main.call('alp_delegate', { agent: 'peer', task: 'More', mode: 'read-only', wait: false });
  assert.match(refused.error, /^Codex is paused \(Codex usage limit reached\); the limit resets /);
  assert.match(refused.next, /Pass a model of claude: from the catalog to run it on Claude/);
  const onClaude = await main.call('alp_delegate', { agent: 'peer', task: 'More', mode: 'read-only', model: 'claude:claude-sonnet-4-6', wait: false });
  assert.ok(onClaude.assignmentId, JSON.stringify(onClaude));
  await until(() => runtimes[2]?.kind === 'claude' && runtimes[2].started.length === 1);
  await runtimes[2].call('alp_handoff', { outcome: 'complete', summary: 'Read it' });
  runtimes[2].finish('Read');
  await main.call('alp_wait', { assignments: [onClaude.assignmentId] });

  assert.throws(() => runtime.resume({ runtime: 'gemini' }), /runtime must be codex or claude/);
  runtime.resume({ runtime: 'codex' });
  assert.deepEqual(runtime.pauses(), { runtimes: {}, parked: [] });
  await until(() => peer.started.length === 2);
  assert.match(peer.started[1].params.input.at(-1).text, /^ALP resumed this assignment; it had stopped because the Codex usage limit was reached\. Continue where you left off/);
  assert.match(notices(events).at(-1).text, /^Codex resumed by the user\. Parked assignments continue\.$/);
  await peer.call('alp_handoff', { outcome: 'complete', summary: 'Finished the long job' });
  peer.finish('Done');
  const { events: done } = await main.call('alp_wait', { assignments: [assignmentId] });
  assert.equal(done[0].result.task.status, 'review');
  main.finish('Done');
});

test('alp pause holds delegation and wakes; --now parks running assignments where they are', async t => {
  const { runtime, runtimes, events, main } = await setup(t, none);
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Work slowly', mode: 'read-only', wait: false });
  await until(() => runtimes[1]?.started.length === 1);
  const peer = runtimes[1];

  const state = runtime.pause({ now: true, reason: 'Lunch' });
  assert.deepEqual([state.all.by, state.all.reason], ['the user', 'Lunch']);
  assert.match(notices(events).at(-1).text, /^ALP paused by the user: Lunch\. Delegation waits, and running assignments park where they are\. alp resume continues\.$/);
  // The running assignment is interrupted; its turn ends as interrupted and it parks.
  assert.ok(peer.calls.some(call => call.method === 'turn/interrupt'));
  peer.notification('turn/completed', { threadId: peer.threadId, turn: { id: peer.turnId, status: 'interrupted' } });
  await until(() => runtime.pauses().parked.length === 1);
  assert.equal(runtime.pauses().parked[0].reason, 'paused by the user');
  assert.equal(runtime.snapshot(assignmentId).parked, 'paused by the user');
  assert.match((await main.call('alp_delegate', { agent: 'peer', task: 'More', mode: 'read-only', model: 'claude:claude-sonnet-4-6', wait: false })).error, /^ALP is paused \(Lunch, by the user\)/);
  assert.throws(() => runtime.resume({ runtime: 'codex' }), /All of ALP is paused/);

  // Main ends its turn; mail for it waits while paused.
  main.finish('Waiting');
  runtime.message(assignmentId, 'Also check the docs');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(peer.started.length, 1);

  runtime.resume();
  await until(() => peer.started.length === 2);
  assert.equal(runtime.snapshot(assignmentId).parked, undefined);
  assert.match(peer.started[1].params.input.map(entry => entry.text).join('\n'), /ALP resumed this assignment; it had stopped because paused by the user/);
  await peer.call('alp_handoff', { outcome: 'complete', summary: 'Checked' });
  peer.finish('Checked');
  // Main is woken by the result once nothing is paused.
  await until(() => main.started.length === 2);
});

test('a pause without --now lets running turns finish, and holds wakes until resume', async t => {
  const { runtime, runtimes, main } = await setup(t, none);
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Quick', mode: 'read-only', wait: false });
  await until(() => runtimes[1]?.started.length === 1);
  main.finish('Started it');
  runtime.pause({ runtime: 'codex' });
  assert.equal(runtimes[1].calls.some(call => call.method === 'turn/interrupt'), false);
  await runtimes[1].call('alp_handoff', { outcome: 'complete', summary: 'Quick done' });
  runtimes[1].finish('Done');
  // The result waits: main is on Codex.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(main.started.length, 1);
  assert.equal(runtime.status('root').assignments.length, 0);
  runtime.resume({ runtime: 'codex' });
  await until(() => main.started.length === 2);
  assert.match(main.started[1].params.input.at(-1).text, new RegExp(assignmentId));
});

test('Claude reports a usage limit as a failed turn with the reset time', async () => {
  const transport = new ClaudeTransport(process.execPath, tmpdir(), process.env);
  const seen = [];
  transport.onNotification((method, params) => seen.push({ method, params }));
  transport.activeTurn = 'turn-1';
  transport.handle({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.91, resetsAt: 1_900_000_000 } });
  transport.handle({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_900_000_000, rateLimitType: 'five_hour' } });
  transport.handle({ type: 'assistant', error: 'rate_limit', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: "You've hit your limit" }] } });
  transport.handle({ type: 'result', subtype: 'success', is_error: false });
  assert.deepEqual(seen.filter(entry => entry.method === 'account/rateLimits/updated').map(entry => entry.params.claude.status), ['allowed_warning', 'rejected']);
  const ended = seen.find(entry => entry.method === 'turn/completed').params.turn;
  assert.deepEqual([ended.status, ended.error.codexErrorInfo, ended.error.resetsAt], ['failed', 'usageLimitExceeded', 1_900_000_000]);
  assert.match(ended.error.message, /^Claude usage limit reached; resets 2030-/);
  // With overage still allowed, a failed turn is an ordinary failure.
  transport.activeTurn = 'turn-2';
  transport.handle({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', overageStatus: 'allowed' } });
  transport.handle({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'] });
  const second = seen.filter(entry => entry.method === 'turn/completed')[1].params.turn;
  assert.deepEqual([second.status, second.error.message, second.error.codexErrorInfo], ['failed', 'boom', undefined]);
  await transport.close();
});

test('usage warnings reach the user once per window', async t => {
  const { runtimes, events, main } = await setup(t, none);
  const resetsAt = Math.floor(Date.now() / 1000) + 7200;
  for (let i = 0; i < 2; i++) main.notification('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 93, windowDurationMins: 300, resetsAt }, secondary: null } });
  assert.equal(notices(events).length, 1);
  assert.match(notices(events)[0].text, /^Codex has used 93% of a usage window that resets /);
  assert.equal(notices(events)[0].level, 'warning');
  assert.equal(runtimes.length, 1);
  main.finish('Done');
});

test('a limit pause survives a restart, and autoResume lifts it after the reset', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-pause-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'pause.json');
  const past = new Date(Date.now() - 120_000).toISOString();
  await writeFile(file, JSON.stringify({ runtimes: { codex: { since: past, by: 'alpd', reason: 'Codex usage limit reached', resetsAt: past } } }));
  const kept = createAlpRuntime({ transport: fakeTransport([]), supervisor: false, pauseFile: file });
  assert.equal(kept.pauses().runtimes.codex.reason, 'Codex usage limit reached');
  await kept.shutdown();
  const lifted = createAlpRuntime({ transport: fakeTransport([]), supervisor: false, pauseFile: file, autoResume: true });
  t.after(() => lifted.shutdown());
  await until(() => !lifted.pauses().runtimes.codex);
  await until(async () => JSON.parse(await readFile(file, 'utf8')).runtimes.codex === undefined);
});

test('a requester stops a parked assignment with alp_cancel and hands the rest to Claude, while a reviewer may run beside', async t => {
  const { root, runtime, runtimes, main } = await setup(t, directory => ({ silentForMs: 3_600_000, pauseFile: path.join(directory, 'home', 'state', 'pause.json') }));
  const task = await createTask(root, { title: 'Restyle the nav' }, 'user');
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Restyle the nav', taskId: task.id, mode: 'workspace-write' });
  await until(() => runtimes[1]?.started.length === 1);
  runtimes[1].limit();
  await until(() => runtime.pauses().parked.length === 1);
  // The requester is told what it can do, not only that it waits.
  const steered = () => main.calls.filter(call => call.method === 'turn/steer').map(call => call.params.input.at(-1).text).join('\n');
  await until(() => /Parked:/.test(steered()));
  assert.match(steered(), /stalled from peer[\s\S]*stop it with alp_cancel and give the rest to an agent on another runtime/);

  // A second writer waits for the parked one; a read-only reviewer runs beside it.
  const blocked = await main.call('alp_delegate', { agent: 'peer', task: 'Finish it', mode: 'workspace-write', model: 'claude:claude-opus-5-5' });
  assert.match(blocked.error, /already running/);
  assert.match(blocked.next, new RegExp(`peer ${assignmentId} is parked; to go on without it, stop it with alp_cancel`));
  const review = await main.call('alp_delegate', { agent: 'reviewer', task: 'Review the diff', mode: 'read-only', model: 'claude:claude-fable-5-1' });
  assert.equal(review.status, 'running', JSON.stringify(review));

  assert.match((await main.call('alp_cancel', { assignmentId: 'alp-child-unknown' })).error, /Not one of your running assignments/);
  const canceled = await main.call('alp_cancel', { assignmentId, reason: 'Codex hit its usage limit; Claude takes over' });
  assert.deepEqual([canceled.status, canceled.agent], ['canceled', 'peer']);
  assert.equal(runtimes[1].closed, true);
  assert.equal((await getTask(root, task.id)).status, 'open');
  assert.equal(runtime.pauses().parked.length, 0);
  const takeover = await main.call('alp_delegate', { agent: 'peer', task: 'Finish the restyle', taskId: task.id, mode: 'workspace-write', model: 'claude:claude-opus-5-5' });
  assert.equal(takeover.status, 'running', JSON.stringify(takeover));
});
