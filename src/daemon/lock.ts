import { open, readFile, unlink, utimes, writeFile, rename } from 'node:fs/promises';
import { bootTime, daemonPaths, lockAlive, readLock } from '../client/index.js';

export type LockContents = {
  pid: number;
  startedAt: string;
  bootTime: number;
  uid: number;
  version: string;
  protocolVersion: number;
  socket: string;
  ready: boolean;
};

/** Single-instance lock (Paseo acquirePidLock, simplified): exclusive create, stale when its pid or boot is gone. */
export async function acquireLock(home: string, contents: Omit<LockContents, 'pid' | 'startedAt' | 'bootTime' | 'uid' | 'ready'>) {
  const file = daemonPaths(home).lock;
  const lock: LockContents = { pid: process.pid, startedAt: new Date().toISOString(), bootTime: bootTime(), uid: process.getuid?.() ?? -1, ready: false, ...contents };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(lock));
      await handle.close();
      return lock;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const current = await readLock(home);
      if (lockAlive(current)) throw new Error(`ALP daemon already running (pid ${current.pid})`);
      // Remove the stale lock only if nobody replaced it meanwhile.
      const again = await readFile(file, 'utf8').catch(() => undefined);
      if (again === undefined || JSON.stringify(current) === again || !lockAlive(JSON.parse(again))) await unlink(file).catch(() => {});
    }
  }
  throw new Error('Could not acquire the ALP daemon lock');
}

export async function updateLock(home: string, lock: LockContents) {
  const file = daemonPaths(home).lock;
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(lock), { mode: 0o600 });
  await rename(temporary, file);
}

/** True while this process still owns the lock; refreshes its mtime as a heartbeat. */
export async function heartbeat(home: string) {
  const current = await readLock(home);
  if (current?.pid !== process.pid) return false;
  const now = new Date();
  await utimes(daemonPaths(home).lock, now, now).catch(() => {});
  return true;
}

export async function releaseLock(home: string) {
  const current = await readLock(home);
  if (current?.pid === process.pid) await unlink(daemonPaths(home).lock).catch(() => {});
}
