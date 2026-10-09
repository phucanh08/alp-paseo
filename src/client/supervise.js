import { mkdir, unlink, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ensureDaemon, lockAlive, readLock } from './index.js';
import { installedProgram, serviceFor, startService } from './service.js';

/**
 * Keeping alpd up (ALPD §40). Whoever starts alpd goes through its login service when
 * one is installed, so the service keeps managing it; otherwise alpd starts detached.
 * A deliberate `alp daemon stop` leaves a hold, which watchers respect: they start
 * alpd again only when someone asks for it.
 */

const holdFile = home => path.join(home, 'state', 'alpd.held');

/** Records that the user stopped alpd on purpose. */
export async function holdDaemon(home, by = 'alp daemon stop') {
  await mkdir(path.dirname(holdFile(home)), { recursive: true, mode: 0o700 });
  await writeFile(holdFile(home), JSON.stringify({ by, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
}

export async function releaseHold(home) {
  await unlink(holdFile(home)).catch(() => {});
}

export async function daemonHeld(home) {
  return stat(holdFile(home)).then(() => true, () => false);
}

/** Polls until an alpd for `home` is ready; returns its socket. */
async function whenReady(home, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = await readLock(home);
    if (lockAlive(lock) && lock.ready) return lock.socket;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`alpd did not become ready within ${timeoutMs / 1000} s; see ${path.join(home, 'logs')}`);
}

/**
 * Starts alpd for `home` unless it runs, and lifts a hold: someone asked for it.
 * Returns its socket.
 */
export async function startDaemon({ home, entry, env = process.env, timeoutMs = 15_000 }) {
  await releaseHold(home);
  const lock = await readLock(home);
  if (lockAlive(lock)) return lock.ready ? lock.socket : whenReady(home, timeoutMs);
  const service = serviceFor({ home, env });
  if (service && await installedProgram(service)) {
    await startService(service);
    return whenReady(home, timeoutMs);
  }
  return ensureDaemon({ home, entry, env, timeoutMs });
}

/**
 * Starts alpd now and starts it again whenever it is found down on `misses` checks in a
 * row, `intervalMs` apart, unless the user holds it. Two misses let `alp daemon restart`
 * and `install` finish their own stop and start first. Returns a function that stops
 * watching, and resolves once a start it began has settled; alpd keeps running.
 */
export function superviseDaemon({ home, entry, env = process.env, intervalMs = 5_000, misses = 2, log = () => {} }) {
  let stopped = false;
  let missed = 0;
  let starting;
  const start = reason => {
    starting ??= startDaemon({ home, entry: typeof entry === 'function' ? entry() : entry, env })
      .then(() => log(`alpd ${reason}`), error => log(`could not start alpd: ${error?.message ?? error}`))
      .finally(() => { starting = undefined; missed = 0; });
    return starting;
  };
  const check = async () => {
    if (stopped || starting) return;
    if (lockAlive(await readLock(home))) { missed = 0; return; }
    if (await daemonHeld(home)) { missed = 0; return; }
    // Stopped while this check looked: start nothing.
    if (++missed >= misses && !stopped) await start('was down; started it again');
  };
  const initial = start('started with Paseo');
  const timer = setInterval(() => { void check(); }, intervalMs);
  timer.unref?.();
  const stop = () => { stopped = true; clearInterval(timer); return starting ?? Promise.resolve(); };
  stop.started = initial;
  return stop;
}
