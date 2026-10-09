import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Phase C isolation (plans/reference/ALPD.md §16): a writing assignment may run in its
 * own git worktree, so writers do not share a checkout. Its work is committed to a
 * branch when it ends, and the requester merges the change into its checkout or
 * discards it. Branches outlive their worktrees, so work is never deleted silently.
 */

export type Worktree = {
  /** The requester's checkout, which receives the change on merge. */
  checkout: string;
  /** The worktree's top level, and the assignment's working directory inside it. */
  path: string;
  workdir: string;
  branch: string;
  /** The requester's state when the assignment started: HEAD plus uncommitted tracked changes. */
  base: string;
  /** checkoutFingerprint of the requester's checkout then, to tell whether it changed since. */
  fingerprint?: string;
};

export type WorktreeChange = { commit: string; files: string[]; stat: string };

type GitResult = { code: number; stdout: string; stderr: string };

/** Commits made for ALP never run the project's hooks and need no user identity. */
const IDENTITY = ['-c', 'user.name=ALP', '-c', 'user.email=alp@localhost', '-c', 'commit.gpgsign=false'];

/**
 * Variables git sets for its hooks and aliases, which would point ALP's git
 * commands at another repository, index or configuration (ALPD §32).
 */
const GIT_CONTEXT = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX', 'GIT_NAMESPACE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS',
  'GIT_SHALLOW_FILE', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
];

/** The environment ALP runs git in: the caller's, without git's own context, and never prompting. */
export function gitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(clean)) {
    if (GIT_CONTEXT.includes(key) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete clean[key];
  }
  return clean;
}

function git(cwd: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true, env: gitEnvironment() });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', chunk => { stdout += chunk; });
    child.stderr!.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? 1, stdout, stderr }));
    if (child.stdin) {
      // git may exit before reading its input (EPIPE); its exit code reports the failure.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

async function checked(cwd: string, args: string[], input?: string) {
  const result = await git(cwd, args, input);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

/** A file's content at a revision, or undefined where it does not exist. */
function blob(cwd: string, revision: string, file: string): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', 'blob', `${revision}:${file}`], { cwd, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: gitEnvironment() });
    const chunks: Buffer[] = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.once('error', reject);
    child.once('close', code => resolve(code === 0 ? Buffer.concat(chunks) : undefined));
  });
}

const binary = (content: Buffer) => content.subarray(0, 8000).includes(0);
const same = (a?: Buffer, b?: Buffer) => a === b || (!!a && !!b && a.equals(b));

/** Three-way merges one text file; returns the result and whether it has conflict markers. */
async function mergeText(ours: Buffer, base: Buffer, theirs: Buffer) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alp-merge-'));
  try {
    const [o, b, t] = ['ours', 'base', 'theirs'].map(name => path.join(directory, name));
    await Promise.all([writeFile(o, ours), writeFile(b, base), writeFile(t, theirs)]);
    const result = await git(directory, ['merge-file', '-p', '-L', 'yours', '-L', 'base', '-L', 'assignment', o, b, t]);
    if (result.code < 0 || result.code > 127) throw new Error(`git merge-file failed: ${result.stderr.trim()}`);
    return { content: result.stdout, conflict: result.code > 0 };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** The top level of the git checkout containing `directory`, or undefined outside git. */
export async function checkoutOf(directory: string) {
  const result = await git(directory, ['rev-parse', '--show-toplevel']).catch(() => undefined);
  return result?.code === 0 ? realpath(result.stdout.trim()) : undefined;
}

/** The key that writers of one checkout share: its top level, or the directory itself outside git. */
export async function checkoutKey(directory: string) {
  return (await checkoutOf(directory)) ?? realpath(directory).catch(() => path.resolve(directory));
}

/** Whether the checkout containing `directory` has a local branch of that name. */
export async function branchExists(directory: string, branch: string) {
  const result = await git(directory, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => undefined);
  return result?.code === 0;
}

/** Creates a worktree for `id` from the current state of the checkout containing `workdir`. */
/**
 * Creates a worktree for `id` from the current state of the checkout containing `workdir`,
 * or, with `from`, from an earlier assignment's committed change, keeping that assignment's
 * base so a merge applies both changes together.
 */
export async function createWorktree(workdir: string, root: string, id: string, from?: Pick<Worktree, 'base' | 'fingerprint'> & { commit: string }): Promise<Worktree> {
  const checkout = await checkoutOf(workdir);
  if (!checkout) throw new Error('Worktree isolation needs a git repository');
  const head = await git(checkout, ['rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0) throw new Error('Worktree isolation needs at least one commit');
  const fingerprint = from ? from.fingerprint : await checkoutFingerprint(checkout);
  // `stash create` snapshots uncommitted tracked changes without touching the checkout.
  const base = from ? from.base : (await checked(checkout, ['stash', 'create'])) || head.stdout.trim();
  const target = path.join(root, id);
  const branch = `alp/${id}`;
  await mkdir(root, { recursive: true, mode: 0o700 });
  await checked(checkout, ['worktree', 'add', '--quiet', '-b', branch, target, from ? from.commit : base]);
  const relative = path.relative(checkout, await realpath(workdir));
  return { checkout, path: target, workdir: path.join(target, relative), branch, base, ...(fingerprint ? { fingerprint } : {}) };
}

/**
 * Checks out an assignment's existing branch again at its worktree's place, after
 * reclaimWorktrees committed and removed it, so the assignment continues there.
 */
export async function reattachWorktree(worktree: Worktree): Promise<Worktree> {
  if (!await branchExists(worktree.checkout, worktree.branch)) throw new Error(`Branch ${worktree.branch} of the worktree no longer exists`);
  if (await stat(worktree.path).catch(() => undefined)) return worktree;
  await mkdir(path.dirname(worktree.path), { recursive: true, mode: 0o700 });
  await git(worktree.checkout, ['worktree', 'prune']);
  await checked(worktree.checkout, ['worktree', 'add', '--quiet', worktree.path, worktree.branch]);
  return worktree;
}

/** A digest of a checkout's state: HEAD, its uncommitted changes, and the names of untracked files. */
export async function checkoutFingerprint(checkout: string) {
  const head = await git(checkout, ['rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0) return undefined;
  const diff = await git(checkout, ['diff', '--binary', 'HEAD']);
  const untracked = await git(checkout, ['ls-files', '--others', '--exclude-standard', '-z']);
  return createHash('sha256').update(head.stdout).update('\0').update(diff.stdout).update('\0').update(untracked.stdout).digest('hex');
}

/**
 * Links the project's node_modules into the same place in a worktree that has none,
 * so its build and tests run; returns what undoes it. Commits never see the link,
 * because ALP removes it before the worktree is committed again.
 */
export async function linkModules(projectDir: string, worktreeDir: string) {
  const source = path.join(projectDir, 'node_modules');
  const target = path.join(worktreeDir, 'node_modules');
  if (!(await stat(source).catch(() => undefined))?.isDirectory() || await lstat(target).catch(() => undefined)) return async () => {};
  await symlink(source, target, 'dir');
  return async () => { await unlink(target).catch(() => {}); };
}

/** Commits whatever the assignment left in its worktree and describes the change from its base. */
export async function commitWorktree(worktree: Worktree, message: string): Promise<WorktreeChange> {
  await checked(worktree.path, ['add', '-A']);
  const staged = await git(worktree.path, ['diff', '--cached', '--quiet']);
  if (staged.code === 1) await checked(worktree.path, [...IDENTITY, 'commit', '--quiet', '--no-verify', '-m', message]);
  const commit = await checked(worktree.path, ['rev-parse', 'HEAD']);
  const names = await checked(worktree.path, ['diff', '--name-only', worktree.base, commit]);
  const stat = await checked(worktree.path, ['diff', '--shortstat', worktree.base, commit]);
  return { commit, files: names ? names.split('\n') : [], stat };
}

/**
 * Applies the change to the requester's working tree without committing or touching
 * its index. A patch that applies cleanly is applied as is; otherwise each file is
 * merged three ways against the requester's current file, leaving conflict markers.
 * Where a file was deleted on one side or is binary, the requester's version is kept
 * and reported as a conflict.
 */
export async function mergeWorktree(worktree: Worktree, change: WorktreeChange) {
  if (!change.files.length) return { status: 'empty' as const, files: [] };
  const patch = await checked(worktree.checkout, ['diff', '--binary', worktree.base, change.commit]);
  if ((await git(worktree.checkout, ['apply', '--whitespace=nowarn'], `${patch}\n`)).code === 0) return { status: 'applied' as const, files: change.files };
  const conflicts: string[] = [];
  for (const file of change.files) {
    const target = path.join(worktree.checkout, file);
    const ours = await readFile(target).catch(() => undefined);
    const base = await blob(worktree.checkout, worktree.base, file);
    const theirs = await blob(worktree.checkout, change.commit, file);
    if (same(ours, theirs)) continue;
    if (same(ours, base)) {
      if (theirs) {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, theirs);
      } else {
        await rm(target, { force: true });
      }
      continue;
    }
    if (!ours || !theirs || binary(ours) || binary(theirs) || (base && binary(base))) {
      conflicts.push(file);
      continue;
    }
    const merged = await mergeText(ours, base ?? Buffer.alloc(0), theirs);
    await writeFile(target, merged.content);
    if (merged.conflict) conflicts.push(file);
  }
  return conflicts.length ? { status: 'conflicts' as const, files: change.files, conflicts } : { status: 'applied' as const, files: change.files };
}

/** Removes the worktree directory; the branch stays unless `deleteBranch`. */
export async function removeWorktree(worktree: Worktree, { deleteBranch = false } = {}) {
  await git(worktree.checkout, ['worktree', 'remove', '--force', worktree.path]);
  await rm(worktree.path, { recursive: true, force: true });
  await git(worktree.checkout, ['worktree', 'prune']);
  if (deleteBranch) await git(worktree.checkout, ['branch', '-D', worktree.branch]);
}

/**
 * After a crash: commits work left in worktrees under `root` to their branches and
 * removes the directories. Returns the branches that were kept.
 */
export async function reclaimWorktrees(root: string) {
  const kept: string[] = [];
  const entries = await readdir(root).catch(() => [] as string[]);
  for (const name of entries) {
    const target = path.join(root, name);
    if (!(await stat(target).catch(() => undefined))?.isDirectory()) continue;
    const common = await git(target, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => undefined);
    if (common?.code !== 0) {
      await rm(target, { recursive: true, force: true });
      continue;
    }
    const checkout = path.dirname(common.stdout.trim());
    const branch = (await git(target, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    await git(target, ['add', '-A']);
    if ((await git(target, ['diff', '--cached', '--quiet'])).code === 1) {
      await git(target, [...IDENTITY, 'commit', '--quiet', '--no-verify', '-m', 'alp: work left by an interrupted assignment']);
    }
    await removeWorktree({ checkout, path: target, workdir: target, branch, base: '' });
    kept.push(branch);
  }
  return kept;
}

/**
 * A disposable copy of a checkout for an assignment that may build and test but
 * must not touch the requester's tree (ALPD §26): a detached worktree at the
 * requester's HEAD with its uncommitted changes applied as uncommitted changes, so
 * `git diff` and `git status` there show what they show the requester, plus its
 * untracked files.
 * A top-level node_modules is linked, not copied. Nothing in it is ever merged.
 */
export type Copy = { checkout: string; path: string; workdir: string };

export async function createCopy(workdir: string, root: string, id: string): Promise<Copy> {
  const checkout = await checkoutOf(workdir);
  if (!checkout) throw new Error('A review copy needs a git repository');
  const head = await git(checkout, ['rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0) throw new Error('A review copy needs at least one commit');
  const target = path.join(root, id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await checked(checkout, ['worktree', 'add', '--quiet', '--detach', target, head.stdout.trim()]);
  try {
    const patch = (await git(checkout, ['diff', '--binary', 'HEAD'])).stdout;
    if (patch.trim()) await checked(target, ['apply', '--whitespace=nowarn', '--binary'], patch);
    const untracked = (await checked(checkout, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    for (const file of untracked) {
      const from = path.join(checkout, file);
      if (!(await lstat(from).catch(() => undefined))?.isFile()) continue;
      await mkdir(path.dirname(path.join(target, file)), { recursive: true });
      await copyFile(from, path.join(target, file));
    }
    const modules = path.join(checkout, 'node_modules');
    if ((await stat(modules).catch(() => undefined))?.isDirectory()) await symlink(modules, path.join(target, 'node_modules'), 'dir');
  } catch (error) {
    await removeCopy({ checkout, path: target, workdir: target });
    throw error;
  }
  const relative = path.relative(checkout, await realpath(workdir));
  return { checkout, path: target, workdir: path.join(target, relative) };
}

export async function removeCopy(copy: Copy) {
  await git(copy.checkout, ['worktree', 'remove', '--force', copy.path]).catch(() => undefined);
  await rm(copy.path, { recursive: true, force: true });
  await git(copy.checkout, ['worktree', 'prune']).catch(() => undefined);
}

/** After a crash: removes copies left under `root`; they hold nothing to keep. */
export async function reclaimCopies(root: string) {
  let removed = 0;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const target = path.join(root, name);
    const common = await git(target, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => undefined);
    if (common?.code === 0) await removeCopy({ checkout: path.dirname(common.stdout.trim()), path: target, workdir: target });
    else await rm(target, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

