import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../src/core/init.js';
import { addGate, blockersOf, checkGates, gatesOf, closeTask, compactTasks, createTask, resolveGate, startRefusal, getTask, linkTask, listTasks, loadTasks, readyTasks, releaseTask, reopenTask, startTask, submitTask, taskDigest, updateTask } from '../src/core/tasks.js';
import { createAlpRuntime, claudeToolShapes } from '../dist/runtime/index.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function project(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-tasks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  await mkdir(path.join(root, '.alp'), { recursive: true });
  return { directory, root };
}

const ids = tasks => tasks.map(task => task.id);

test('tasks are JSON files with short hash ids; children of a task get numbered ids', async t => {
  const { root } = await project(t);
  const epic = await createTask(root, { title: 'alp status for scripts', type: 'epic' }, 'user');
  assert.match(epic.id, /^t-[0-9a-f]{4}$/);
  assert.deepEqual([epic.status, epic.priority, epic.rev, epic.createdBy, epic.log[0].event], ['open', 2, 1, 'user', 'created']);
  const first = await createTask(root, { title: 'Normalize the status tree', parent: epic.id, priority: 1, paths: ['./src/cli.js', 'src/cli.js'] }, 'main');
  const second = await createTask(root, { title: 'Add --json', parent: epic.id, blockedBy: [first.id], labels: ['cli'] }, 'main');
  assert.deepEqual([first.id, second.id], [`${epic.id}.1`, `${epic.id}.2`]);
  assert.deepEqual(first.paths, ['src/cli.js']);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.alp/tasks', `${second.id}.json`), 'utf8')).blockedBy, [first.id]);
  assert.equal(await readFile(path.join(root, '.alp/tasks/.gitignore'), 'utf8'), '.lock\n*.tmp\n');
  // Nothing is left behind by a write.
  assert.deepEqual((await readdir(path.join(root, '.alp/tasks'))).sort(), ['.gitignore', `${epic.id}.1.json`, `${epic.id}.2.json`, `${epic.id}.json`].sort());

  await assert.rejects(createTask(root, { title: ' ' }, 'user'), /title must be nonempty/);
  await assert.rejects(createTask(root, { title: 'x', priority: 7 }, 'user'), /priority must be 0/);
  await assert.rejects(createTask(root, { title: 'x', type: 'story' }, 'user'), /type must be one of/);
  await assert.rejects(createTask(root, { title: 'x', paths: ['../elsewhere'] }, 'user'), /outside the project/);
  await assert.rejects(createTask(root, { title: 'x', blockedBy: ['t-ffff'] }, 'user'), /No task t-ffff/);
  await assert.rejects(createTask(root, { title: 'x', parent: epic.id, blockedBy: [epic.id] }, 'user'), /blocked by its parent or ancestor/);
});

test('ready lists open non-epic tasks with nothing open blocking them or their ancestors, most urgent first', async t => {
  const { root } = await project(t);
  const epic = await createTask(root, { title: 'Epic', type: 'epic' }, 'user');
  const normalize = await createTask(root, { title: 'Normalize', parent: epic.id, priority: 1 }, 'user');
  const json = await createTask(root, { title: 'Add --json', parent: epic.id, blockedBy: [normalize.id] }, 'user');
  const docs = await createTask(root, { title: 'Document --json', blockedBy: [json.id], priority: 0 }, 'user');
  const colors = await createTask(root, { title: 'Fix table colors', priority: 3 }, 'user');
  const gate = await createTask(root, { title: 'Release gate', priority: 4 }, 'user');
  let { tasks } = await loadTasks(root);
  assert.deepEqual(ids(readyTasks(tasks)), [normalize.id, colors.id, gate.id]);
  assert.deepEqual(blockersOf(tasks.find(task => task.id === docs.id), tasks), [json.id]);

  // A blocked epic holds back its whole branch.
  await linkTask(root, epic.id, { add: { blockedBy: [gate.id] } }, 'user');
  ({ tasks } = await loadTasks(root));
  assert.deepEqual(ids(readyTasks(tasks)), [colors.id, gate.id]);
  assert.deepEqual(blockersOf(tasks.find(task => task.id === json.id), tasks), [normalize.id, gate.id]);

  await closeTask(root, gate.id, { summary: 'Released' }, 'user');
  await closeTask(root, normalize.id, { reason: 'done', summary: 'Merged' }, 'main');
  ({ tasks } = await loadTasks(root));
  assert.deepEqual(ids(readyTasks(tasks)), [json.id, colors.id]);
  assert.deepEqual(ids(listTasks(tasks)), [docs.id, epic.id, json.id, colors.id]);
  assert.deepEqual(ids(listTasks(tasks, { status: 'closed' })), [normalize.id, gate.id]);
  assert.deepEqual(ids(listTasks(tasks, { all: true })).length, 6);
});

test('links refuse cycles and self references, and removals free the graph', async t => {
  const { root } = await project(t);
  const a = await createTask(root, { title: 'A' }, 'user');
  const b = await createTask(root, { title: 'B', blockedBy: [a.id] }, 'user');
  const c = await createTask(root, { title: 'C', blockedBy: [b.id] }, 'user');
  await assert.rejects(linkTask(root, a.id, { add: { blockedBy: [c.id] } }, 'user'), new RegExp(`cycle \\(each waits on the next\\): ${a.id} → ${c.id} → ${b.id} → ${a.id}`));
  await assert.rejects(linkTask(root, a.id, { add: { blockedBy: [a.id] } }, 'user'), /cannot block itself/);
  await assert.rejects(linkTask(root, a.id, { add: { parent: a.id } }, 'user'), /its own parent/);
  // A parent may not wait on its own child: the child waits on the parent's blockers.
  const epic = await createTask(root, { title: 'Epic', type: 'epic' }, 'user');
  const child = await createTask(root, { title: 'Child', parent: epic.id }, 'user');
  await assert.rejects(linkTask(root, epic.id, { add: { blockedBy: [child.id] } }, 'user'), /cycle/);
  await assert.rejects(linkTask(root, c.id, { add: { parent: b.id } }, 'user'), /blocked by .* which would become its parent/);
  await assert.rejects(linkTask(root, a.id, { add: { owner: 'x' } }, 'user'), /add and remove take blockedBy, related and parent/);

  // Removing the edge first makes the reverse edge legal, in one call.
  const moved = await linkTask(root, b.id, { remove: { blockedBy: [a.id] }, add: { related: [c.id] } }, 'main');
  assert.deepEqual([moved.blockedBy, moved.related, moved.rev], [[], [c.id], 2]);
  assert.deepEqual(moved.log.at(-1).changes, [`-blockedBy ${a.id}`, `+related ${c.id}`]);
  await linkTask(root, a.id, { add: { blockedBy: [c.id] } }, 'user');
  // A link that changes nothing writes nothing.
  assert.equal((await linkTask(root, a.id, { add: { blockedBy: [c.id] } }, 'user')).rev, 2);
  await assert.rejects(linkTask(root, a.id, { remove: { parent: epic.id } }, 'user'), /is not a child of/);
});

test('start takes a ready task once; close and reopen move it through its lifecycle', async t => {
  const { root } = await project(t);
  const blocker = await createTask(root, { title: 'Blocker' }, 'user');
  const task = await createTask(root, { title: 'Work', blockedBy: [blocker.id] }, 'user');
  await assert.rejects(startTask(root, task.id, { agent: 'main' }, 'main'), new RegExp(`blocked by ${blocker.id}`));
  await closeTask(root, blocker.id, {}, 'user');

  // Two starts at once: the lock lets exactly one through.
  const results = await Promise.allSettled([startTask(root, task.id, { agent: 'peer', assignment: 'a1' }, 'main'), startTask(root, task.id, { agent: 'peer', assignment: 'a2' }, 'main')]);
  assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /already in progress with peer/);
  let current = await getTask(root, task.id);
  assert.equal(current.status, 'in_progress');
  assert.equal(current.assignee.agent, 'peer');

  // A writer that read an older rev is refused.
  await assert.rejects(updateTask(root, task.id, { priority: 1 }, 'user', { ifRev: current.rev - 1 }), /changed \(rev \d+, expected \d+\)/);
  current = await updateTask(root, task.id, { priority: 1, note: 'Customer is waiting' }, 'user', { ifRev: current.rev });
  assert.deepEqual(current.log.at(-1), { ...current.log.at(-1), event: 'updated', fields: ['priority'], note: 'Customer is waiting' });
  await assert.rejects(updateTask(root, task.id, { type: 'epic' }, 'user'), /never worked on directly/);

  current = await closeTask(root, task.id, { reason: 'done', summary: 'npm test: 150 passed' }, 'main');
  assert.deepEqual([current.status, current.assignee, current.closed.reason, current.closed.summary], ['closed', null, 'done', 'npm test: 150 passed']);
  await assert.rejects(closeTask(root, task.id, {}, 'main'), /already closed/);
  await assert.rejects(startTask(root, task.id, { agent: 'main' }, 'main'), /closed; reopen it first/);
  current = await reopenTask(root, task.id, { note: 'Fails on Windows' }, 'user');
  assert.deepEqual([current.status, current.closed, current.log.at(-1).from], ['open', null, 'closed']);
  await assert.rejects(reopenTask(root, task.id, {}, 'user'), /already open/);
  await assert.rejects(closeTask(root, task.id, { reason: 'later' }, 'user'), /reason must be one of/);

  const epic = await createTask(root, { title: 'Epic', type: 'epic' }, 'user');
  const child = await createTask(root, { title: 'Child', parent: epic.id }, 'user');
  await assert.rejects(startTask(root, epic.id, { agent: 'main' }, 'main'), /is an epic/);
  await assert.rejects(closeTask(root, epic.id, { reason: 'done' }, 'user'), new RegExp(`open children: ${child.id}`));
  await closeTask(root, epic.id, { reason: 'wontfix' }, 'user');
  await closeTask(root, child.id, { reason: 'wontfix' }, 'user');
  await assert.rejects(reopenTask(root, child.id, {}, 'user'), /reopen the parent first/);
});

test('unreadable task files are reported and skipped, and a stale lock is cleared', async t => {
  const { root } = await project(t);
  const task = await createTask(root, { title: 'Good' }, 'user');
  await writeFile(path.join(root, '.alp/tasks/t-bad0.json'), '{ not json');
  await writeFile(path.join(root, '.alp/tasks/t-0dd1.json'), JSON.stringify({ id: 't-other', title: 'x', status: 'open' }));
  const { tasks, errors } = await loadTasks(root);
  assert.deepEqual(ids(tasks), [task.id]);
  assert.deepEqual(errors.map(error => error.file).sort(), [path.join('.alp/tasks/t-0dd1.json'), path.join('.alp/tasks/t-bad0.json')]);

  const lock = path.join(root, '.alp/tasks/.lock');
  await mkdir(lock);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  assert.equal((await updateTask(root, task.id, { title: 'Still writable' }, 'user')).title, 'Still writable');
  await assert.rejects(readdir(lock), { code: 'ENOENT' });
});

function cli(root, home, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ALP_HOME: home } });
}

test('the CLI adds, links, lists, shows and closes tasks as the user', async t => {
  const { directory, root } = await project(t);
  const home = path.join(directory, 'home');
  const json = (...args) => {
    const result = cli(root, home, ...args, '--json');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const epic = json('task', 'add', 'alp status', 'for scripts', '-t', 'epic');
  assert.equal(epic.title, 'alp status for scripts');
  const first = json('task', 'add', 'Normalize', '-p', '1', '--parent', epic.id, '-l', 'cli', '-l', 'core', '--path', 'src/cli.js');
  const second = json('task', 'add', 'Add --json', '--parent', epic.id, '--after', first.id, '-d', 'Print JSON.');
  assert.deepEqual([first.createdBy, first.labels, second.blockedBy, second.description], ['user', ['cli', 'core'], [first.id], 'Print JSON.']);

  assert.deepEqual(ids(json('tasks', 'ready')), [first.id]);
  const listed = cli(root, home, 'tasks');
  assert.match(listed.stdout, new RegExp(`○ ${second.id.replace('.', '\\.')}\\s+P2 task\\s+open\\s+Add --json  blocked by ${first.id}`));

  const cycle = cli(root, home, 'task', 'dep', 'add', first.id, '--after', second.id);
  assert.equal(cycle.status, 1);
  assert.match(cycle.stderr, /alp: That would make a cycle/);
  assert.match(cli(root, home, 'task', 'close', first.id, '-m', 'Merged').stdout, /Closed \.alp\/tasks\/.*\n● .*closed\s+Normalize/);
  assert.deepEqual(ids(json('tasks', 'ready')), [second.id]);
  assert.equal(json('task', 'edit', second.id, '-p', 'p0', '-m', 'urgent').priority, 0);
  assert.deepEqual(json('task', 'dep', 'rm', second.id, '--after', first.id).blockedBy, []);
  assert.equal(json('task', 'reopen', first.id, '-m', 'Regressed').status, 'open');

  const shown = cli(root, home, 'task', 'show', epic.id);
  assert.match(shown.stdout, /○ t-[0-9a-f]{4}  alp status for scripts\n  epic, P2, open; created by user/);
  assert.match(shown.stdout, /Normalize/);
  assert.equal(json('tasks', '--all').length, 3);
  assert.equal(json('tasks', '--status', 'closed').length, 0);

  const outside = cli(path.dirname(root), home, 'tasks');
  assert.equal(outside.status, 1);
  assert.match(outside.stderr, /is not an ALP project/);
  assert.equal(cli(root, home, 'task', 'add').status, 1);
  assert.equal(cli(root, home, 'task', 'fly', 'x').status, 1);
  assert.equal(cli(root, home, 'tasks', 'later').status, 1);
});

test('concurrent CLI processes take the lock in turn', async t => {
  const { directory, root } = await project(t);
  const home = path.join(directory, 'home');
  const epic = JSON.parse(cli(root, home, 'task', 'add', 'Epic', '-t', 'epic', '--json').stdout);
  const run = n => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'task', 'add', `Child ${n}`, '--parent', epic.id], { cwd: root, env: { ...process.env, ALP_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all([1, 2, 3, 4, 5].map(run));
  const { tasks } = await loadTasks(root);
  assert.deepEqual(tasks.filter(task => task.parent === epic.id).map(task => task.id).sort(), [1, 2, 3, 4, 5].map(n => `${epic.id}.${n}`));
});

// --- alp_task in the runtime ----------------------------------------------------

let calls = 0;
function fakeTransport(runtimes) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      kind, calls: [], threadId: `thread-${index}`, turnId: undefined,
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
      get config() { return this.calls.find(call => call.method === 'thread/start').params; },
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

const tool = (harness, name) => harness.config.dynamicTools.find(candidate => candidate.name === name);

test('main changes tasks with alp_task; assignments and the supervisor only read them', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-task-tool-'));
  const root = path.join(directory, 'project');
  await initProject(root);
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs') });
  // Shut down before removing the directory: the runtime may still be writing logs into it.
  t.after(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2 && runtimes[1].calls.some(call => call.method === 'thread/start'));
  const [main, supervisor] = runtimes;

  const mainTool = tool(main, 'alp_task');
  assert.deepEqual(mainTool.inputSchema.properties.action.enum, ['create', 'update', 'link', 'start', 'close', 'reopen', 'gate', 'clear', 'show', 'list', 'ready']);
  assert.deepEqual(Object.keys(mainTool.inputSchema.properties).sort(), Object.keys(claudeToolShapes.alp_task).sort());
  assert.match(main.config.developerInstructions, /Tasks: the project's task graph lives in \.alp\/tasks[\s\S]*Only you and the user create or change tasks/);
  assert.deepEqual(tool(supervisor, 'alp_task').inputSchema.properties.action.enum, ['show', 'list']);

  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Plan the status work' }] });
  const epic = (await main.call('alp_task', { action: 'create', title: 'alp status for scripts', type: 'epic' })).task;
  const first = (await main.call('alp_task', { action: 'create', title: 'Normalize the tree', parent: epic.id, priority: 1 })).task;
  const second = (await main.call('alp_task', { action: 'create', title: 'Add --json', parent: epic.id, blockedBy: [first.id] })).task;
  assert.deepEqual(second.blockedBy, [first.id]);
  assert.deepEqual((await main.call('alp_task', { action: 'ready' })).tasks.map(task => task.id), [first.id]);
  assert.match((await main.call('alp_task', { action: 'link', id: first.id, add: { blockedBy: [second.id] } })).error, /cycle/);
  assert.match((await main.call('alp_task', { action: 'start', id: second.id })).error, new RegExp(`blocked by ${first.id}`));
  assert.match((await main.call('alp_task', { action: 'close', id: first.id, title: 'x' })).error, /close does not take title/);
  assert.match((await main.call('alp_task', { action: 'show' })).error, /show needs id/);
  const started = await main.call('alp_task', { action: 'start', id: first.id });
  assert.deepEqual([started.task.status, started.task.assignee], ['in_progress', 'main']);
  assert.equal((await main.call('alp_task', { action: 'close', id: first.id, summary: 'npm test passed' })).task.status, 'closed');
  const shown = await main.call('alp_task', { action: 'show', id: epic.id });
  assert.deepEqual(shown.children.map(child => [child.id, child.status]), [[first.id, 'closed'], [second.id, 'open']]);
  assert.equal((await getTask(root, first.id)).assignee, null);
  assert.equal((await getTask(root, epic.id)).createdBy, 'main');

  // A peer reads tasks but cannot create or change them.
  await main.call('alp_delegate', { agent: 'peer', task: 'Look at the tree', wait: false });
  await until(() => runtimes.length === 3 && runtimes[2].started.length === 1);
  const peer = runtimes[2];
  const peerTool = tool(peer, 'alp_task');
  assert.deepEqual(peerTool.inputSchema.properties.action.enum, ['show', 'ready']);
  assert.deepEqual(Object.keys(peerTool.inputSchema.properties).sort(), ['action', 'id', 'limit']);
  assert.match(peer.config.developerInstructions, /Tasks: read the project's task graph with alp_task \(show, ready\)/);
  assert.match((await peer.call('alp_task', { action: 'create', title: 'Mine' })).error, /Only main and the user change tasks; you may show, ready/);
  assert.deepEqual((await peer.call('alp_task', { action: 'ready' })).tasks.map(task => task.id), [second.id]);
  assert.equal((await peer.call('alp_task', { action: 'show', id: second.id })).task.title, 'Add --json');
  peer.call('alp_handoff', { outcome: 'complete', summary: 'Looked' });
  peer.finish('Looked');
  await main.call('alp_wait', {});
  main.finish('Planned the status work');

  // The supervisor's digest shows what main did with tasks.
  await until(() => supervisor.started.length === 1);
  const digest = supervisor.started[0].params.input.at(-1).text;
  assert.match(digest, new RegExp(`main created task ${epic.id} "alp status for scripts" \\(now open\\)`));
  assert.match(digest, new RegExp(`main started task ${first.id.replace('.', '\\.')} "Normalize the tree" \\(now in_progress\\)`));
  assert.match(digest, new RegExp(`main closed task ${first.id.replace('.', '\\.')} "Normalize the tree" \\(now closed\\): npm test passed`));
  assert.equal((await supervisor.call('alp_task', { action: 'list' })).tasks.length, 2);
  assert.match((await supervisor.call('alp_task', { action: 'ready' })).error, /you may show, list/);
});

// --- step 2: tasks in delegation --------------------------------------------------

test('a handoff moves a task to review only while that assignment still holds it', async t => {
  const { root } = await project(t);
  const task = await createTask(root, { title: 'Work' }, 'user');
  await startTask(root, task.id, { agent: 'peer', assignment: 'a1' }, 'main');
  // Another assignment cannot move it.
  assert.equal((await submitTask(root, task.id, { assignment: 'a2', handoff: { outcome: 'complete', summary: 'x' }, agent: 'peer' }, 'peer')).status, 'in_progress');
  let current = await submitTask(root, task.id, { assignment: 'a1', handoff: { outcome: 'complete', summary: 'Done', verification: ['npm test: passed'], discovered: ['Docs are stale'], extra: 'dropped' }, agent: 'peer' }, 'peer');
  assert.equal(current.status, 'review');
  assert.deepEqual({ ...current.handoff, at: undefined }, { outcome: 'complete', summary: 'Done', verification: ['npm test: passed'], discovered: ['Docs are stale'], agent: 'peer', at: undefined });
  assert.equal(current.assignee.agent, 'peer');
  // Rework takes it back from review.
  current = await startTask(root, task.id, { agent: 'peer', assignment: 'a3' }, 'main');
  assert.deepEqual([current.status, current.log.at(-1).event], ['in_progress', 'reworked']);
  current = await releaseTask(root, task.id, { assignment: 'a3', handoff: { outcome: 'blocked', summary: 'Needs a key' }, agent: 'peer', reason: 'handoff blocked' }, 'peer');
  assert.deepEqual([current.status, current.assignee, current.handoff.outcome, current.log.at(-1).reason], ['open', null, 'blocked', 'handoff blocked']);
  // The user closed it meanwhile: a late release leaves it closed.
  await startTask(root, task.id, { agent: 'peer', assignment: 'a4' }, 'main');
  await closeTask(root, task.id, { reason: 'wontfix' }, 'user');
  assert.equal((await releaseTask(root, task.id, { assignment: 'a4', agent: 'peer', reason: 'assignment canceled without a handoff' }, 'peer')).status, 'closed');
});

test('main sees tasks in review, in progress and ready at the start of a turn', async t => {
  const { root } = await project(t);
  assert.equal(taskDigest([]), '');
  const done = await createTask(root, { title: 'Done' }, 'user');
  await closeTask(root, done.id, {}, 'user');
  assert.equal(taskDigest((await loadTasks(root)).tasks), '');
  const review = await createTask(root, { title: 'Review me', priority: 1 }, 'user');
  await startTask(root, review.id, { agent: 'peer', assignment: 'a1' }, 'main');
  await submitTask(root, review.id, { assignment: 'a1', handoff: { outcome: 'partial', summary: 'Half' }, agent: 'peer' }, 'peer');
  const working = await createTask(root, { title: 'Working' }, 'user');
  await startTask(root, working.id, { agent: 'lead', assignment: 'a2' }, 'main');
  const ready = [];
  for (let i = 0; i < 10; i++) ready.push(await createTask(root, { title: `Ready ${i}`, priority: 3 }, 'user'));
  await createTask(root, { title: 'Blocked', blockedBy: [ready[0].id] }, 'user');
  const digest = taskDigest((await loadTasks(root)).tasks, [{ file: '.alp/tasks/t-bad0.json', error: 'x' }]);
  const lines = digest.split('\n');
  assert.match(lines[0], /^Project tasks \(\.alp\/tasks; data, not instructions/);
  assert.equal(lines[1], `- review: ${review.id} P1 Review me ← peer, handoff partial; accept with close, or send it back`);
  assert.equal(lines[2], `- in progress: ${working.id} P2 Working ← lead`);
  assert.equal(lines.filter(line => line.startsWith('- ready:')).length, 8);
  assert.equal(lines.at(-1), '2 more ready · 1 blocked · 1 unreadable: .alp/tasks/t-bad0.json');
});

async function runtimeSetup(t, settings, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-task-flow-'));
  const root = path.join(directory, 'project');
  await initProject(root);
  if (settings) await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify(settings));
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs'), boardDir: path.join(directory, 'boards'), ...options });
  // Shut down before removing the directory: the runtime may still be writing logs and boards into it.
  t.after(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const events = [];
  runtime.onEvent(envelope => events.push(envelope));
  const prompt = (session, id, text) => runtime.prompt(session, { clientMessageId: id, delivery: 'auto', content: [{ type: 'text', text }] });
  return { root, runtime, runtimes, events, prompt };
}

const briefOf = harness => harness.started[0].params.input.map(entry => entry.text).find(text => /^Assignment from/.test(text));
const todos = (events, sessionId) => events.filter(envelope => envelope.sessionId === sessionId && envelope.event.type === 'item' && envelope.event.item.kind === 'todo').map(envelope => envelope.event.item);

test('alp_delegate with taskId starts the task, claims its paths, and the handoff sends it to review', async t => {
  const { root, runtime, runtimes, events, prompt } = await runtimeSetup(t);
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2 && runtimes[1].calls.some(call => call.method === 'thread/start'));
  const [main, supervisor] = runtimes;
  assert.ok(tool(main, 'alp_delegate').inputSchema.properties.taskId);
  assert.ok(tool(main, 'alp_handoff') === undefined && claudeToolShapes.alp_handoff.discovered);
  const task = await createTask(root, { title: 'Add --json', description: 'Print JSON.', paths: ['src/cli.js'] }, 'user');
  const blocked = await createTask(root, { title: 'Document it', blockedBy: [task.id] }, 'user');

  await prompt('root', 'm1', 'Work on the tasks');
  assert.match(main.started[0].params.input[1].text, new RegExp(`^Project tasks[\\s\\S]*- ready: ${task.id} P2 Add --json\\n1 blocked$`));
  assert.match((await main.call('alp_delegate', { agent: 'reviewer', task: 'Check', taskId: task.id })).error, /for advice about a task, name it in the brief/);
  assert.match((await main.call('alp_delegate', { agent: 'peer', task: 'Write', taskId: blocked.id })).error, new RegExp(`blocked by ${task.id}`));
  assert.match((await main.call('alp_delegate', { agent: 'peer', task: 'Write', taskId: 't-ffff' })).error, /No task t-ffff/);

  const delegated = await main.call('alp_delegate', { agent: 'peer', task: 'Implement it and run npm test', taskId: task.id, wait: false });
  await until(() => runtimes.length === 3 && runtimes[2].started.length === 1);
  const peer = runtimes[2];
  assert.match(briefOf(peer), new RegExp(`Task ${task.id} \\(task, P2\\): Add --json\\nPrint JSON\\.\\nPaths: src/cli\\.js \\(ALP claimed them for you on the project board\\)\\nYour handoff moves this task to review[\\s\\S]*Implement it and run npm test`));
  let current = await getTask(root, task.id);
  assert.deepEqual([current.status, current.assignee.agent, current.assignee.assignment], ['in_progress', 'peer', delegated.assignmentId]);
  assert.deepEqual(runtime.status('root').claims.map(pin => [pin.agent, pin.task, pin.paths]), [['peer', task.id, ['src/cli.js']]]);
  assert.match((await main.call('alp_delegate', { agent: 'peer', task: 'Again', taskId: task.id, wait: false })).error, /already in progress with peer/);
  // The peer's own claims carry its task.
  assert.equal((await peer.call('alp_pin', { kind: 'claim', body: 'Tests', paths: ['test/cli.test.js'] })).task, task.id);

  assert.equal((await peer.call('alp_handoff', { outcome: 'complete', summary: 'Added --json', verification: ['npm test: passed'], discovered: ['alp ps has no --json either'] })).recorded, true);
  peer.finish('Done');
  const { events: mail } = await main.call('alp_wait', {});
  assert.deepEqual(mail[0].result.task, { id: task.id, status: 'review', next: 'Verify the handoff, then accept it with alp_task close, or delegate the task again for rework' });
  current = await getTask(root, task.id);
  assert.deepEqual([current.status, current.handoff.agent, current.handoff.discovered], ['review', 'peer', ['alp ps has no --json either']]);
  await until(() => runtime.status('root').claims.length === 0);

  const found = (await main.call('alp_task', { action: 'create', title: 'Add --json to alp ps', discoveredFrom: task.id })).task;
  assert.equal((await main.call('alp_task', { action: 'close', id: task.id, summary: 'Verified the output' })).task.status, 'closed');
  main.finish('Accepted');
  await until(() => todos(events, 'root').length === 1);
  assert.deepEqual(todos(events, 'root')[0].items, [
    { id: task.id, text: `${task.id} · Add --json`, status: 'completed' },
    { id: found.id, text: `${found.id} · Add --json to alp ps`, status: 'pending' },
  ]);

  await until(() => supervisor.started.length === 1);
  const digest = supervisor.started[0].params.input.at(-1).text;
  assert.match(digest, new RegExp(`main delegated task ${task.id} "Add --json" \\(now in_progress\\): to peer`));
  assert.match(digest, new RegExp(`main → peer assignment \\S+ for task ${task.id}`));
  assert.match(digest, new RegExp(`peer submitted task ${task.id} "Add --json" \\(now review\\): handoff complete: Added --json`));
  assert.match(digest, /handoff complete: Added --json; discovered: alp ps has no --json either/);

  // The next turn shows the task list again only when it changed.
  supervisor.finish('sound');
  await prompt('root', 'm2', 'Thanks');
  main.finish('ok');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(todos(events, 'root').length, 1);
});

test('a blocked handoff or an assignment without one opens the task again; rework takes it from review', async t => {
  const { root, runtime, runtimes, prompt } = await runtimeSetup(t, { workflow: { mode: 'pho', maxPeers: 2, supervisor: false } });
  await runtime.open('root', { cwd: root });
  const task = await createTask(root, { title: 'Work' }, 'user');
  await until(() => runtimes.length === 1);
  const [main] = runtimes;
  await prompt('root', 'm1', 'Go');
  const run = async (handoff, expected) => {
    const count = runtimes.length;
    await main.call('alp_delegate', { agent: 'peer', task: 'Do it', taskId: task.id, wait: false });
    await until(() => runtimes.length === count + 1 && runtimes[count].started.length === 1);
    const peer = runtimes[count];
    if (handoff) await peer.call('alp_handoff', handoff);
    peer.finish('end');
    const { events } = await main.call('alp_wait', {});
    assert.equal(events[0].result.task.status, expected);
    return getTask(root, task.id);
  };
  let current = await run({ outcome: 'blocked', summary: 'Needs an API key' }, 'open');
  assert.deepEqual([current.assignee, current.handoff.summary, current.log.at(-1).reason], [null, 'Needs an API key', 'handoff blocked']);
  current = await run(undefined, 'open');
  assert.deepEqual([current.handoff, current.log.at(-1).reason], [null, 'assignment completed without a handoff']);
  current = await run({ outcome: 'partial', summary: 'Half done' }, 'review');
  current = await run({ outcome: 'complete', summary: 'All done' }, 'review');
  assert.deepEqual(current.log.slice(-3).map(entry => entry.event), ['submitted', 'reworked', 'submitted']);
});

test('a task whose paths another tree claimed is not delegated, and only main gives tasks', async t => {
  const { root, runtime, runtimes, prompt } = await runtimeSetup(t, { workflow: { mode: 'cafe', maxPeers: 2, supervisor: false } });
  const task = await createTask(root, { title: 'Edit the CLI', paths: ['src'] }, 'user');
  await runtime.open('other', { cwd: root });
  await until(() => runtimes.length === 1);
  await prompt('other', 'o1', 'Edit');
  assert.equal((await runtimes[0].call('alp_pin', { kind: 'claim', body: 'Refactor', paths: ['src/cli.js'] })).kind, 'claim');

  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  const main = runtimes[1];
  await prompt('root', 'm1', 'Go');
  const refused = await main.call('alp_delegate', { agent: 'lead', task: 'Edit', taskId: task.id });
  assert.match(refused.error, new RegExp(`Another agent has claimed paths of ${task.id}`));
  assert.deepEqual(refused.conflicts.map(conflict => conflict.paths), [['src/cli.js']]);
  assert.equal((await getTask(root, task.id)).status, 'open');

  // Once the claim is gone, lead takes the task; its peer's claims carry the task, and lead cannot give tasks.
  runtimes[0].finish('done');
  await runtime.close('other');
  await until(async () => !(await runtime.board(root)).some(pin => pin.kind === 'claim'));
  await main.call('alp_delegate', { agent: 'lead', task: 'Edit', taskId: task.id, wait: false });
  await until(() => runtimes.length === 3 && runtimes[2].started.length === 1);
  const lead = runtimes[2];
  assert.equal(tool(lead, 'alp_delegate').inputSchema.properties.taskId, undefined);
  assert.match((await lead.call('alp_delegate', { agent: 'peer', task: 'x', taskId: task.id })).error, /Only main gives tasks/);
  void lead.call('alp_delegate', { agent: 'peer', task: 'Edit src/cli.js', mode: 'workspace-write', wait: false });
  await until(() => runtimes.length === 4 && runtimes[3].started.length === 1);
  assert.equal((await runtimes[3].call('alp_pin', { kind: 'claim', body: 'CLI', paths: ['src/cli.js'] })).task, task.id);
});

// --- step 3: gates and compaction -------------------------------------------------

test('gates hold a task, or the children of an epic, back until they clear', async t => {
  const { root } = await project(t);
  const task = await createTask(root, { title: 'Release' }, 'user');
  await assert.rejects(addGate(root, task.id, { kind: 'human' }, 'main'), /note must be nonempty/);
  await assert.rejects(addGate(root, task.id, { kind: 'vote' }, 'main'), /kind must be one of human, timer, gh:pr, gh:run/);
  await assert.rejects(addGate(root, task.id, { kind: 'timer', until: 'soon' }, 'main'), /ISO time, or \+30m/);
  await assert.rejects(addGate(root, task.id, { kind: 'gh:pr', ref: 'pull/12' }, 'main'), /a number, or owner\/repo#number/);
  let current = await addGate(root, task.id, { kind: 'human', note: 'Approve the changelog?' }, 'main');
  current = await addGate(root, task.id, { kind: 'timer', until: '+2h' }, 'main');
  current = await addGate(root, task.id, { kind: 'gh:pr', ref: 'acme/widgets#12' }, 'main');
  assert.deepEqual(current.gates.map(gate => [gate.id, gate.kind, gate.repo ?? null, gate.ref ?? null]), [['g1', 'human', null, null], ['g2', 'timer', null, null], ['g3', 'gh:pr', 'acme/widgets', '12']]);
  assert.ok(Date.parse(current.gates[1].until) - Date.now() > 7_100_000);
  let { tasks } = await loadTasks(root);
  assert.deepEqual(ids(readyTasks(tasks)), []);
  assert.match(startRefusal(tasks[0], tasks), /waits on g1 human: Approve the changelog\?; g2 timer: until .*; g3 gh:pr: acme\/widgets#12/);
  assert.match(taskDigest(tasks), new RegExp(`- waiting on g1 human: Approve the changelog\\?; g2 timer.*: ${task.id} P2 Release`));

  await resolveGate(root, task.id, 'g1', { by: 'user', note: 'Looks right' });
  await assert.rejects(resolveGate(root, task.id, 'g1', { by: 'user' }), /already clear/);
  await resolveGate(root, task.id, 'g2', { by: 'user', remove: true });
  // A timer in the past no longer holds the task.
  await addGate(root, task.id, { kind: 'timer', until: '2020-01-01T00:00:00Z' }, 'main');
  // GitHub gates clear when the pull request merges or the run succeeds.
  await addGate(root, task.id, { kind: 'gh:run', ref: '77' }, 'main');
  const calls = [];
  const gh = async args => {
    calls.push(args);
    if (args[0] === 'pr') return JSON.stringify({ state: 'MERGED' });
    throw new Error('HTTP 404');
  };
  let checked = await checkGates(root, gh);
  assert.deepEqual(calls, [['pr', 'view', '12', '--json', 'state', '-R', 'acme/widgets'], ['run', 'view', '77', '--json', 'status,conclusion']]);
  assert.deepEqual(checked.cleared, [{ task: task.id, gate: 'g3', detail: 'merged' }]);
  assert.deepEqual(checked.errors, [{ task: task.id, gate: 'g5', error: 'HTTP 404' }]);
  checked = await checkGates(root, async () => JSON.stringify({ status: 'in_progress', conclusion: '' }));
  assert.deepEqual(checked.pending, [{ task: task.id, gate: 'g5', detail: 'in_progress' }]);
  await checkGates(root, async () => JSON.stringify({ status: 'completed', conclusion: 'success' }));
  current = await getTask(root, task.id);
  assert.deepEqual(current.gates.map(gate => [gate.id, gate.resolved?.by ?? null]), [['g1', 'user'], ['g3', 'github'], ['g4', null], ['g5', 'github']]);
  ({ tasks } = await loadTasks(root));
  assert.deepEqual(ids(readyTasks(tasks)), [task.id]);

  // An epic's gate holds back its children.
  const epic = await createTask(root, { title: 'Epic', type: 'epic' }, 'user');
  const child = await createTask(root, { title: 'Child', parent: epic.id }, 'user');
  await addGate(root, epic.id, { kind: 'human', note: 'Start the epic?' }, 'main');
  ({ tasks } = await loadTasks(root));
  assert.ok(!ids(readyTasks(tasks)).includes(child.id));
  assert.deepEqual(gatesOf(tasks.find(entry => entry.id === child.id), tasks), [`${epic.id} g1 human: Start the epic?`]);
});


test('compaction shrinks tasks closed long enough ago and keeps how they closed', async t => {
  const { root } = await project(t);
  const old = await createTask(root, { title: 'Old', description: 'x'.repeat(900), labels: ['cli'] }, 'user');
  await startTask(root, old.id, { agent: 'peer', assignment: 'a1' }, 'main');
  await submitTask(root, old.id, { assignment: 'a1', handoff: { outcome: 'complete', summary: 's'.repeat(900), verification: ['npm test'] }, agent: 'peer' }, 'peer');
  for (let i = 0; i < 5; i++) await updateTask(root, old.id, { note: `note ${i}` }, 'main');
  await closeTask(root, old.id, { summary: 'Merged in #12' }, 'main');
  const open = await createTask(root, { title: 'Open', description: 'y'.repeat(900) }, 'user');

  assert.deepEqual(await compactTasks(root, { days: 30 }, 'user'), []);
  const preview = await compactTasks(root, { days: 0, dryRun: true }, 'user');
  assert.deepEqual(preview.map(entry => entry.id), [old.id]);
  assert.ok(preview[0].after < preview[0].before / 2);
  assert.equal((await getTask(root, old.id)).compacted, undefined);

  await compactTasks(root, { days: 0 }, 'user');
  const compacted = await getTask(root, old.id);
  assert.equal(compacted.description.length, 300);
  assert.equal(compacted.handoff.summary.length, 300);
  assert.equal(compacted.handoff.verification, undefined);
  assert.deepEqual(compacted.log.map(entry => entry.event), ['created', 'closed']);
  assert.deepEqual([compacted.title, compacted.labels, compacted.closed.summary, compacted.compacted.by], ['Old', ['cli'], 'Merged in #12', 'user']);
  assert.equal((await getTask(root, open.id)).description.length, 900);
  // Compacted tasks are not compacted again.
  assert.deepEqual(await compactTasks(root, { days: 0 }, 'user'), []);
  await assert.rejects(compactTasks(root, { days: -1 }, 'user'), /days must be/);
});

test('main gates tasks, cannot clear a human gate, and GitHub gates clear at the start of its turn', async t => {
  const calls = [];
  const github = async args => { calls.push(args); return JSON.stringify({ state: 'MERGED' }); };
  const { root, runtime, runtimes, prompt } = await runtimeSetup(t, { workflow: { mode: 'pho', maxPeers: 2, supervisor: false } }, { github });
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 1);
  const [main] = runtimes;
  const task = await createTask(root, { title: 'Deploy' }, 'user');
  await prompt('root', 'm1', 'Plan the deploy');
  assert.equal(calls.length, 0);
  assert.equal((await main.call('alp_task', { action: 'gate', id: task.id, kind: 'human', note: 'Deploy on Friday?' })).task.gates[0], 'g1 human: Deploy on Friday?');
  assert.match((await main.call('alp_task', { action: 'clear', id: task.id, gate: 'g1' })).error, /Only the user clears a human gate/);
  await main.call('alp_task', { action: 'gate', id: task.id, kind: 'gh:pr', ref: '12' });
  assert.equal((await main.call('alp_task', { action: 'gate', id: task.id, kind: 'timer', until: '+1d' })).task.gates.length, 3);
  assert.equal((await main.call('alp_task', { action: 'clear', id: task.id, gate: 'g3', note: 'Not needed' })).task.gates.length, 2);
  main.finish('Planned');
  await resolveGate(root, task.id, 'g1', { by: 'user' });

  await prompt('root', 'm2', 'Go');
  assert.deepEqual(calls, [['pr', 'view', '12', '--json', 'state']]);
  assert.equal((await getTask(root, task.id)).gates[1].resolved.by, 'github');
  assert.match(main.started[1].params.input[1].text, new RegExp(`- ready: ${task.id} P2 Deploy`));
  main.finish('ok');
  // Checked at most once a minute per project.
  await prompt('root', 'm3', 'Again');
  assert.equal(calls.length, 1);
});

test('the CLI adds, lists and clears gates, checks GitHub ones, and compacts', async t => {
  const { directory, root } = await project(t);
  const home = path.join(directory, 'home');
  const fake = path.join(directory, 'gh.mjs');
  await writeFile(fake, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv[2] === "pr" ? { state: "OPEN" } : { status: "completed", conclusion: "success" }));\n', { mode: 0o755 });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ALP_HOME: home, ALP_GH_BIN: fake } });
  const task = JSON.parse(run('task', 'add', 'Release', '--json').stdout);
  assert.match(run('task', 'gate', 'add', task.id, '--human', 'Ship it?').stdout, /⏸ g1 human: Ship it\?/);
  run('task', 'gate', 'add', task.id, '--pr', '12');
  run('task', 'gate', 'add', task.id, '--run', 'acme/w#9');
  assert.match(run('tasks').stdout, /waits on g1 human: Ship it\?; g2 gh:pr: #12; g3 gh:run: acme\/w#9/);
  const gates = run('tasks', 'gates');
  assert.match(gates.stdout, new RegExp(`✓ ${task.id} g3 cleared: completed success`));
  assert.match(gates.stdout, new RegExp(`⏸ ${task.id} g2 gh:pr: #12 \\(open\\)  Release`));
  assert.match(gates.stdout, new RegExp(`⏸ ${task.id} g1 human: Ship it\\?  Release`));
  run('task', 'gate', 'clear', task.id, 'g1', '-m', 'Yes');
  run('task', 'gate', 'rm', task.id, 'g2');
  assert.equal(JSON.parse(run('tasks', 'ready', '--json').stdout)[0].id, task.id);
  assert.match(run('task', 'show', task.id).stdout, /✓ gate g1 human: Ship it\? \(cleared by user: Yes\)\n  ✓ gate g3 gh:run: acme\/w#9 \(cleared by github: completed success\)/);
  assert.equal(run('task', 'gate', 'add', task.id, '--human', 'x', '--pr', '1').status, 1);
  run('task', 'close', task.id);
  assert.match(run('tasks', 'compact', '--days', '0', '--dry-run').stdout, /Would compact 1 closed task/);
  assert.match(run('tasks', 'compact', '--days', '0').stdout, /Compacted 1 closed task/);
  assert.match(run('task', 'show', task.id).stdout, /compacted \d{4}-\d\d-\d\d from \d+ characters/);
});
