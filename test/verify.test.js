import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../src/core/init.js';
import { closeTask, createTask, getTask, loadTasks, recordVerification, startTask, submitTask, summarize, taskDigest } from '../src/core/tasks.js';
import { describeVerification, runVerify, validateVerify, verifyConfig } from '../src/core/verify.js';
import { validateSettings } from '../src/core/validation.js';
import { createAlpRuntime } from '../dist/runtime/index.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
const exists = file => lstat(file).then(() => true, () => false);

async function directory(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

test('verify settings are checked, and the steps run in order until one fails', async t => {
  assert.equal(validateVerify(undefined, 's'), undefined);
  assert.deepEqual(validateVerify({ test: ' npm test ' }, 's'), { test: 'npm test', timeoutSec: 600 });
  assert.throws(() => validateVerify({}, 's'), /verify needs at least one of setup, typecheck, test/);
  assert.throws(() => validateVerify({ test: 'x', lint: 'y' }, 's'), /unsupported verify field 'lint'/);
  assert.throws(() => validateVerify({ test: '' }, 's'), /verify.test must be a command/);
  assert.throws(() => validateVerify({ test: 'x', timeoutSec: 0 }, 's'), /timeoutSec must be 1 to 7200/);
  assert.throws(() => validateSettings({ verify: [] }, '.alp/settings.json'), /\.alp\/settings\.json: verify must be an object/);

  const dir = await directory(t, 'alp-verify-run-');
  const passing = await runVerify(dir, { setup: 'echo setting up > setup.txt', test: 'echo ok', timeoutSec: 30 });
  assert.equal(passing.passed, true);
  assert.deepEqual(passing.commands.map(command => [command.step, command.exitCode]), [['setup', 0], ['test', 0]]);
  assert.equal(await readFile(path.join(dir, 'setup.txt'), 'utf8'), 'setting up\n');
  assert.equal(describeVerification(passing), 'verified (setup, test)');

  const failing = await runVerify(dir, { typecheck: 'echo type error >&2; exit 3', test: 'echo never > never.txt', timeoutSec: 30 });
  assert.deepEqual([failing.passed, failing.commands.length, failing.commands[0].exitCode, failing.commands[0].output], [false, 1, 3, 'type error\n']);
  assert.equal(await exists(path.join(dir, 'never.txt')), false);
  assert.equal(describeVerification(failing), 'verification failed: typecheck exited 3');

  const slow = await runVerify(dir, { test: 'sleep 5', timeoutSec: 1 });
  assert.deepEqual([slow.passed, slow.commands[0].exitCode, slow.commands[0].timedOut], [false, 124, true]);
  assert.equal(describeVerification(slow), 'verification failed: test timed out');
  assert.ok(slow.commands[0].ms < 4000);
});

test('a failed verification on a task blocks an agent from closing it as done', async t => {
  const root = path.join(await directory(t, 'alp-verify-task-'), 'project');
  await mkdir(path.join(root, '.alp'), { recursive: true });
  const task = await createTask(root, { title: 'Parser' }, 'user');
  await startTask(root, task.id, { agent: 'peer', assignment: 'a1' }, 'main');
  await submitTask(root, task.id, { assignment: 'a1', handoff: { outcome: 'complete', summary: 'Done' }, agent: 'peer' }, 'peer');
  await recordVerification(root, task.id, { passed: false, where: 'worktree', commands: [{ step: 'test', command: 'npm test', exitCode: 1, ms: 20, output: 'x'.repeat(3000) }] }, 'alpd');
  let current = await getTask(root, task.id);
  assert.deepEqual([current.verified.passed, current.verified.where, current.verified.commands[0].output.length, current.log.at(-1).event], [false, 'worktree', 1000, 'verified']);
  assert.equal(summarize(current, [current]).verified, 'failed');
  assert.match(taskDigest([current]), new RegExp(`- review: ${task.id} P2 Parser ← peer, handoff complete, verification failed: test exited 1; accept with close`));

  await assert.rejects(closeTask(root, task.id, { summary: 'Looks fine' }, 'main'), /last verification failed: test exited 1; fix it and verify again, or close it with unverified/);
  // Other reasons need no verification.
  current = await closeTask(root, task.id, { reason: 'wontfix' }, 'main');
  assert.equal(current.status, 'closed');

  const second = await createTask(root, { title: 'Lexer' }, 'user');
  await recordVerification(root, second.id, { passed: false, commands: [{ step: 'test', command: 'npm test', exitCode: 1, ms: 1 }] }, 'alpd');
  current = await closeTask(root, second.id, { summary: 'Shipped', unverified: 'The failing test is the flaky network one, tracked in t-77e0' }, 'main');
  assert.equal(current.closed.unverified, 'The failing test is the flaky network one, tracked in t-77e0');
  const third = await createTask(root, { title: 'Docs' }, 'user');
  await recordVerification(root, third.id, { passed: false, commands: [{ step: 'test', command: 'npm test', exitCode: 2, ms: 1 }] }, 'alpd');
  // The user may always close; the failed verification is noted.
  assert.equal((await closeTask(root, third.id, {}, 'user')).closed.unverified, 'the user closed it after verification failed: test exited 2');
  const fourth = await createTask(root, { title: 'Skipped' }, 'user');
  await recordVerification(root, fourth.id, { passed: false, skipped: 'Docs only' }, 'main');
  assert.equal(describeVerification((await getTask(root, fourth.id)).verified), 'verification skipped: Docs only');
  assert.equal((await closeTask(root, fourth.id, {}, 'main')).status, 'closed');
});

// --- the runtime -------------------------------------------------------------------

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
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}

// check.js fails while bad.txt exists, and needs the project's node_modules.
const CHECK = "require('dep'); if (require('fs').existsSync('bad.txt')) { console.error('bad.txt is not allowed'); process.exit(1); } console.log('ok');\n";

async function setup(t, verify = { test: 'node check.js' }) {
  const dir = await directory(t, 'alp-verify-flow-');
  const root = path.join(dir, 'project');
  await initProject(root);
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'pho', maxPeers: 2, supervisor: false }, ...(verify ? { verify } : {}) }));
  await writeFile(path.join(root, 'check.js'), CHECK);
  await writeFile(path.join(root, '.gitignore'), 'node_modules\n');
  await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
  git(root, 'init', '--quiet', '-b', 'main');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init');
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), supervisor: false, worktreeDir: path.join(dir, 'worktrees'), libraryDir: path.join(dir, 'home'), runLogDir: path.join(dir, 'runs'), boardDir: path.join(dir, 'boards') });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Work' }] });
  return { dir, root, runtime, runtimes, main: runtimes[0] };
}

/** Delegates to a peer, lets `work` change files in its cwd, and finishes it with a complete handoff. */
async function delegate(runtimes, main, args, work) {
  const started = await main.call('alp_delegate', { agent: 'peer', task: 'Change it', mode: 'workspace-write', wait: false, ...args });
  assert.ok(started.assignmentId, JSON.stringify(started));
  await until(() => runtimes.at(-1).started.length === 1 && runtimes.length > 1);
  const peer = runtimes.at(-1);
  await work(peer.cwd, peer);
  await peer.call('alp_handoff', { outcome: 'complete', summary: 'Changed it' });
  peer.finish('Done');
  const { events } = await main.call('alp_wait', { assignments: [started.assignmentId] });
  return { id: started.assignmentId, peer, result: events[0].result };
}

test('alp_merge verifies a worktree change first; continueFrom fixes it in a worktree that keeps it', async t => {
  const { root, runtimes, main } = await setup(t);
  assert.ok(main.config.dynamicTools.some(tool => tool.name === 'alp_verify'));
  assert.ok(main.config.dynamicTools.find(tool => tool.name === 'alp_merge').inputSchema.properties.skipVerify);
  assert.match(main.config.developerInstructions, /ALP runs them before alp_merge applies a change[\s\S]*continueFrom/);
  const task = await createTask(root, { title: 'Add the feature' }, 'user');

  const first = await delegate(runtimes, main, { isolation: 'worktree', taskId: task.id }, async cwd => {
    await writeFile(path.join(cwd, 'feature.txt'), 'v1\n');
    await writeFile(path.join(cwd, 'bad.txt'), 'oops\n');
  });
  assert.equal(first.result.task.status, 'review');
  const refused = await main.call('alp_merge', { assignmentId: first.id });
  assert.match(refused.error, /^verification failed: test exited 1 in the assignment's worktree; nothing was applied$/);
  assert.equal(refused.verification.passed, false);
  assert.match(refused.verification.output, /bad\.txt is not allowed/);
  assert.match(refused.next, new RegExp(`continueFrom "${first.id}" and taskId ${task.id}`));
  assert.equal(await exists(path.join(root, 'feature.txt')), false);
  // The project's node_modules was lent to the worktree only for the run.
  assert.equal(await exists(path.join(first.peer.cwd, 'node_modules')), false);
  await until(async () => (await getTask(root, task.id)).verified?.passed === false);
  assert.match((await main.call('alp_task', { action: 'close', id: task.id, summary: 'Looks done' })).error, /verification failed: test exited 1; fix it and verify again/);

  assert.match((await main.call('alp_delegate', { agent: 'peer', task: 'Fix', mode: 'workspace-write', continueFrom: 'nope' })).error, /continueFrom names a finished worktree assignment/);
  const second = await delegate(runtimes, main, { continueFrom: first.id, taskId: task.id }, async cwd => {
    // The earlier change is there to build on.
    assert.equal(await readFile(path.join(cwd, 'feature.txt'), 'utf8'), 'v1\n');
    await rm(path.join(cwd, 'bad.txt'));
    await writeFile(path.join(cwd, 'feature.txt'), 'v2\n');
  });
  const brief = second.peer.started[0].params.input.map(entry => entry.text).find(text => text.startsWith('Assignment from'));
  assert.match(brief, new RegExp(`Your worktree starts from the change of peer's assignment ${first.id}[\\s\\S]*verification failed: test exited 1, running \`node check.js\`[\\s\\S]*bad\\.txt is not allowed`));
  assert.equal(git(root, 'branch', '--list', `alp/${first.id}`), '');
  assert.match((await main.call('alp_merge', { assignmentId: first.id })).error, /No unmerged worktree change/);

  const merged = await main.call('alp_merge', { assignmentId: second.id });
  assert.deepEqual([merged.status, merged.files.sort(), merged.verification.passed], ['applied', ['feature.txt'], true]);
  assert.equal(await readFile(path.join(root, 'feature.txt'), 'utf8'), 'v2\n');
  assert.equal(await exists(path.join(root, 'bad.txt')), false);
  await until(async () => (await getTask(root, task.id)).verified?.passed === true);
  assert.equal((await main.call('alp_task', { action: 'close', id: task.id, summary: 'Verified' })).task.status, 'closed');
  main.finish('Done');
});

test('a checkout that changed meanwhile is verified again after the merge; skipVerify is recorded', async t => {
  const { root, runtimes, main } = await setup(t);
  const task = await createTask(root, { title: 'Two changes' }, 'user');
  const done = await delegate(runtimes, main, { isolation: 'worktree', taskId: task.id }, async cwd => {
    await writeFile(path.join(cwd, 'feature.txt'), 'ok\n');
  });
  // Meanwhile the requester's checkout gained a file the check rejects.
  await writeFile(path.join(root, 'bad.txt'), 'local\n');
  const merged = await main.call('alp_merge', { assignmentId: done.id });
  assert.equal(merged.status, 'applied');
  assert.equal(merged.verification.passed, false);
  assert.equal(merged.verifiedIn, 'your checkout, which changed since the assignment started');
  assert.match(merged.next, /passed in its worktree but verification failed: test exited 1 in your checkout/);
  await until(async () => (await getTask(root, task.id)).verified?.where === 'checkout');
  await rm(path.join(root, 'bad.txt'));

  const verified = await main.call('alp_verify', { taskId: task.id });
  assert.deepEqual([verified.passed, verified.summary, verified.recordedOn], [true, 'verified (test)', task.id]);
  await until(async () => (await getTask(root, task.id)).verified?.passed === true);

  const other = await createTask(root, { title: 'Docs' }, 'user');
  const docs = await delegate(runtimes, main, { isolation: 'worktree', taskId: other.id }, async cwd => {
    await writeFile(path.join(cwd, 'bad.txt'), 'allowed this time\n');
  });
  assert.match((await main.call('alp_merge', { assignmentId: docs.id, skipVerify: '' })).error, /skipVerify, when given, says why/);
  const skipped = await main.call('alp_merge', { assignmentId: docs.id, skipVerify: 'Fixture file for the next task' });
  assert.deepEqual([skipped.status, skipped.verification], ['applied', { skipped: 'Fixture file for the next task' }]);
  assert.equal((await getTask(root, other.id)).verified.skipped, 'Fixture file for the next task');
  main.finish('Done');
});

test('a writer in the shared checkout is verified when it changed something', async t => {
  const { root, runtimes, main } = await setup(t);
  const task = await createTask(root, { title: 'Shared' }, 'user');
  const changed = await delegate(runtimes, main, { taskId: task.id }, async cwd => {
    assert.equal(cwd, root);
    await writeFile(path.join(cwd, 'bad.txt'), 'x\n');
  });
  assert.equal(changed.result.verification.passed, false);
  assert.match(changed.result.verification.output, /bad\.txt is not allowed/);
  await until(async () => (await getTask(root, task.id)).verified?.passed === false);
  await rm(path.join(root, 'bad.txt'));
  const untouched = await delegate(runtimes, main, {}, async () => {});
  assert.equal(untouched.result.verification, undefined);
  main.finish('Done');
});

test('alp_verify needs verify settings; only main records on a task', async t => {
  const { runtimes, main } = await setup(t, null);
  assert.match((await main.call('alp_verify', {})).error, /no verify commands/);
  assert.match((await main.call('alp_verify', { taskId: 't-ffff' })).error, /no verify commands/);
  assert.equal(runtimes.length, 1);
  main.finish('Done');
});

test('alp verify runs the commands in the project and records them on a task', async t => {
  const root = path.join(await directory(t, 'alp-verify-cli-'), 'project');
  await mkdir(path.join(root, '.alp'), { recursive: true });
  const env = { ...process.env, ALP_HOME: path.join(root, '..', 'home') };
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
  assert.match(run('verify').stderr, /has no verify commands/);
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ verify: { test: 'node -e "process.exit(require(\'fs\').existsSync(\'bad.txt\') ? 1 : 0)"' } }));
  assert.equal((await verifyConfig(root)).timeoutSec, 600);
  const task = await createTask(root, { title: 'CLI' }, 'user');
  let result = run('verify', '--task', task.id);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`✓ test: node -e[\\s\\S]*verified \\(test\\); recorded on ${task.id}`));
  await writeFile(path.join(root, 'bad.txt'), '');
  result = run('verify', '--json');
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).passed, false);
  result = run('task', 'show', task.id);
  assert.match(result.stdout, /✓ verified \(test\) in the checkout/);
  assert.equal((await loadTasks(root)).tasks[0].verified.by, 'user');
});
