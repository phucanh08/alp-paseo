import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { createTask, getTask } from '../src/core/tasks.js';
import { saveEntry } from '../src/core/library-edit.js';
import { isTrusted, trustProject } from '../src/core/trust.js';
import { renderLog } from '../src/client/render.js';
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
async function until(check, what = 'Expected condition') {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${what} did not arrive`);
}
const exists = file => readFile(file).then(() => true, () => false);
// A hook appends a whole line; wait for its end, not just the file.
const written = file => readFile(file, 'utf8').then(text => text.endsWith('\n'), () => false);

async function setup(t, { git: repository = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-hooks-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  await initProject(root);
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'pho', supervisor: false } }));
  if (repository) {
    await writeFile(path.join(root, '.gitignore'), 'out/\n');
    git(root, 'init', '--quiet', '-b', 'main');
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init');
  }
  const runtimes = [];
  const runLogDir = path.join(dir, 'runs');
  const start = () => {
    const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), supervisor: false, worktreeDir: path.join(dir, 'worktrees'), libraryDir: home, runLogDir, boardDir: path.join(dir, 'boards') });
    t.after(() => runtime.shutdown());
    return runtime;
  };
  const log = async () => {
    const lines = [];
    for (const file of await readdir(runLogDir).catch(() => [])) lines.push(...(await readFile(path.join(runLogDir, file), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    return lines;
  };
  return { dir, root, home, runtimes, start, log, scope: { root, library: home } };
}
// A hook that records its event, agent and payload in out/<name>.jsonl.
const recorder = (event, name, extra = {}) => ({ hook: { event, command: `mkdir -p "$ALP_PROJECT/out" && { printf '%s %s %s ' "$ALP_EVENT" "$ALP_AGENT" "$ALP_TASK"; cat; } >> "$ALP_PROJECT/out/${name}.log"`, ...extra } });

test('library hooks run at session.start and turn.end with the event on stdin and ALP variables', async t => {
  const { root, home, runtimes, start, log, scope } = await setup(t);
  await saveEntry('hooks', 'started', recorder('session.start', 'started'), { ...scope, scope: 'library' });
  await saveEntry('hooks', 'ended', recorder('turn.end', 'ended'), { ...scope, scope: 'library' });
  await saveEntry('agents', 'main', { instructions: '# Main\n', config: { hooks: ['started', 'ended'] } }, { ...scope, scope: 'library' });
  const runtime = start();
  await runtime.open('root', { cwd: root });
  await until(() => written(path.join(root, 'out/started.log')), 'session.start hook');
  const line = await readFile(path.join(root, 'out/started.log'), 'utf8');
  assert.match(line, /^session\.start main {2}\{/);
  const payload = JSON.parse(line.slice(line.indexOf('{')));
  assert.deepEqual([payload.event, payload.agent, payload.session, payload.project, payload.team, payload.resumed], ['session.start', 'main', 'root', root, 'pho', false]);
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
  runtimes[0].finish('Done');
  await until(() => written(path.join(root, 'out/ended.log')), 'turn.end hook');
  assert.match(await readFile(path.join(root, 'out/ended.log'), 'utf8'), /^turn\.end main {2}\{.*"turn":\{"id":"turn-0-1","state":"completed"\}/);
  await until(async () => (await log()).filter(entry => entry.event === 'hook').length === 2, 'hook log entries');
  const entries = (await log()).filter(entry => entry.event === 'hook');
  assert.deepEqual(entries.map(entry => [entry.on, entry.hook, entry.exitCode]).sort(), [['session.start', 'started', 0], ['turn.end', 'ended', 0]]);
  assert.match(renderLog('root', entries).join('\n'), /↪ main's turn\.end hook ended exit 0/);
  // Library hooks never ask: nothing was trusted, and no question was asked.
  assert.equal(await isTrusted(home, root), false);
  assert.deepEqual(runtime.questions(), []);
});

test('a project hook asks the user once per workspace; after they agree it runs, now and in later sessions', async t => {
  const { root, home, runtimes, start, log, scope } = await setup(t);
  await saveEntry('hooks', 'ended', recorder('turn.end', 'ended'), { ...scope, scope: 'project' });
  await saveEntry('agents', 'main', { instructions: '# Main\n', config: { hooks: ['ended'] } }, { ...scope, scope: 'project' });
  let runtime = start();
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
  runtimes[0].finish('Done');
  await until(() => runtime.questions().length === 1, 'the trust question');
  const [question] = runtime.questions();
  assert.match(question.body, /This project's hooks run shell commands from .* on your machine: ended \(turn\.end: mkdir/);
  assert.deepEqual(question.options, ['Trust this workspace', 'Not now']);
  assert.equal(await exists(path.join(root, 'out/ended.log')), false);
  runtime.answer(question.id, { text: 'Trust this workspace' });
  await until(() => exists(path.join(root, 'out/ended.log')), 'the hook after trust');
  assert.equal(await isTrusted(home, root), true);
  assert.ok((await log()).some(entry => entry.event === 'hook.trust' && entry.trusted));
  // Later sessions, and hooks added or changed later, do not ask again.
  await saveEntry('hooks', 'started', recorder('session.start', 'started'), { ...scope, scope: 'project' });
  const main = await import('../src/core/library-edit.js').then(edit => edit.getEntry('agents', 'main', { ...scope, scope: 'project' }));
  await saveEntry('agents', 'main', { ...main.content, config: { hooks: ['ended', 'started'] } }, { ...scope, scope: 'project', revision: main.revision });
  await runtime.shutdown();
  runtime = start();
  await runtime.open('second', { cwd: root });
  await until(() => exists(path.join(root, 'out/started.log')), 'the new hook in a later session');
  assert.deepEqual(runtime.questions(), []);
});

test('until the user trusts the workspace, its hooks are skipped and a blocking one does not block', async t => {
  const { root, runtimes, start, log, scope } = await setup(t);
  await saveEntry('hooks', 'never', { hook: { event: 'task.close', command: 'exit 1', blocking: true } }, { ...scope, scope: 'project' });
  await saveEntry('agents', 'main', { instructions: '# Main\n', config: { hooks: ['never'] } }, { ...scope, scope: 'project' });
  const runtime = start();
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
  const task = await createTask(root, { title: 'Small' }, 'user');
  const closing = runtimes[0].call('alp_task', { action: 'close', id: task.id, reason: 'done', summary: 'Done' });
  await until(() => runtime.questions().length === 1, 'the trust question');
  runtime.answer(runtime.questions()[0].id, { text: 'Not now' });
  assert.equal((await closing).task.status, 'closed');
  await until(async () => (await log()).some(entry => entry.event === 'hook' && entry.skipped === 'untrusted'), 'the skipped hook');
  // Not now holds for this session's tree: it is not asked again here.
  const second = await createTask(root, { title: 'Another' }, 'user');
  assert.equal((await runtimes[0].call('alp_task', { action: 'close', id: second.id, reason: 'done', summary: 'Done' })).task.status, 'closed');
  assert.deepEqual(runtime.questions(), []);
});

test('blocking hooks refuse a handoff, a task close and a merge, with their output as the reason', async t => {
  const { root, home, runtimes, start, log, scope } = await setup(t, { git: true });
  await trustProject(home, root, 'test');
  // Each passes once out/ok-<event> exists.
  const gate = (event, name) => ({ hook: { event, command: `test -f "$ALP_PROJECT/out/ok-${name}" || { echo "${name}: tests failed" >&2; exit 1; }`, blocking: true, timeoutSec: 30 } });
  await saveEntry('hooks', 'handoff-gate', gate('handoff', 'handoff'), { ...scope, scope: 'project' });
  await saveEntry('hooks', 'close-gate', gate('task.close', 'close'), { ...scope, scope: 'project' });
  await saveEntry('hooks', 'merge-gate', gate('merge', 'merge'), { ...scope, scope: 'project' });
  await saveEntry('hooks', 'labeled', { hook: { event: 'task.close', command: 'exit 1', blocking: true, match: { label: 'release' } } }, { ...scope, scope: 'project' });
  await saveEntry('agents', 'main', { instructions: '# Main\n', config: { hooks: ['close-gate', 'merge-gate', 'labeled'] } }, { ...scope, scope: 'project' });
  await saveEntry('agents', 'peer', { instructions: '# Peer\n', config: { hooks: ['handoff-gate'] } }, { ...scope, scope: 'project' });
  const runtime = start();
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Work' }] });
  const main = runtimes[0];

  const task = await createTask(root, { title: 'Feature' }, 'user');
  const started = await main.call('alp_delegate', { agent: 'peer', task: 'Change it', mode: 'workspace-write', isolation: 'worktree', wait: false, taskId: task.id });
  assert.ok(started.assignmentId, JSON.stringify(started));
  await until(() => runtimes.length > 1 && runtimes.at(-1).started.length === 1, 'the peer');
  const peer = runtimes.at(-1);
  await writeFile(path.join(peer.cwd, 'feature.txt'), 'new\n');
  const refused = await peer.call('alp_handoff', { outcome: 'complete', summary: 'Changed it' });
  assert.match(refused.error, /^A handoff hook refused it:\nhandoff-gate exited 1:\nhandoff: tests failed$/);
  assert.equal(refused.next, 'Fix what it reports, then call alp_handoff again.');
  await mkdir(path.join(root, 'out'), { recursive: true });
  await writeFile(path.join(root, 'out', 'ok-handoff'), '');
  assert.equal((await peer.call('alp_handoff', { outcome: 'complete', summary: 'Changed it' })).recorded, true);
  peer.finish('Done');
  await main.call('alp_wait', { assignments: [started.assignmentId] });

  const merge = await main.call('alp_merge', { assignmentId: started.assignmentId });
  assert.match(merge.error, /^A merge hook refused it; nothing was applied:\nmerge-gate exited 1:\nmerge: tests failed$/);
  assert.equal(await exists(path.join(root, 'feature.txt')), false);
  await writeFile(path.join(root, 'out', 'ok-merge'), '');
  assert.equal((await main.call('alp_merge', { assignmentId: started.assignmentId })).status, 'applied');
  assert.equal(await readFile(path.join(root, 'feature.txt'), 'utf8'), 'new\n');

  const close = await main.call('alp_task', { action: 'close', id: task.id, reason: 'done', summary: 'Merged' });
  assert.match(close.error, /A task\.close hook refused to close .*: close-gate exited 1:\nclose: tests failed/);
  assert.equal((await getTask(root, task.id)).status, 'review');
  await writeFile(path.join(root, 'out', 'ok-close'), '');
  assert.equal((await main.call('alp_task', { action: 'close', id: task.id, reason: 'done', summary: 'Merged' })).task.status, 'closed');
  // A hook limited to a label runs only for tasks with it.
  const release = await createTask(root, { title: 'Release', labels: ['release'] }, 'user');
  assert.match((await main.call('alp_task', { action: 'close', id: release.id, reason: 'done', summary: 'Out' })).error, /labeled exited 1/);
  // The run log is written in the background.
  const blocked = async () => (await log()).filter(entry => entry.event === 'hook' && entry.blocked).map(entry => entry.on);
  await until(async () => (await blocked()).length === 4, 'four refusals in the run log');
  assert.deepEqual(await blocked(), ['handoff', 'merge', 'task.close', 'task.close']);
  assert.match(renderLog('root', (await log()).filter(entry => entry.event === 'hook')).join('\n'), /⛔ peer's handoff hook handoff-gate exit 1 in .*, refused it: handoff: tests failed/);
});
