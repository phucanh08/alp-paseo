// Opt-in: real model calls through alpd. Main runs two writing peers in parallel, each in
// its own git worktree, then merges both changes into the project checkout.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';

const model = process.env.ALP_TEST_MODEL ?? 'codex:gpt-5.6-sol';
const home = await mkdtemp(path.join(tmpdir(), 'alp-worktree-e2e-'));
const env = { ...process.env, ALP_HOME: home, ALP_RUN_LOG_DIR: path.join(home, 'runs') };
const cli = (...args) => spawnSync(process.execPath, ['src/cli.js', ...args], { env, encoding: 'utf8' });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const root = path.resolve('.alp-test', `worktree-${Date.now()}`);
await initProject(root);
await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'smart', maxPeers: 2 } }));
await writeFile(path.join(root, '.alp/agents/peer/AGENT.md'), 'For this integration assignment, create exactly the one file named in your task, in your working directory, with exactly the content given, using a single shell command. Do not change any other file and do not use git. Then call alp_handoff with outcome complete and the file path in scope.');
git(root, 'init', '--quiet', '-b', 'main');
git(root, 'add', '-A');
git(root, '-c', 'user.name=ALP test', '-c', 'user.email=alp@localhost', 'commit', '--quiet', '-m', 'init');

const tokens = { 'alpha.txt': `ALPHA_${randomUUID()}`, 'beta.txt': `BETA_${randomUUID()}` };
const task = file => `Create the file ${file} containing exactly ${tokens[file]} followed by a newline.`;
const prompt = [
  'Integration check of parallel writers. Do not create or edit any file yourself, and do not use shell commands.',
  'Call alp_delegate twice, both with agent peer, mode workspace-write, isolation worktree and wait false,',
  `first with task "${task('alpha.txt')}", then with task "${task('beta.txt')}".`,
  'Then call alp_wait until both results have arrived. Then call alp_merge once for each assignmentId.',
  'Finally report each merge status.',
].join(' ');

try {
  assert.equal(cli('daemon', 'start').status, 0);
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', 'run', '--json', '--project', root, '--mode', 'workspace-write', '--model', model, '--thinking', 'low', prompt], { env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGINT'); reject(new Error('alp run timed out')); }, 600_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`alp run exited ${code}: ${stderr}`)); });
  });
  const envelopes = output.trim().split('\n').map(line => JSON.parse(line));
  const main = envelopes.find(e => e.event.type === 'session.opened' && !e.event.session.parentId).sessionId;
  const log = (await readFile(path.join(home, 'runs', `${main}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const started = log.filter(entry => entry.event === 'assignment.started');
  const firstFinished = log.findIndex(entry => entry.event === 'assignment.finished');
  const merged = log.filter(entry => entry.event === 'worktree.merged');
  const files = Object.fromEntries(await Promise.all(Object.keys(tokens).map(async file => [file, await readFile(path.join(root, file), 'utf8').catch(() => null)])));
  const final = envelopes.filter(e => e.sessionId === main && e.event.type === 'item' && e.event.item.kind === 'assistant_message').at(-1)?.event.item.text ?? '';
  const evidence = {
    project: root, model, tokens, files,
    assignments: started.map(entry => ({ id: entry.assignmentId, isolation: entry.isolation, task: entry.task })),
    bothStartedBeforeAnyFinished: started.length === 2 && log.indexOf(started[1]) < firstFinished,
    merged: merged.map(entry => ({ assignmentId: entry.assignmentId, status: entry.status, files: entry.files })),
    branches: git(root, 'branch', '--list', 'alp/*'),
    worktrees: await readdir(path.join(home, 'worktrees')).catch(() => []),
    status: git(root, 'status', '--porcelain'),
    final,
  };
  await writeFile('.alp-test/worktree-e2e.json', JSON.stringify({ ...evidence, log }, null, 2));
  console.log(JSON.stringify(evidence));
  assert.equal(started.length, 2);
  assert.ok(started.every(entry => entry.isolation === 'worktree'));
  assert.ok(evidence.bothStartedBeforeAnyFinished, 'both writers ran at the same time');
  for (const [file, token] of Object.entries(tokens)) assert.equal(files[file]?.trim(), token, `${file} merged into the checkout`);
  assert.equal(merged.length, 2);
  assert.ok(merged.every(entry => entry.status === 'applied'));
  assert.equal(evidence.branches, '', 'merged branches are deleted');
  assert.deepEqual(evidence.worktrees, []);
  console.log(JSON.stringify({ passed: true, evidence: '.alp-test/worktree-e2e.json' }));
} finally {
  cli('daemon', 'stop');
  await rm(home, { recursive: true, force: true });
}
