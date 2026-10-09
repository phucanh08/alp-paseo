import { execFileSync } from 'node:child_process';

/**
 * Telling a process from a later one that reuses its pid (ALPD §32): a pid alone
 * can name an unrelated process once the first one is gone, so ALP also records
 * when the process started, and compares that.
 */

/** When this process started, in milliseconds since the epoch. */
export const OWN_START = Math.round(Date.now() - process.uptime() * 1000);

/** ps reports start times to the second. */
const START_TOLERANCE_MS = 2000;

/** When process `pid` started, from ps; undefined where ps cannot tell. */
export function processStartedAt(pid: number): number | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, env: { ...process.env, LC_ALL: 'C' } }).trim();
    const at = Date.parse(started);
    return Number.isNaN(at) ? undefined : at;
  } catch {
    return undefined;
  }
}

/**
 * Whether the process that started at `startedAt` as `pid` still runs. Without a
 * start time, or where ps cannot tell, a live pid counts as that process.
 */
export function sameProcessAlive(pid: number, startedAt?: number) {
  try { process.kill(pid, 0); } catch (error: any) { if (error?.code !== 'EPERM') return false; }
  if (startedAt === undefined) return true;
  const actual = processStartedAt(pid);
  return actual === undefined || Math.abs(actual - startedAt) < START_TOLERANCE_MS;
}
