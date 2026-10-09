import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { createAlpRuntime, reclaimWorktrees } from '../dist/runtime/index.js';

async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}

/** Fake native harnesses that remember the directory they were started in. */
function fakeTransport(runtimes) {
  return cwd => {
    const index = runtimes.length;
    const runtime = {
      cwd, calls: [], threadId: `thread-${index}`, turnId: `turn-${index}`,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() {},
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') return { turn: { id: this.turnId } };
        return {};
      },
      async call(tool, args, callId) {
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

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

async function setup(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-worktree-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['peer'] }, workflow: { maxPeers: 3 } }));
  await writeFile(path.join(project, 'shared.txt'), 'one\ntwo\nthree\n');
  git(project, 'init', '--quiet', '-b', 'main');
  git(project, 'add', '-A');
  git(project, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init');
  const runtimes = [];
  const worktreeDir = path.join(directory, 'worktrees');
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), worktreeDir, runLogDir: path.join(directory, 'runs') });
  t.after(() => runtime.shutdown());
  const open = async (id) => {
    await runtime.open(id, { cwd: project, mode: 'workspace-write', persist: true });
    const harness = runtimes.at(-1);
    await runtime.prompt(id, { clientMessageId: `${id}-1`, delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
    return harness;
  };
  const branches = () => git(project, 'branch', '--list', 'alp/*');
  return { directory, project, runtime, runtimes, worktreeDir, open, branches };
}

const isolated = (task, extra = {}) => ({ agent: 'peer', task, mode: 'workspace-write', isolation: 'worktree', wait: false, ...extra });

/** Collects results from alp_wait until `count` arrive. */
async function results(harness, count) {
  const collected = [];
  for (let call = 0; collected.length < count; call++) {
    const { events } = await harness.call('alp_wait', { timeoutMs: 2000 }, `wait-${call}-${Date.now()}`);
    collected.push(...events.filter(event => event.kind === 'result').map(event => event.result));
  }
  return collected;
}

test('writing peers run in parallel worktrees and their changes merge into the checkout', async t => {
  const { project, runtimes, worktreeDir, open, branches } = await setup(t);
  // Uncommitted work of the requester is part of the peers' starting point.
  await writeFile(path.join(project, 'shared.txt'), 'one\ntwo\nthree\nfour\n');
  const main = await open('root');
  const first = await main.call('alp_delegate', isolated('Write a.txt'), 'd1');
  const second = await main.call('alp_delegate', isolated('Write b.txt'), 'd2');
  assert.equal(first.status, 'running', JSON.stringify(first));
  assert.equal(second.status, 'running', JSON.stringify(second));
  await until(() => runtimes.length === 3);
  const [, a, b] = runtimes;
  for (const peer of [a, b]) {
    assert.ok(peer.cwd.startsWith(worktreeDir), `${peer.cwd} is a worktree`);
    assert.equal(await readFile(path.join(peer.cwd, 'shared.txt'), 'utf8'), 'one\ntwo\nthree\nfour\n');
  }
  assert.notEqual(a.cwd, b.cwd);
  assert.equal(a.calls.find(c => c.method === 'turn/start').params.sandboxPolicy.writableRoots[0], a.cwd);
  await writeFile(path.join(a.cwd, 'a.txt'), 'from a\n');
  await writeFile(path.join(b.cwd, 'b.txt'), 'from b\n');
  a.finish();
  b.finish();
  const done = await results(main, 2);
  for (const result of done) {
    assert.equal(result.status, 'completed');
    assert.equal(result.worktree.files.length, 1, JSON.stringify(result.worktree));
    assert.match(result.worktree.branch, /^alp\//);
  }
  assert.equal(existsSync(path.join(project, 'a.txt')), false, 'nothing reaches the checkout before a merge');
  // Models may merge in parallel, and repeat a call; each change applies once.
  const merges = await Promise.all([
    ...done.map(result => main.call('alp_merge', { assignmentId: result.sessionId }, `merge-${result.sessionId}`)),
    main.call('alp_merge', { assignmentId: done[0].sessionId }, 'merge-again'),
  ]);
  assert.deepEqual(merges.slice(0, 2).map(merged => merged.status), ['applied', 'applied'], JSON.stringify(merges));
  assert.match(merges[2].error, /No unmerged worktree change/);
  assert.equal(await readFile(path.join(project, 'a.txt'), 'utf8'), 'from a\n');
  assert.equal(await readFile(path.join(project, 'b.txt'), 'utf8'), 'from b\n');
  assert.equal(await readFile(path.join(project, 'shared.txt'), 'utf8'), 'one\ntwo\nthree\nfour\n');
  assert.equal(branches(), '');
  assert.deepEqual(await readdir(worktreeDir), []);
});

test('a conflicting change is applied with markers and keeps its branch; discard deletes one', async t => {
  const { project, runtimes, open, branches } = await setup(t);
  const main = await open('root');
  await main.call('alp_delegate', isolated('Edit line two'), 'd1');
  await main.call('alp_delegate', isolated('Write c.txt'), 'd2');
  await until(() => runtimes.length === 3);
  const [, editor, writer] = runtimes;
  await writeFile(path.join(editor.cwd, 'shared.txt'), 'one\nTWO from peer\nthree\n');
  await writeFile(path.join(writer.cwd, 'c.txt'), 'c\n');
  // Meanwhile the requester changes the same line.
  await writeFile(path.join(project, 'shared.txt'), 'one\nTWO from main\nthree\n');
  editor.finish();
  writer.finish();
  const done = await results(main, 2);
  const edit = done.find(result => result.worktree.files.includes('shared.txt'));
  const extra = done.find(result => result !== edit);
  const merged = await main.call('alp_merge', { assignmentId: edit.sessionId }, 'merge');
  assert.equal(merged.status, 'conflicts', JSON.stringify(merged));
  assert.deepEqual(merged.conflicts, ['shared.txt']);
  assert.match(await readFile(path.join(project, 'shared.txt'), 'utf8'), /<<<<<<<[\s\S]*TWO from peer[\s\S]*>>>>>>>/);
  assert.match(branches(), new RegExp(edit.worktree.branch));
  const discarded = await main.call('alp_discard', { assignmentId: extra.sessionId }, 'discard');
  assert.equal(discarded.discarded, extra.sessionId);
  assert.doesNotMatch(branches(), new RegExp(extra.worktree.branch));
  assert.equal(existsSync(path.join(project, 'c.txt')), false);
  const again = await main.call('alp_merge', { assignmentId: extra.sessionId }, 'merge-again');
  assert.match(again.error, /No unmerged worktree change/);
});

test('worktrees are for writers, and only isolated or read-only peers run beside others', async t => {
  const { runtimes, open } = await setup(t);
  const main = await open('root');
  const readOnly = await main.call('alp_delegate', isolated('Look', { mode: 'read-only' }), 'd0');
  assert.match(readOnly.error, /Worktree isolation is for writing assignments/);
  await main.call('alp_delegate', { agent: 'peer', task: 'Write here', mode: 'workspace-write', wait: false }, 'd1');
  const beside = await main.call('alp_delegate', isolated('Write there'), 'd2');
  assert.match(beside.error, /already running/);
  await until(() => runtimes.length === 2);
});

test('one shared-checkout writer at a time across trees; a worktree writer is not blocked', async t => {
  const { runtimes, open } = await setup(t);
  const first = await open('first');
  const second = await open('second');
  const writer = await first.call('alp_delegate', { agent: 'peer', task: 'Write', mode: 'workspace-write', wait: false }, 'd1');
  assert.equal(writer.status, 'running');
  const blocked = await second.call('alp_delegate', { agent: 'peer', task: 'Write too', mode: 'workspace-write', wait: false }, 'd2');
  assert.match(blocked.error, /peer in another session is writing .*isolation "worktree"/);
  const isolatedWriter = await second.call('alp_delegate', isolated('Write apart'), 'd3');
  assert.equal(isolatedWriter.status, 'running', JSON.stringify(isolatedWriter));
  await until(() => runtimes.length === 4);
  runtimes[2].finish();
  await results(first, 1);
  const now = await second.call('alp_delegate', { agent: 'peer', task: 'Write now', mode: 'workspace-write', wait: false }, 'd4');
  assert.match(now.error, /already running/, 'the lease is free; only its own running assignment blocks it');
});

test('unmerged work stays on its branch when the requester closes, and after a crash', async t => {
  const { project, runtime, runtimes, worktreeDir, open, branches } = await setup(t);
  const main = await open('root');
  await main.call('alp_delegate', isolated('Write d.txt'), 'd1');
  await until(() => runtimes.length === 2);
  await writeFile(path.join(runtimes[1].cwd, 'd.txt'), 'd\n');
  runtimes[1].finish();
  const [result] = await results(main, 1);
  await runtime.close('root');
  assert.match(branches(), new RegExp(result.worktree.branch));
  assert.deepEqual(await readdir(worktreeDir), []);
  assert.equal(git(project, 'show', `${result.worktree.branch}:d.txt`), 'd');

  // A worktree a crash left behind: its work is committed to its branch and the directory removed.
  git(project, 'worktree', 'add', '--quiet', '-b', 'alp/crashed', path.join(worktreeDir, 'crashed'));
  await writeFile(path.join(worktreeDir, 'crashed', 'e.txt'), 'e\n');
  assert.deepEqual(await reclaimWorktrees(worktreeDir), ['alp/crashed']);
  assert.deepEqual(await readdir(worktreeDir), []);
  assert.equal(git(project, 'show', 'alp/crashed:e.txt'), 'e');
});

test('worktree isolation outside git fails clearly', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-nogit-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await initProject(directory);
  await writeFile(path.join(directory, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['peer'] } }));
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), worktreeDir: path.join(directory, '.wt') });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: directory, mode: 'workspace-write' });
  await runtime.prompt('root', { clientMessageId: 'm', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
  const result = await runtimes[0].call('alp_delegate', isolated('Write'), 'd1');
  assert.match(result.error, /needs a git repository/);
});
