import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { createTask, getTask, loadTasks } from '../src/core/tasks.js';
import { createAlpRuntime, reclaimWorktrees } from '../dist/runtime/index.js';
import { createDaemonServer, createStore } from '../dist/daemon/index.js';
import { connect } from '../src/client/index.js';

let calls = 0;
/** A fake native harness; resuming a thread keeps its id, as Codex and Claude do. */
function fakeTransport(runtimes) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      kind, cwd, calls: [], threadId: `thread-${index}`, turnId: undefined, closed: false,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method === 'thread/resume') { this.threadId = params.threadId; return { thread: { id: params.threadId } }; }
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      get started() { return this.calls.filter(call => call.method === 'turn/start'); },
      lastText() { return this.started.at(-1)?.params.input.at(-1).text ?? ''; },
      async call(tool, args) {
        return JSON.parse((await this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId: `${tool}-${index}-${++calls}`, namespace: null, tool, arguments: args })).contentItems[0].text);
      },
      item(text = 'working') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `item-${index}-${++calls}`, text } });
      },
      finish(text = 'done') {
        this.item(text);
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function until(check, what = 'condition') {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`Expected ${what} did not arrive`);
}

const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

async function workspace(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await initProject(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  const options = {
    supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs'),
    worktreeDir: path.join(directory, 'worktrees'), copyDir: path.join(directory, 'copies'),
    liveFile: path.join(directory, 'state', 'live.json'), recallFile: path.join(directory, 'state', 'recall.json'),
  };
  return { directory, root, options };
}

const runLog = async (directory, rootId) => (await readFile(path.join(directory, 'runs', `${rootId}.jsonl`), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));

test('a worktree assignment alpd stopped under continues in the next alpd: same thread, worktree, task and requester', async t => {
  const { directory, root, options } = await workspace(t);
  const runtimes = [];
  const first = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
  await first.open('root', { cwd: root, persist: true });
  await first.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Build it' }] });
  const main = runtimes[0];
  const task = await createTask(root, { title: 'Add notes' }, 'user');
  const delegated = await main.call('alp_delegate', { agent: 'peer', task: 'Write notes.txt', taskId: task.id, mode: 'workspace-write', isolation: 'worktree', wait: false });
  assert.equal(delegated.status, 'running');
  const peer = runtimes[1];
  const id = delegated.assignmentId;
  await until(() => peer.started.length === 1, 'the peer turn');
  await writeFile(path.join(peer.cwd, 'notes.txt'), 'half done\n');
  const snapshot = first.snapshot('root');
  await first.shutdown();

  // Stopping kept the assignment for the next alpd; its task is still in progress.
  const live = JSON.parse(await readFile(options.liveFile, 'utf8'));
  assert.deepEqual(live.map(entry => [entry.assignmentId, entry.agent, entry.taskId, entry.isolation, entry.threadId]), [[id, 'peer', task.id, 'worktree', peer.threadId]]);
  assert.equal((await getTask(root, task.id)).status, 'in_progress');
  assert.ok((await runLog(directory, 'root')).some(entry => entry.event === 'assignment.interrupted' && entry.assignmentId === id));
  // As alpd does at start: work left in worktrees goes to their branches.
  assert.deepEqual(await reclaimWorktrees(options.worktreeDir), [`alp/${id}`]);

  const second = createAlpRuntime({ ...options, transport: fakeTransport(runtimes), previousExit: { kind: 'crash', at: '2026-10-09T03:00:00.000Z' } });
  t.after(() => second.shutdown());
  const events = [];
  second.onEvent(envelope => events.push(envelope));
  assert.deepEqual(second.recoverable().map(entry => entry.assignmentId), [id]);
  await second.open('root', { cwd: root, persist: true, restore: { agent: 'main', threadId: snapshot.threadId, runtime: snapshot.runtime, model: snapshot.model, workflow: snapshot.workflow } });
  const outcomes = await second.recover('root', { continueRoot: true });
  assert.deepEqual(outcomes, [{ assignmentId: id, agent: 'peer', outcome: 'resumed' }]);

  const [mainAgain, peerAgain] = runtimes.slice(2);
  assert.equal(peerAgain.calls[0].method, 'thread/resume');
  assert.equal(peerAgain.calls[0].params.threadId, peer.threadId);
  assert.equal(peerAgain.cwd, peer.cwd);
  assert.equal(await readFile(path.join(peerAgain.cwd, 'notes.txt'), 'utf8'), 'half done\n');
  await until(() => peerAgain.started.length === 1 && mainAgain.started.length === 1, 'both continued');
  assert.match(peerAgain.lastText(), /^ALP: alpd stopped unexpectedly while you worked on this assignment, and reopened this session\. Your earlier work in it and your worktree is intact/);
  assert.match(mainAgain.lastText(), new RegExp(`These assignments of yours continue and report to you: ${id} \\(peer, task ${task.id}\\)\\. Wait for them with alp_wait`));
  const retaken = await getTask(root, task.id);
  assert.equal(retaken.assignee.assignment, id);
  assert.equal(retaken.log.at(-1).event, 'resumed');
  assert.notEqual(retaken.assignee.epoch, live[0].epoch);
  const notice = events.find(envelope => envelope.event.type === 'item' && envelope.event.item.kind === 'notice');
  assert.equal(notice.event.item.text, 'ALP: alpd stopped unexpectedly (around 2026-10-09T03:00:00.000Z). 1 of 1 running assignments reopened, and this session.');

  // The continued assignment finishes as any other: main gets its result and the task waits for review.
  await peerAgain.call('alp_handoff', { outcome: 'complete', summary: 'Wrote notes.txt' });
  await writeFile(path.join(peerAgain.cwd, 'notes.txt'), 'done\n');
  peerAgain.finish('Done');
  const waited = await mainAgain.call('alp_wait', { assignments: [id] });
  assert.equal(waited.events[0].result.status, 'completed');
  assert.deepEqual(waited.events[0].result.worktree.files, ['notes.txt']);
  assert.equal((await getTask(root, task.id)).status, 'review');
  await until(async () => JSON.parse(await readFile(options.liveFile, 'utf8')).length === 0, 'the live file to empty');
  mainAgain.finish('ok');
});

test('a runtime process that dies mid-turn is restarted and its assignment continues; repeated deaths without progress fail it', async t => {
  const { directory, root, options } = await workspace(t);
  const runtimes = [];
  const runtime = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
  const main = runtimes[0];
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Investigate', wait: false });
  let peer = runtimes[1];
  await until(() => peer.started.length === 1);
  const thread = peer.threadId;

  peer.failure(new Error('codex app-server exited with code 1'));
  await until(() => runtimes[2]?.started.length === 1, 'the restarted process');
  assert.equal(peer.closed, true);
  peer = runtimes[2];
  assert.deepEqual(peer.calls.slice(0, 2).map(call => [call.method, call.params.threadId]), [['thread/resume', thread], ['turn/start', thread]]);
  assert.match(peer.lastText(), /^ALP restarted your (Codex|Claude) process after it stopped in the middle of your turn\. Continue where you left off/);
  const log = await runLog(directory, 'root');
  assert.deepEqual(log.filter(entry => entry.event.startsWith('session.')).map(entry => entry.event), ['session.restarted', 'session.revived']);
  // Progress keeps the breaker closed: an assignment that works between deaths keeps being restarted.
  for (let death = 0; death < 3; death++) {
    peer.item('found something');
    const next = runtimes.length;
    peer.failure(new Error('killed'));
    await until(() => runtimes[next]?.started.length === 1, `restart ${death + 2}`);
    peer = runtimes[next];
  }
  // Three restarts in a row that bring no progress: the next death ends the assignment.
  for (let death = 0; death < 2; death++) {
    const next = runtimes.length;
    peer.failure(new Error('killed again'));
    await until(() => runtimes[next]?.started.length === 1, `restart without progress ${death + 1}`);
    peer = runtimes[next];
  }
  const count = runtimes.length;
  peer.failure(new Error('killed for good'));
  let finished;
  await until(async () => (finished = (await runLog(directory, 'root')).find(entry => entry.event === 'assignment.finished' && entry.assignmentId === assignmentId)), 'the assignment to end');
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /killed for good/);
  assert.equal(runtimes.length, count);
  main.finish('ok');
});

test('assignments the next alpd cannot continue end with their task reopened; with recovery parked they wait for alp resume', async t => {
  const { directory, root, options } = await workspace(t);
  const runtimes = [];
  const start = async () => {
    const runtime = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
    await runtime.open('root', { cwd: root, persist: true });
    await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
    const main = runtimes.at(-1);
    const task = await createTask(root, { title: `Task ${runtimes.length}` }, 'user');
    const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Do it', taskId: task.id, wait: false });
    await until(() => runtimes.at(-1).started.length === 1);
    const snapshot = runtime.snapshot('root');
    await runtime.shutdown();
    return { task, assignmentId, snapshot };
  };

  const abandoned = await start();
  const second = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
  const outcomes = await second.abandon('root', 'its root session cannot be reopened');
  assert.deepEqual(outcomes, [{ assignmentId: abandoned.assignmentId, agent: 'peer', outcome: 'failed', error: 'its root session cannot be reopened' }]);
  const task = await getTask(root, abandoned.task.id);
  assert.equal(task.status, 'open');
  assert.match(task.log.at(-1).reason, /alpd restarted and it could not continue: its root session cannot be reopened/);
  assert.ok((await runLog(directory, 'root')).some(entry => entry.event === 'assignment.finished' && entry.assignmentId === abandoned.assignmentId && entry.status === 'failed' && entry.reconciled));
  assert.deepEqual(JSON.parse(await readFile(options.liveFile, 'utf8')), []);
  await second.shutdown();

  const parked = await start();
  const third = createAlpRuntime({ ...options, transport: fakeTransport(runtimes), recoveryResume: false });
  t.after(() => third.shutdown());
  const events = [];
  third.onEvent(envelope => events.push(envelope));
  await third.open('root', { cwd: root, persist: true, restore: { agent: 'main', threadId: parked.snapshot.threadId, runtime: parked.snapshot.runtime, model: parked.snapshot.model, workflow: parked.snapshot.workflow } });
  assert.deepEqual((await third.recover('root')).map(outcome => outcome.outcome), ['parked']);
  const peer = runtimes.at(-1);
  assert.equal(peer.started.length, 0);
  assert.deepEqual(third.pauses().parked.map(entry => [entry.assignmentId, entry.reason]), [[parked.assignmentId, 'alpd restarted']]);
  assert.match(events.find(envelope => envelope.event.item?.kind === 'notice').event.item.text, /1 of 1 running assignments reopened; they wait parked: run alp resume to continue them\./);
  third.resume();
  await until(() => peer.started.length === 1);
  assert.match(peer.lastText(), /^ALP: alpd restarted while you worked on this assignment/);
  assert.equal((await loadTasks(root)).tasks.find(entry => entry.id === parked.task.id).status, 'in_progress');
});

test('alpd reopens a tree by itself after a restart and its assignment continues with no client attached', async t => {
  const { directory, root, options } = await workspace(t);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'] } }));
  const runtimes = [];
  const daemon = async () => {
    const runtime = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
    const store = createStore(path.join(directory, 'state'));
    const socketPath = path.join(directory, `d${runtimes.length}.sock`);
    const server = createDaemonServer({ runtime, socketPath, version: 'test', store, runLogDir: options.runLogDir });
    await server.listen();
    const stop = async () => { await server.close(); await runtime.shutdown(); await store.flush(); };
    t.after(stop);
    return { runtime, socketPath, store, stop };
  };
  const first = await daemon();
  const client = await connect(first.socketPath);
  const { session } = await client.request('session.create', { spec: { cwd: root, persist: true } });
  await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: [{ type: 'text', text: 'Delegate' }] });
  await until(() => runtimes[0]?.started.length === 1);
  const delegated = await runtimes[0].call('alp_delegate', { agent: 'lead', task: 'Work', wait: false });
  await until(() => runtimes[1]?.started.length === 1);
  runtimes[0].finish('Waiting for lead');
  client.close();
  // A clean stop keeps running work, as a crash does.
  await first.stop();

  const before = runtimes.length;
  const second = await daemon();
  await until(() => runtimes.length === before + 2 && runtimes[before + 1].started.length === 1, 'the lead to continue');
  const [mainAgain, leadAgain] = runtimes.slice(before);
  assert.equal(mainAgain.started.length, 0);
  assert.equal(leadAgain.calls[0].params.threadId, runtimes[1].threadId);
  assert.match(leadAgain.lastText(), /^ALP: alpd restarted while you worked on this assignment/);
  assert.equal(second.runtime.snapshot(delegated.assignmentId).parentId, session.id);
  // The lead finishes; main wakes for its result, then the tree closes since nobody watches it.
  await leadAgain.call('alp_handoff', { outcome: 'complete', summary: 'Worked' });
  leadAgain.finish('done');
  await until(() => mainAgain.started.length === 1, 'main to wake for the result');
  assert.match(mainAgain.started[0].params.input.at(-1).text, /Worked/);
  mainAgain.finish('Reported');
  await until(() => !second.runtime.snapshot(session.id), 'the unwatched root to close');
  const records = await second.store.list();
  assert.equal(records.find(record => record.id === delegated.assignmentId).status, 'closed');
  assert.ok((await stat(options.liveFile)).isFile());
});
