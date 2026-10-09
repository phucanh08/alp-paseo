import { spawn } from 'node:child_process';
import { access, chmod, constants, lstat, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { daemonPaths, lockAlive, readLock } from './index.js';
import { jsonObject, discoverAgents, resolveAgent } from '../core/resolver.js';
import { settingsWarnings, validateSettings, validateUserSettings } from '../core/validation.js';

/**
 * `alp doctor` (ALPD §36): checks what ALP needs from this machine and project, and
 * what earlier runs may have left behind. Every check reports one of
 * - ok: nothing to do;
 * - info: worth knowing, nothing is wrong;
 * - warn: something to fix, and ALP still works;
 * - fail: ALP cannot work as configured.
 * A check that `--fix` can repair carries a fix. Fixes only remove what nothing uses
 * (stale locks, merged branches, entries for vanished projects) or tighten modes;
 * they never touch running work or unmerged branches.
 */

/** Runs a command; resolves with its exit code and output, never rejects. */
export function runCommand(command, args, { cwd, env = process.env, timeoutMs = 15_000 } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ code: -1, stdout: '', stderr: error.message }); return; }
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

const firstLine = text => text.trim().split('\n')[0] ?? '';

/** The executable `command` names, as a spawn without a shell would find it. */
async function executable(command, env) {
  const candidates = path.isAbsolute(command) ? [command] : (env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, command));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await lstat(candidate)).isDirectory()) continue; return candidate; } catch {}
  }
  return undefined;
}

/** How to tell whether each native runtime is logged in. */
const RUNTIMES = [
  { kind: 'codex', variable: 'ALP_CODEX_BIN', login: ['login', 'status'], loggedIn: result => result.code === 0, hint: 'codex login' },
  {
    kind: 'claude', variable: 'ALP_CLAUDE_BIN', login: ['auth', 'status'], hint: 'claude auth login',
    loggedIn: result => { try { return JSON.parse(result.stdout).loggedIn === true; } catch { return result.code === 0; } },
  },
];

async function runtimeChecks({ env, run }) {
  const checks = [];
  for (const runtime of RUNTIMES) {
    const command = env[runtime.variable] || runtime.kind;
    const found = await executable(command, env);
    if (!found) {
      checks.push({ id: runtime.kind, status: 'warn', summary: `${command} not found on PATH; ${runtime.kind} agents cannot run (set ${runtime.variable} to its path)` });
      continue;
    }
    const version = await run(found, ['--version'], { env });
    if (version.code !== 0) {
      checks.push({ id: runtime.kind, status: 'fail', summary: `${found} --version failed: ${firstLine(version.stderr || version.stdout) || `exit ${version.code}`}` });
      continue;
    }
    const login = await run(found, runtime.login, { env });
    checks.push(runtime.loggedIn(login)
      ? { id: runtime.kind, status: 'ok', summary: `${firstLine(version.stdout)} at ${found}, logged in` }
      : { id: runtime.kind, status: 'fail', summary: `${firstLine(version.stdout)} at ${found} is not logged in; run ${runtime.hint}` });
  }
  // One runtime is enough; with neither, nothing can run.
  if (checks.every(check => check.status !== 'ok')) for (const check of checks) if (check.status === 'warn') check.status = 'fail';
  return checks;
}

async function daemonCheck(home) {
  const paths = daemonPaths(home);
  const lock = await readLock(home);
  const exists = file => lstat(file).then(() => true, () => false);
  if (lockAlive(lock)) return { id: 'alpd', status: 'ok', summary: `running (pid ${lock.pid}, ${lock.version})${lock.ready ? '' : ', starting'}` };
  const stale = [];
  if (await exists(paths.lock)) stale.push(paths.lock);
  if (await exists(paths.socket)) stale.push(paths.socket);
  const crashed = await exists(path.join(home, 'state', 'alpd.running'));
  const after = crashed ? '; the last alpd stopped unexpectedly, and the next start continues its work' : '';
  if (!stale.length) return { id: 'alpd', status: crashed ? 'info' : 'ok', summary: `not running${after}` };
  return {
    id: 'alpd', status: 'warn', summary: `not running, and left ${stale.map(file => path.basename(file)).join(' and ')} behind${after}`,
    fix: {
      describe: `remove ${stale.join(', ')}`,
      async apply() {
        // Check again: an alpd may have started meanwhile.
        if (lockAlive(await readLock(home))) return 'skipped: alpd started meanwhile';
        for (const file of stale) await unlink(file).catch(() => {});
        return `removed ${stale.length} stale file${stale.length > 1 ? 's' : ''}`;
      },
    },
  };
}

/** Files and directories under ALP_HOME that hold logs, state or settings. */
async function privateEntries(home) {
  const entries = [home];
  for (const name of ['settings.json', 'alpd.lock', 'alpd.json', 'role-skills.json']) entries.push(path.join(home, name));
  for (const directory of ['state', 'runs', 'logs', 'boards', 'worktrees', 'copies']) {
    const full = path.join(home, directory);
    entries.push(full);
    if (directory === 'worktrees' || directory === 'copies') continue;
    for (const name of await readdir(full).catch(() => [])) entries.push(path.join(full, name));
  }
  return entries;
}

async function permissionsCheck(home) {
  const open = [];
  for (const entry of await privateEntries(home)) {
    const info = await lstat(entry).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !(info.mode & 0o077)) continue;
    open.push({ entry, mode: info.mode & 0o777, directory: info.isDirectory() });
  }
  if (!open.length) return { id: 'permissions', status: 'ok', summary: `${home} is private to you` };
  return {
    id: 'permissions', status: 'warn',
    summary: `${open.length} entr${open.length > 1 ? 'ies' : 'y'} under ${home} readable by others; they hold task briefs, results and settings`,
    details: open.map(item => `${item.mode.toString(8).padStart(4, '0')} ${item.entry}`),
    fix: {
      describe: 'remove group and other access from them',
      async apply() {
        for (const item of open) await chmod(item.entry, item.mode & 0o700).catch(() => {});
        return `tightened ${open.length} entr${open.length > 1 ? 'ies' : 'y'}`;
      },
    },
  };
}

async function userSettingsCheck(home) {
  const file = path.join(home, 'settings.json');
  try {
    const text = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (text === undefined) return { id: 'user settings', status: 'ok', summary: `none (${file})` };
    const settings = JSON.parse(text);
    validateUserSettings(settings, file);
    const warnings = settingsWarnings(settings, 'user');
    return warnings.length
      ? { id: 'user settings', status: 'warn', summary: `${file}: ${warnings.length} key${warnings.length > 1 ? 's' : ''} ALP ignores`, details: warnings }
      : { id: 'user settings', status: 'ok', summary: file };
  } catch (error) {
    return { id: 'user settings', status: 'fail', summary: `alpd ignores ${file}: ${error.message.replace(`${file}: `, '')}` };
  }
}

async function projectChecks(project, home) {
  const checks = [];
  const file = path.join(project, '.alp', 'settings.json');
  let settings;
  try {
    settings = await jsonObject(file, 'INVALID_SETTINGS');
    validateSettings(settings, file);
    const warnings = settingsWarnings(settings, 'project');
    checks.push(warnings.length
      ? { id: 'settings', status: 'warn', summary: `${file}: ${warnings.length} key${warnings.length > 1 ? 's' : ''} ALP ignores`, details: warnings }
      : { id: 'settings', status: 'ok', summary: file });
  } catch (error) {
    checks.push({ id: 'settings', status: 'fail', summary: error.message });
    return checks;
  }
  const agents = await discoverAgents(project);
  const broken = [];
  const shadows = [];
  for (const agent of agents) {
    try {
      const resolved = await resolveAgent(project, { agent, library: home });
      for (const skill of resolved.skills) if (!skill.path.startsWith(home + path.sep)) {
        const library = path.join(home, 'skills', skill.name, 'SKILL.md');
        if (await lstat(library).then(() => true, () => false)) shadows.push(`${agent}: ${skill.name} from the project replaces the library's`);
      }
    } catch (error) { broken.push(`${agent}: ${error.message}`); }
  }
  if (!agents.length) checks.push({ id: 'agents', status: 'fail', summary: `no agents under ${path.join(project, '.alp', 'agents')}; run alp init` });
  else if (broken.length) checks.push({ id: 'agents', status: 'fail', summary: `${broken.length} of ${agents.length} agents cannot start`, details: broken });
  else checks.push({ id: 'agents', status: shadows.length ? 'info' : 'ok', summary: `${agents.length} agents resolve: ${agents.join(', ')}`, ...(shadows.length ? { details: shadows } : {}) });
  if (settings.defaultAgent && !agents.includes(settings.defaultAgent)) checks.push({ id: 'agents', status: 'fail', summary: `defaultAgent ${settings.defaultAgent} is not an agent of this project` });
  return checks;
}

async function librarySkillsCheck(home) {
  const file = path.join(home, 'role-skills.json');
  let roles;
  try {
    const text = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (text === undefined) return undefined;
    roles = JSON.parse(text);
  } catch (error) { return { id: 'skills', status: 'fail', summary: `${file}: ${error.message}` }; }
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return { id: 'skills', status: 'fail', summary: `${file}: expected an object of role names to skill lists` };
  const missing = [];
  for (const [role, names] of Object.entries(roles)) {
    if (!Array.isArray(names)) { missing.push(`${role}: not a list`); continue; }
    for (const name of names) {
      if (typeof name !== 'string' || !await lstat(path.join(home, 'skills', name, 'SKILL.md')).then(() => true, () => false)) missing.push(`${role}: ${name}`);
    }
  }
  return missing.length
    ? { id: 'skills', status: 'warn', summary: `${file} lists ${missing.length} skill${missing.length > 1 ? 's' : ''} the library lacks; agents start without them`, details: missing }
    : { id: 'skills', status: 'ok', summary: `the library's skills exist (${file})` };
}

/** The live book alpd continues at start: entries whose project is gone can never continue. */
async function liveCheck(home, running) {
  const file = path.join(home, 'state', 'live.json');
  let entries;
  try { entries = JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; }
  if (!Array.isArray(entries)) return { id: 'live work', status: 'warn', summary: `${file} is not a list; alpd ignores it` };
  const gone = [];
  for (const entry of entries) {
    if (typeof entry?.project !== 'string' || !await lstat(entry.project).then(() => true, () => false)) gone.push(entry);
  }
  if (!gone.length) return { id: 'live work', status: entries.length && !running ? 'info' : 'ok', summary: entries.length ? `${entries.length} assignment${entries.length > 1 ? 's' : ''} ${running ? 'running' : 'waiting for alpd to continue'}` : 'no running assignments' };
  return {
    id: 'live work', status: 'warn',
    summary: `${gone.length} interrupted assignment${gone.length > 1 ? 's' : ''} belong to projects that no longer exist`,
    details: gone.map(entry => `${entry?.agent} ${entry?.assignmentId} in ${entry?.project}`),
    fix: running ? undefined : {
      describe: `drop them from ${file}`,
      async apply() {
        const current = JSON.parse(await readFile(file, 'utf8'));
        const ids = new Set(gone.map(entry => entry?.assignmentId));
        const kept = current.filter(entry => !ids.has(entry?.assignmentId));
        await writeFile(file, JSON.stringify(kept, null, 2) + '\n', { mode: 0o600 });
        return `dropped ${current.length - kept.length}`;
      },
    },
    ...(running ? { hint: 'stop alpd to drop them' } : {}),
  };
}

/** Worktrees git lost track of, and alp/* branches: merged ones are dead weight, unmerged ones hold kept work. */
async function branchCheck(project, home, run) {
  const git = args => run('git', args, { cwd: project });
  const top = await git(['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return [];
  const checks = [];
  const worktrees = (await git(['worktree', 'list', '--porcelain'])).stdout.split('\n\n').filter(Boolean);
  const prunable = worktrees.filter(block => /^prunable/m.test(block)).map(block => block.match(/^worktree (.*)$/m)?.[1]).filter(Boolean);
  if (prunable.length) checks.push({
    id: 'worktrees', status: 'warn', summary: `git still lists ${prunable.length} worktree${prunable.length > 1 ? 's' : ''} that no longer exist`, details: prunable,
    fix: { describe: 'git worktree prune', async apply() { await git(['worktree', 'prune']); return 'pruned'; } },
  });
  const checkedOut = new Set(worktrees.map(block => block.match(/^branch refs\/heads\/(.*)$/m)?.[1]).filter(Boolean));
  let live = [];
  try { live = JSON.parse(await readFile(path.join(home, 'state', 'live.json'), 'utf8')); } catch {}
  const inUse = new Set([...checkedOut, ...(Array.isArray(live) ? live.map(entry => entry?.worktree?.branch).filter(Boolean) : [])]);
  const branches = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/alp/'])).stdout.split('\n').filter(Boolean);
  if (!branches.length) return checks;
  const merged = new Set((await git(['branch', '--format=%(refname:short)', '--merged', 'HEAD', '--list', 'alp/*'])).stdout.split('\n').filter(Boolean));
  const spare = branches.filter(branch => merged.has(branch) && !inUse.has(branch));
  const kept = branches.filter(branch => !merged.has(branch) && !inUse.has(branch));
  if (spare.length) checks.push({
    id: 'branches', status: 'warn', summary: `${spare.length} alp/* branch${spare.length > 1 ? 'es are' : ' is'} already merged into HEAD`, details: spare,
    fix: {
      describe: `delete ${spare.length > 1 ? 'them' : 'it'} with git branch -d`,
      async apply() {
        let deleted = 0;
        for (const branch of spare) if ((await git(['branch', '-d', branch])).code === 0) deleted++;
        return `deleted ${deleted}`;
      },
    },
  });
  if (kept.length) checks.push({ id: 'branches', status: 'info', summary: `${kept.length} alp/* branch${kept.length > 1 ? 'es hold' : ' holds'} unmerged work from finished or interrupted assignments; merge or delete ${kept.length > 1 ? 'them' : 'it'} yourself`, details: kept });
  if (!spare.length && !kept.length) checks.push({ id: 'branches', status: 'ok', summary: `${branches.length} alp/* branch${branches.length > 1 ? 'es' : ''} in use` });
  return checks;
}

/**
 * Runs every check. `project` is an ALP project root or undefined; `sandbox` says whether
 * Claude can sandbox Bash here (undefined when unknown); `daemonEntry` is alpd's path.
 */
export async function diagnose({ home, project, env = process.env, run = runCommand, sandbox, daemonEntry } = {}) {
  const checks = [];
  if (daemonEntry) {
    checks.push(await lstat(daemonEntry).then(() => ({ id: 'build', status: 'ok', summary: daemonEntry }), () => ({ id: 'build', status: 'fail', summary: `alpd is not built (${daemonEntry}); run npm run build` })));
  }
  checks.push(...await runtimeChecks({ env, run }));
  const daemon = await daemonCheck(home);
  checks.push(daemon);
  const running = daemon.status === 'ok' && daemon.summary.startsWith('running');
  if (sandbox !== undefined) checks.push(sandbox
    ? { id: 'sandbox', status: 'ok', summary: 'Claude sessions run Bash in an OS sandbox that holds their mode' }
    : { id: 'sandbox', status: 'warn', summary: `no Bash sandbox for Claude (${process.platform === 'linux' ? 'install bubblewrap and socat' : 'Seatbelt is missing'}): read-only Claude agents rely on their permission rules alone, and review copies on Claude cannot start` });
  checks.push(await permissionsCheck(home));
  checks.push(await userSettingsCheck(home));
  const skills = await librarySkillsCheck(home);
  if (skills) checks.push(skills);
  const live = await liveCheck(home, running);
  if (live) checks.push(live);
  if (project) {
    checks.push(...await projectChecks(project, home));
    checks.push(...await branchCheck(project, home, run));
  }
  return checks;
}

/** Applies the fixes of the given checks in order; returns what each did. */
export async function repair(checks) {
  const done = [];
  for (const check of checks) {
    if (!check.fix) continue;
    try { done.push({ id: check.id, result: await check.fix.apply() }); }
    catch (error) { done.push({ id: check.id, result: `failed: ${error.message}` }); }
  }
  return done;
}
