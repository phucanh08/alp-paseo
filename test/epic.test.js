import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../src/core/init.js';
import { closeTask, createTask, epicReport, landedParents, loadTasks, recordVerification, startTask, submitTask, taskDigest } from '../src/core/tasks.js';
import { createAlpRuntime } from '../dist/runtime/index.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function project(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-epic-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await mkdir(path.join(root, '.alp'), { recursive: true });
  return { directory, root };
}

test('an epic whose children are all closed is ready to close, and its report sums up the work', async t => {
  const { root } = await project(t);
  const epic = await createTask(root, { title: 'Auth overhaul', type: 'epic' }, 'user');
  const tokens = await createTask(root, { title: 'Tokens', parent: epic.id }, 'main');
  const sessions = await createTask(root, { title: 'Sessions', parent: epic.id, type: 'feature' }, 'main');
  const cookie = await createTask(root, { title: 'Cookie flags', parent: sessions.id }, 'main');
  const docs = await createTask(root, { title: 'Docs', parent: epic.id }, 'main');

  // Tokens was reworked once, then verified.
  await startTask(root, tokens.id, { agent: 'peer', assignment: 'a1' }, 'main');
  await submitTask(root, tokens.id, { assignment: 'a1', handoff: { outcome: 'complete', summary: 'v1' }, agent: 'peer' }, 'peer');
  await startTask(root, tokens.id, { agent: 'peer', assignment: 'a2' }, 'main');
  await submitTask(root, tokens.id, { assignment: 'a2', handoff: { outcome: 'complete', summary: 'v2' }, agent: 'peer' }, 'peer');
  await recordVerification(root, tokens.id, { passed: true, commands: [{ step: 'test', command: 'npm test', exitCode: 0, ms: 5 }] }, 'alpd');
  await closeTask(root, tokens.id, { summary: 'Rotating tokens, tested' }, 'main');
  await recordVerification(root, cookie.id, { passed: false, commands: [{ step: 'test', command: 'npm test', exitCode: 1, ms: 5 }] }, 'alpd');
  await closeTask(root, cookie.id, { summary: 'Flags set', unverified: 'The failing test needs a browser' }, 'main');

  let { tasks } = await loadTasks(root);
  assert.deepEqual(landedParents(tasks).map(entry => entry.task.id), [sessions.id]);
  let report = epicReport(epic.id, tasks);
  assert.deepEqual([report.status, report.tasks, report.closed, report.reworked, report.verification, report.unverified], ['open', 3, 2, 1, { passed: 1, failed: 1, skipped: 0, none: 1 }, [cookie.id]]);
  assert.match(report.text, new RegExp(`^Progress of epic ${epic.id} "Auth overhaul": 2/3 tasks closed, open for \\d+m, 1 reworked, 1 verified, 1 failed verification, 1 closed unverified\\.`));
  assert.deepEqual(report.lines, [
    `✓ ${tokens.id} Tokens — done: Rotating tokens, tested`,
    `○ ${sessions.id} Sessions (open)`,
    `  ✓ ${cookie.id} Cookie flags — done: Flags set (unverified)`,
    `○ ${docs.id} Docs (open)`,
  ]);
  assert.throws(() => epicReport(docs.id, tasks), /has no child tasks to report/);
  assert.throws(() => epicReport('t-ffff', tasks), /No task t-ffff/);

  await closeTask(root, sessions.id, { summary: 'Sessions done' }, 'main');
  await closeTask(root, docs.id, { reason: 'wontfix', summary: 'Covered by the README' }, 'main');
  ({ tasks } = await loadTasks(root));
  assert.ok(taskDigest(tasks).includes(`- ready to close: ${epic.id} P2 Auth overhaul; all 3 children are closed. Close it with a summary; ALP reports it to the user`));
  await closeTask(root, epic.id, { summary: 'Auth reworked end to end' }, 'main');
  ({ tasks } = await loadTasks(root));
  report = epicReport(epic.id, tasks);
  assert.match(report.text, new RegExp(`^Landed epic ${epic.id} "Auth overhaul": 3/3 tasks closed, took \\d+m, 1 reworked, 1 verified, 1 failed verification, 1 closed unverified\\.\\nAuth reworked end to end\\n✓ ${tokens.id}`));
  assert.ok(report.lines.includes(`✗ ${docs.id} Docs — wontfix: Covered by the README`));
  assert.equal(taskDigest(tasks), '');
});

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

test('main closing the last child is told to close the epic; closing it reports to the user', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-epic-flow-'));
  const root = path.join(directory, 'project');
  const other = path.join(directory, 'other');
  await initProject(root);
  await initProject(other);
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs') });
  t.after(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const events = [];
  runtime.onEvent(envelope => events.push(envelope));
  await runtime.open('root', { cwd: root });
  await runtime.open('elsewhere', { cwd: other });
  const prompt = (id, text) => runtime.prompt('root', { clientMessageId: id, delivery: 'auto', content: [{ type: 'text', text }] });
  await prompt('m1', 'Plan');
  const main = runtimes[0];
  const epic = (await main.call('alp_task', { action: 'create', title: 'Release 0.4', type: 'epic' })).task;
  const first = (await main.call('alp_task', { action: 'create', title: 'Changelog', parent: epic.id })).task;
  const second = (await main.call('alp_task', { action: 'create', title: 'Tag', parent: epic.id })).task;
  const closedFirst = await main.call('alp_task', { action: 'close', id: first.id, summary: 'Written' });
  assert.equal(closedFirst.next, undefined);
  const closedSecond = await main.call('alp_task', { action: 'close', id: second.id, summary: 'Tagged v0.4.0' });
  assert.equal(closedSecond.next, `All 2 children of ${epic.id} "Release 0.4" are closed; close it with a summary, and ALP reports it to the user`);
  main.finish('Done for now');

  await prompt('m2', 'Continue');
  assert.match(main.started[1].params.input[1].text, new RegExp(`- ready to close: ${epic.id} P2 Release 0\\.4; all 2 children are closed`));
  const closed = await main.call('alp_task', { action: 'close', id: epic.id, summary: 'Released 0.4.0' });
  assert.match(closed.report, new RegExp(`^Landed epic ${epic.id} "Release 0\\.4": 2/2 tasks closed, took 1m\\.\\nReleased 0\\.4\\.0\\n✓ ${first.id} Changelog — done: Written\\n✓ ${second.id} Tag — done: Tagged v0\\.4\\.0$`));
  const notices = events.filter(envelope => envelope.event.type === 'item' && envelope.event.item.kind === 'notice');
  // Only the epic's project hears about it.
  assert.deepEqual(notices.map(envelope => [envelope.sessionId, envelope.event.item.level, envelope.event.item.text]), [['root', 'info', closed.report]]);
  await until(async () => (await readFile(path.join(directory, 'runs', 'root.jsonl'), 'utf8').catch(() => '')).includes('"event":"epic.landed"'));
  main.finish('Released');
});

test('alp task report prints an epic, and closing one prints its report', async t => {
  const { directory, root } = await project(t);
  const env = { ...process.env, ALP_HOME: path.join(directory, 'home') };
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
  const epic = await createTask(root, { title: 'Docs pass', type: 'epic' }, 'user');
  const child = await createTask(root, { title: 'README', parent: epic.id }, 'user');
  let result = run('task', 'report', epic.id);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^Progress of epic ${epic.id} "Docs pass": 0/1 tasks closed, open for 1m\\.\\n○ ${child.id} README \\(open\\)\\n$`));
  assert.equal(JSON.parse(run('task', 'report', epic.id, '--json').stdout).tasks, 1);
  run('task', 'close', child.id, '-m', 'Rewritten');
  result = run('task', 'close', epic.id, '-m', 'All docs current');
  assert.match(result.stdout, new RegExp(`\\nLanded epic ${epic.id} "Docs pass": 1/1 tasks closed, took 1m\\.\\nAll docs current\\n✓ ${child.id} README — done: Rewritten\\n$`));
  assert.match(run('task', 'report', child.id).stderr, /has no child tasks to report/);
});
