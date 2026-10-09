import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { createTask, getTask, loadTasks, releaseOrphans, startTask, taskDigest } from '../src/core/tasks.js';
import { createAlpRuntime } from '../dist/runtime/index.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

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
      finish(text = 'done') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `output-${index}-${turns}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}

async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-recall-'));
  const root = path.join(directory, 'project');
  await initProject(root);
  const { settings, ...runtimeOptions } = options(directory);
  if (settings) await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify(settings));
  git(root, 'init', '--quiet', '-b', 'main');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init');
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs'), boardDir: path.join(directory, 'boards'), ...runtimeOptions });
  t.after(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const prompt = (session, id, text) => runtime.prompt(session, { clientMessageId: id, delivery: 'auto', content: [{ type: 'text', text }] });
  return { directory, root, runtime, runtimes, prompt };
}

const noOptions = () => ({});

test('releaseOrphans puts back tasks whose assignment is gone, and the digest says so', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-orphans-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  await mkdir(path.join(root, '.alp'), { recursive: true });
  // A project without tasks gets no tasks directory from the check.
  assert.deepEqual(await releaseOrphans(root, () => true, async () => undefined, 'alpd'), []);
  await assert.rejects(readFile(path.join(root, '.alp', 'tasks', '.gitignore')), { code: 'ENOENT' });

  const gone = await createTask(root, { title: 'Gone' }, 'user');
  const live = await createTask(root, { title: 'Live' }, 'user');
  const mine = await createTask(root, { title: 'Mine' }, 'user');
  await startTask(root, gone.id, { agent: 'peer', assignment: 'a-old', epoch: 'e1' }, 'main');
  await startTask(root, live.id, { agent: 'lead', assignment: 'a-live', epoch: 'e2' }, 'main');
  await startTask(root, mine.id, { agent: 'main', session: 'root' }, 'main');
  assert.equal((await getTask(root, gone.id)).log.at(-1).assignment, 'a-old');

  const released = await releaseOrphans(root, assignee => assignee.epoch === 'e1', async assignee => `work kept on branch alp/${assignee.assignment}`, 'alpd');
  assert.deepEqual(released.map(task => task.id), [gone.id]);
  const current = await getTask(root, gone.id);
  assert.deepEqual([current.status, current.assignee], ['open', null]);
  assert.deepEqual({ ...current.log.at(-1), at: undefined }, { at: undefined, by: 'alpd', event: 'orphaned', agent: 'peer', assignment: 'a-old', note: 'work kept on branch alp/a-old' });
  assert.equal((await getTask(root, live.id)).status, 'in_progress');
  assert.equal((await getTask(root, mine.id)).status, 'in_progress');

  const lines = taskDigest((await loadTasks(root)).tasks).split('\n');
  assert.ok(lines.includes(`- interrupted: ${gone.id} P2 Gone ← peer; alpd stopped while it worked, work kept on branch alp/a-old; delegate it again`));
  assert.ok(!lines.some(line => line.startsWith('- ready:') && line.includes(gone.id)));
  // Starting it again ends the notice.
  await startTask(root, gone.id, { agent: 'peer', assignment: 'a-new', epoch: 'e3' }, 'main');
  assert.ok(!taskDigest((await loadTasks(root)).tasks).includes('interrupted'));
});

test('main\'s first turn puts back tasks an earlier alpd\'s assignments held, not those of a live alpd', async t => {
  const { directory, root, runtime, runtimes, prompt } = await setup(t, noOptions);
  const orphan = await createTask(root, { title: 'Half done' }, 'user');
  const other = await createTask(root, { title: 'Elsewhere' }, 'user');
  const legacy = await createTask(root, { title: 'Before pids' }, 'user');
  // A process that is gone, and a live one that is not this runtime (the test's parent).
  await startTask(root, orphan.id, { agent: 'peer', assignment: 'crashed', pid: 2 ** 22 + 7, epoch: 'old' }, 'main');
  await startTask(root, other.id, { agent: 'peer', assignment: 'running', pid: process.ppid, epoch: 'other' }, 'main');
  await startTask(root, legacy.id, { agent: 'lead', assignment: 'older' }, 'main');
  git(root, 'branch', 'alp/crashed');

  await runtime.open('root', { cwd: root });
  await prompt('root', 'm1', 'Carry on');
  const [main] = runtimes;
  const digest = main.started[0].params.input[1].text;
  assert.match(digest, new RegExp(`- interrupted: ${orphan.id} P2 Half done ← peer; alpd stopped while it worked, work kept on branch alp/crashed; delegate it again`));
  assert.match(digest, new RegExp(`- interrupted: ${legacy.id} P2 Before pids ← lead; alpd stopped while it worked; delegate it again`));
  assert.match(digest, new RegExp(`- in progress: ${other.id} P2 Elsewhere ← peer`));
  assert.equal((await getTask(root, orphan.id)).status, 'open');
  assert.equal((await getTask(root, other.id)).status, 'in_progress');
  await until(async () => (await readFile(path.join(directory, 'runs', 'root.jsonl'), 'utf8').catch(() => '')).includes('"action":"orphaned"'));

  // Its own assignments carry its pid and epoch, so a later alpd can tell.
  const fresh = await createTask(root, { title: 'Fresh' }, 'user');
  await main.call('alp_delegate', { agent: 'peer', task: 'Do it', taskId: fresh.id, wait: false });
  const assignee = (await getTask(root, fresh.id)).assignee;
  assert.equal(assignee.pid, process.pid);
  assert.equal(typeof assignee.epoch, 'string');
});

test('alp_recall forks a finished assignment read-only and returns its answer', async t => {
  const { root, runtime, runtimes, prompt } = await setup(t, directory => ({ recallFile: path.join(directory, 'home', 'state', 'recall.json'), settings: { defaultAgent: 'main', workflow: { mode: 'cafe' } } }));
  await runtime.open('root', { cwd: root });
  await prompt('root', 'm1', 'Fix it');
  const [main] = runtimes;
  assert.ok(main.config.dynamicTools.some(tool => tool.name === 'alp_recall'));
  assert.match(main.config.developerInstructions, /ask it with alp_recall/);
  assert.equal(main.config.ephemeral, true);

  const task = await createTask(root, { title: 'Fix the parser' }, 'user');
  const started = await main.call('alp_delegate', { agent: 'lead', task: 'Fix the parser', taskId: task.id, wait: false });
  await until(() => runtimes[1]?.started.length === 1);
  const lead = runtimes[1];
  // An assignment's native thread is kept so it can be recalled.
  assert.equal(lead.config.ephemeral, false);
  assert.match((await main.call('alp_recall', { assignmentId: started.assignmentId, question: 'Why?' })).error, /still running; ask it with alp_send/);
  // Lead gets the tool too, but only for assignments in its own line.
  assert.ok(lead.config.dynamicTools.some(tool => tool.name === 'alp_recall'));
  assert.match((await lead.call('alp_recall', { taskId: task.id, question: 'Why?' })).error, /Only main recalls by task/);
  await lead.call('alp_handoff', { outcome: 'complete', summary: 'Rewrote the tokenizer' });
  lead.finish('Done');
  await main.call('alp_wait', {});

  assert.match((await main.call('alp_recall', { question: 'Why?' })).error, /either assignmentId or taskId/);
  assert.match((await main.call('alp_recall', { assignmentId: 'nope', question: 'Why?' })).error, /No recallable assignment nope of yours; assignments stay recallable for 14 days/);

  const asking = main.call('alp_recall', { taskId: task.id, question: 'Why rewrite the tokenizer instead of patching it?' });
  await until(() => runtimes.length === 3 && runtimes[2].started.length === 1);
  const recalled = runtimes[2];
  const fork = recalled.calls.find(call => call.method === 'thread/fork').params;
  assert.deepEqual([fork.threadId, fork.sandbox, fork.approvalPolicy, fork.ephemeral, fork.cwd], [lead.threadId, 'read-only', 'never', true, root]);
  assert.equal(recalled.calls.some(call => call.method === 'thread/start'), false);
  const turn = recalled.started[0].params;
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.match(turn.input[0].text, /^ALP recall: main asks about the assignment you finished[\s\S]*Question: Why rewrite the tokenizer instead of patching it\?$/);
  // The fork cannot use ALP tools or get approvals.
  assert.match(JSON.parse((await recalled.serverRequest('item/tool/call', { tool: 'alp_delegate', arguments: {} })).contentItems[0].text).error, /unavailable in a recall/);
  assert.deepEqual(await recalled.serverRequest('item/commandExecution/requestApproval', { command: 'rm -rf /' }), { decision: 'decline' });
  recalled.finish('Patching kept the quadratic scan; the rewrite made it linear.');
  const answer = await asking;
  assert.deepEqual([answer.assignmentId, answer.agent, answer.taskId, answer.answer], [started.assignmentId, 'lead', task.id, 'Patching kept the quadratic scan; the rewrite made it linear.']);
  assert.equal(recalled.closed, true);

  // The user asks the same way through the runtime.
  const byUser = runtime.recall({ assignmentId: started.assignmentId }, 'What did you leave out?');
  await until(() => runtimes.length === 4 && runtimes[3].started.length === 1);
  assert.match(runtimes[3].started[0].params.input[0].text, /^ALP recall: The user asks/);
  runtimes[3].finish('The error messages.');
  assert.equal((await byUser).answer, 'The error messages.');
  await assert.rejects(runtime.recall({ taskId: 't-ffff', projectRoot: root }, 'Why?'), /No recallable assignment worked on t-ffff/);
  main.finish('Fixed');
});

test('a recall that runs into a failed fork reports the error', async t => {
  const { root, runtime, runtimes, prompt } = await setup(t, noOptions);
  await runtime.open('root', { cwd: root });
  await prompt('root', 'm1', 'Look');
  const [main] = runtimes;
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Advise', mode: 'read-only', wait: false });
  await until(() => runtimes[1]?.started.length === 1);
  await runtimes[1].call('alp_handoff', { outcome: 'complete', summary: 'Use a map' });
  runtimes[1].finish('Advice');
  await main.call('alp_wait', {});
  const asking = main.call('alp_recall', { assignmentId, question: 'Why a map?' });
  await until(() => runtimes[2]?.started.length === 1);
  runtimes[2].notification('turn/completed', { threadId: runtimes[2].threadId, turn: { id: runtimes[2].turnId, status: 'failed', error: { message: 'thread not found' } } });
  assert.deepEqual(await asking, { assignmentId, error: 'thread not found' });
  main.finish('Done');
});

test('threads past their recall time are deleted when the runtime starts', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-recall-expire-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const file = path.join(directory, 'recall.json');
  const entry = (id, days, runtime = 'codex') => ({ assignmentId: id, rootId: 'r', requesters: ['r'], agent: 'peer', project: directory, runtime, threadId: `thread-${id}`, cwd: directory, model: 'm', status: 'completed', finishedAt: new Date(Date.now() - days * 86_400_000).toISOString() });
  await writeFile(file, JSON.stringify([entry('old', 20), entry('older', 30, 'claude'), entry('new', 1), { broken: true }]));
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), supervisor: false, recallFile: file });
  t.after(() => runtime.shutdown());
  await until(() => runtimes.length === 2 && runtimes.every(harness => harness.closed));
  assert.deepEqual(runtimes.map(harness => [harness.kind, harness.calls.map(call => `${call.method} ${call.params.threadId}`)]).sort(), [['claude', ['thread/delete thread-older']], ['codex', ['thread/delete thread-old']]]);
  await until(async () => JSON.parse(await readFile(file, 'utf8')).length === 1);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).map(kept => kept.assignmentId), ['new']);
});
