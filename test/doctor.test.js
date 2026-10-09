import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { diagnose, repair } from '../src/client/doctor.js';
import { bootTime } from '../src/client/index.js';

async function fakeBin(directory, name, body) {
  const file = path.join(directory, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
}

const byId = (checks, id) => checks.filter(check => check.id === id);

test('doctor reports runtimes, settings, agents and leftovers, and --fix repairs only what is safe', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-doctor-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const home = path.join(directory, 'home');
  const bin = path.join(directory, 'bin');
  await mkdir(path.join(home, 'state'), { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await mkdir(bin);
  await fakeBin(bin, 'codex', 'case "$1" in --version) echo "codex-cli 9.9.9";; login) echo "Not logged in"; exit 1;; esac');
  await fakeBin(bin, 'claude', 'case "$1" in --version) echo "9.9.9 (Claude Code)";; auth) echo \'{"loggedIn": true}\';; esac');
  const env = { PATH: bin };

  // A project with a typo in its settings, a merged branch, an unmerged one, and one in use.
  const project = path.join(directory, 'project');
  await initProject(project);
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'pipe' }).toString();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base');
  git('branch', 'alp/merged');
  git('checkout', '-q', '-b', 'alp/kept');
  await writeFile(path.join(project, 'work.txt'), 'work');
  git('add', 'work.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'work');
  git('checkout', '-q', 'main');
  git('branch', 'alp/waiting');
  git('worktree', 'add', '-q', path.join(directory, 'gone-tree'), '-b', 'alp/tree');
  await rm(path.join(directory, 'gone-tree'), { recursive: true });
  const settingsFile = path.join(project, '.alp', 'settings.json');
  await writeFile(settingsFile, JSON.stringify({ ...JSON.parse(await readFile(settingsFile, 'utf8')), workfow: {} }));

  // Leftovers in ALP_HOME: a dead alpd's lock, an open file, a skill the library lacks,
  // and interrupted work in a project that is gone.
  await writeFile(path.join(home, 'alpd.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, bootTime: bootTime(), socket: path.join(home, 'alpd.sock') }), { mode: 0o600 });
  await writeFile(path.join(home, 'state', 'recall.json'), '[]', { mode: 0o644 });
  await chmod(path.join(home, 'state', 'recall.json'), 0o644);
  await writeFile(path.join(home, 'role-skills.json'), JSON.stringify({ main: ['missing-skill'] }), { mode: 0o600 });
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ limits: { autoResume: 'yes' } }), { mode: 0o600 });
  const live = [
    { assignmentId: 'a-gone', agent: 'peer', project: path.join(directory, 'nowhere') },
    { assignmentId: 'a-here', agent: 'peer', project, worktree: { branch: 'alp/waiting' } },
  ];
  await writeFile(path.join(home, 'state', 'live.json'), JSON.stringify(live), { mode: 0o600 });

  const checks = await diagnose({ home, project, env, sandbox: false });
  const status = id => byId(checks, id).map(check => check.status);
  assert.deepEqual(status('codex'), ['fail']);
  assert.match(byId(checks, 'codex')[0].summary, /codex-cli 9\.9\.9 .* not logged in; run codex login/);
  assert.deepEqual(status('claude'), ['ok']);
  assert.deepEqual(status('alpd'), ['warn']);
  assert.deepEqual(status('sandbox'), ['warn']);
  assert.deepEqual(status('permissions'), ['warn']);
  assert.deepEqual(byId(checks, 'permissions')[0].details, [`0644 ${path.join(home, 'state', 'recall.json')}`]);
  assert.deepEqual(status('user settings'), ['fail']);
  assert.match(byId(checks, 'user settings')[0].summary, /limits\.autoResume must be true or false/);
  assert.deepEqual(status('skills'), ['warn']);
  assert.deepEqual(status('live work'), ['warn']);
  assert.deepEqual(byId(checks, 'live work')[0].details, [`peer a-gone in ${path.join(directory, 'nowhere')}`]);
  assert.deepEqual(status('settings'), ['fail']);
  assert.match(byId(checks, 'settings')[0].summary, /workfow.*workflow/);
  assert.deepEqual(status('worktrees'), ['warn']);
  assert.deepEqual(byId(checks, 'branches').map(check => [check.status, check.details]), [['warn', ['alp/merged']], ['info', ['alp/kept']]]);

  const fixed = await repair(checks);
  assert.deepEqual(fixed.map(item => item.id), ['alpd', 'permissions', 'live work', 'worktrees', 'branches']);
  assert.equal((await stat(path.join(home, 'state', 'recall.json'))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path.join(home, 'state', 'live.json'), 'utf8')).map(entry => entry.assignmentId), ['a-here']);
  assert.equal(git('for-each-ref', '--format=%(refname:short)', 'refs/heads/alp/').trim().split('\n').sort().join(' '), 'alp/kept alp/tree alp/waiting');
  assert.doesNotMatch(git('worktree', 'list'), /gone-tree/);

  const after = await diagnose({ home, project, env, sandbox: false });
  for (const id of ['alpd', 'permissions', 'live work', 'worktrees']) assert.ok(byId(after, id).every(check => check.status !== 'warn'), id);
  // alp/tree lost its worktree to the prune and is merged now; the next --fix takes it.
  assert.deepEqual(byId(after, 'branches').map(check => [check.status, check.details]), [['warn', ['alp/tree']], ['info', ['alp/kept']]]);
});

test('doctor fails without any runtime and passes a clean setup', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-doctor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o700);
  const none = await diagnose({ home, env: { PATH: path.join(directory, 'empty') } });
  assert.deepEqual(none.filter(check => check.status !== 'ok').map(check => [check.id, check.status]), [['codex', 'fail'], ['claude', 'fail']]);

  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  await fakeBin(bin, 'codex', 'echo "codex-cli 1.0.0"');
  const project = path.join(directory, 'project');
  await initProject(project);
  const checks = await diagnose({ home, project, env: { PATH: bin }, sandbox: true });
  // Claude missing is fine while Codex works.
  assert.deepEqual(checks.filter(check => check.status !== 'ok').map(check => [check.id, check.status]), [['claude', 'warn']]);
  assert.match(checks.find(check => check.id === 'agents').summary, /agents resolve: .*main/);
});

test('alp doctor --json prints the checks and exits 0 when nothing fails', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-doctor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o700);
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  await fakeBin(bin, 'codex', 'echo "codex-cli 1.0.0"');
  await fakeBin(bin, 'claude', 'case "$1" in --version) echo "1.0.0 (Claude Code)";; *) echo \'{"loggedIn": true}\';; esac');
  const project = path.join(directory, 'project');
  await initProject(project);
  const output = execFileSync(process.execPath, [path.resolve('src/cli.js'), 'doctor', '--json', '--project', project], {
    env: { ...process.env, ALP_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ALP_CODEX_BIN: '', ALP_CLAUDE_BIN: '' },
  }).toString();
  const report = JSON.parse(output);
  assert.equal(report.project, project);
  assert.deepEqual(report.fixed, []);
  assert.ok(report.checks.some(check => check.id === 'agents' && check.status === 'ok'));
  assert.ok(report.checks.every(check => check.status !== 'fail'), JSON.stringify(report.checks));
});
