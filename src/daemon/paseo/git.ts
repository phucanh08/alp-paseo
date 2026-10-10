import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * What the app shows of a directory's checkout (ALPD §62 steps 6 and 8): whether it is git, its
 * root, branch, remote and whether anything changed. Read-only git, without optional locks, as
 * Paseo's daemon runs it.
 */

const run = promisify(execFile);
const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

export async function git(cwd: string, args: string[], { maxBuffer = 16 * 1024 * 1024, okCodes = [0] }: { maxBuffer?: number; okCodes?: number[] } = {}) {
  try {
    return (await run('git', ['-C', cwd, ...args], { env: ENV, maxBuffer })).stdout;
  } catch (error: any) {
    if (typeof error?.code === 'number' && okCodes.includes(error.code) && typeof error.stdout === 'string') return error.stdout as string;
    throw error;
  }
}

export type CheckoutFacts =
  | { isGit: false }
  | { isGit: true; repoRoot: string; currentBranch: string | null; remoteUrl: string | null; isDirty: boolean };

export async function checkoutFacts(cwd: string): Promise<CheckoutFacts> {
  const repoRoot = await git(cwd, ['rev-parse', '--show-toplevel']).then(out => out.trim(), () => '');
  if (!repoRoot) return { isGit: false };
  const [branch, remoteUrl, status] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).then(out => out.trim(), () => ''),
    git(cwd, ['config', '--get', 'remote.origin.url']).then(out => out.trim() || null, () => null),
    git(cwd, ['status', '--porcelain']).catch(() => ''),
  ]);
  return { isGit: true, repoRoot, currentBranch: branch && branch !== 'HEAD' ? branch : null, remoteUrl, isDirty: status.trim().length > 0 };
}

/** Checkout facts kept for a while, so a poll does not run git for every directory each time. */
export function checkoutCache(ttlMs = 10_000) {
  const entries = new Map<string, { at: number; facts: CheckoutFacts; pending?: Promise<CheckoutFacts> }>();
  return {
    /** The last facts known, or undefined before the first read. */
    peek: (cwd: string) => entries.get(cwd)?.facts,
    /** Fresh facts when the kept ones are older than the TTL (or `force`). */
    async read(cwd: string, force = false) {
      const entry = entries.get(cwd);
      if (entry && !force && Date.now() - entry.at < ttlMs) return entry.facts;
      if (entry?.pending) return entry.pending;
      const pending = checkoutFacts(cwd).catch((): CheckoutFacts => ({ isGit: false }));
      entries.set(cwd, { at: entry?.at ?? 0, facts: entry?.facts ?? { isGit: false }, pending });
      const facts = await pending;
      entries.set(cwd, { at: Date.now(), facts });
      return facts;
    },
  };
}
