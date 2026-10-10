import { spawn } from 'node:child_process';
import { openSync, writeSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import templates from 'alp:templates';
import webAssets from 'alp:web';
import { alpHome, daemonPaths, PROTOCOL_VERSION } from '../client/index.js';
import { createAlpRuntime, reclaimCopies, reclaimWorktrees } from '../runtime/index.js';
import { createDaemonServer } from './server.js';
import { acquireLock, heartbeat, releaseLock, updateLock } from './lock.js';
import { createStore } from './store.js';
import { createWebServer } from './web.js';
import { createPaseoBridge, webAppDir } from './paseo/index.js';
import { validateUserSettings } from '../core/validation.js';

declare const __ALP_VERSION__: string;
const VERSION = typeof __ALP_VERSION__ === 'string' ? __ALP_VERSION__ : '0.0.0-dev';
const LOG_BYTES = 10 * 1024 * 1024;
const LOG_FILES = 3;

async function rotate(log: string) {
  const size = await stat(log).then(info => info.size, () => 0);
  if (size < LOG_BYTES) return;
  for (let index = LOG_FILES - 1; index >= 1; index--) {
    await rename(index === 1 ? log : `${log}.${index - 1}`, `${log}.${index}`).catch(() => {});
  }
}

/** Starts the daemon in a new session and returns at once, so it is not part of the caller's process tree. */
async function detach(home: string) {
  const { log } = daemonPaths(home);
  await mkdir(path.dirname(log), { recursive: true, mode: 0o700 });
  await rotate(log);
  const output = await open(log, 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true,
    stdio: ['ignore', output.fd, output.fd],
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  await output.close();
}

/**
 * Under a service manager (ALPD §37), which holds alpd's stdout open: alpd rotates its
 * log at start as the detached launcher does, then writes its output there itself. The
 * manager's own file keeps only what Node prints when it dies.
 */
async function serviceLog(home: string) {
  const { log } = daemonPaths(home);
  await mkdir(path.dirname(log), { recursive: true, mode: 0o700 });
  await rotate(log);
  const fd = openSync(log, 'a', 0o600);
  for (const stream of [process.stdout, process.stderr]) {
    stream.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
      try { if (typeof chunk === 'string') writeSync(fd, chunk); else writeSync(fd, chunk); } catch {}
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') done();
      return true;
    }) as typeof stream.write;
  }
}

/**
 * The user's alpd settings in $ALP_HOME/settings.json; none when it is missing.
 * Invalid settings are logged and alpd starts with the defaults, so a typo never
 * keeps it from running; alp doctor reports them too.
 */
async function userSettings(home: string): Promise<any> {
  const file = path.join(home, 'settings.json');
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return {}; }
  try { return validateUserSettings(JSON.parse(text), file); }
  catch (error: any) {
    console.error(`${new Date().toISOString()} ignoring ${file}: ${error?.message ?? error}`);
    return {};
  }
}

/**
 * How the previous alpd ended (ALPD §31). A running alpd keeps a marker file and
 * touches it with its heartbeat; a clean stop removes it last. A marker found at
 * start means the previous alpd crashed, around the marker's last touch.
 */
async function previousExit(marker: string): Promise<{ kind: 'clean' | 'crash'; at?: string }> {
  const info = await stat(marker).catch(() => undefined);
  return info ? { kind: 'crash', at: info.mtime.toISOString() } : { kind: 'clean' };
}

async function run(home: string) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const { socket } = daemonPaths(home);
  let lock;
  try {
    lock = await acquireLock(home, { version: VERSION, protocolVersion: PROTOCOL_VERSION, socket });
  } catch (error: any) {
    // Under a service manager, another alpd serving this home is no failure to retry.
    if (process.argv.includes('--service') && /already running/.test(error?.message ?? '')) {
      console.log(`${new Date().toISOString()} ${error.message}; this one exits`);
      process.exit(0);
    }
    throw error;
  }
  const runLogDir = process.env.ALP_RUN_LOG_DIR || path.join(home, 'runs');
  const worktreeDir = path.join(home, 'worktrees');
  // Worktrees of assignments a crash interrupted: their work goes to their branches.
  for (const branch of await reclaimWorktrees(worktreeDir).catch(() => [] as string[])) console.log(`${new Date().toISOString()} kept interrupted work on branch ${branch}`);
  // Review copies of interrupted assignments hold nothing to keep.
  const copyDir = path.join(home, 'copies');
  await reclaimCopies(copyDir).catch(() => 0);
  // A hold (ALPD §40) only means something while alpd is stopped.
  await unlink(path.join(home, 'state', 'alpd.held')).catch(() => {});
  const marker = path.join(home, 'state', 'alpd.running');
  const exit = await previousExit(marker);
  if (exit.kind === 'crash') console.log(`${new Date().toISOString()} the previous alpd stopped unexpectedly around ${exit.at}`);
  await mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
  await writeFile(marker, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  const settings = await userSettings(home);
  const runtime = createAlpRuntime({
    templates, runLogDir, worktreeDir, copyDir, boardDir: path.join(home, 'boards'), libraryDir: home,
    recallFile: path.join(home, 'state', 'recall.json'), pauseFile: path.join(home, 'state', 'pause.json'), liveFile: path.join(home, 'state', 'live.json'),
    autoResume: settings?.limits?.autoResume !== false, recoveryResume: settings?.recovery?.autoResume !== false, previousExit: exit,
  });
  const store = createStore(path.join(home, 'state'));
  let stopping: Promise<void> | undefined;
  let web: ReturnType<typeof createWebServer> | undefined;
  const shutdown = (code = 0) => {
    stopping ??= (async () => {
      const force = setTimeout(() => process.exit(code), 10_000);
      force.unref();
      clearInterval(beat);
      await web?.close().catch(() => {});
      await server.close().catch(() => {});
      await runtime.shutdown().catch(() => {});
      await store.flush();
      // Last: what remains is a clean stop.
      await unlink(marker).catch(() => {});
      await releaseLock(home);
      console.log(`${new Date().toISOString()} alpd stopped`);
      process.exit(code);
    })();
    return stopping;
  };
  const server = createDaemonServer({ runtime, socketPath: socket, version: VERSION, store, runLogDir, previousExit: exit, onShutdown: () => void shutdown() });
  const beat = setInterval(() => {
    void heartbeat(home).then(owned => { if (!owned) void shutdown(1); });
    const now = new Date();
    void utimes(marker, now, now).catch(() => {});
  }, 30_000);
  beat.unref();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown());
  process.on('uncaughtException', error => { console.error(`${new Date().toISOString()} fatal`, error); void shutdown(1); });
  process.on('unhandledRejection', error => { console.error(`${new Date().toISOString()} fatal`, error); void shutdown(1); });
  try {
    await server.listen();
  } catch (error) {
    await releaseLock(home);
    throw error;
  }
  // The local web app (ALPD §61); alpd works without it.
  const webLog = (message: string) => console.log(`${new Date().toISOString()} web: ${message}`);
  // The built ALP web app (Paseo's app, ALPD §62) when it is here; else the classic page.
  const appDir = settings?.web?.app === 'classic' ? undefined : webAppDir(fileURLToPath(import.meta.url));
  const gateway = appDir ? createPaseoBridge({ daemon: server, version: VERSION, token: () => web?.token ?? '', serverId: () => web?.serverId ?? '', log: webLog }) : undefined;
  web = settings?.web?.enabled === false ? undefined : createWebServer({ daemon: server, assets: webAssets, app: appDir && gateway ? { dir: appDir, gateway } : undefined, home, port: settings?.web?.port, log: webLog });
  await web?.listen()
    .then(info => console.log(`${new Date().toISOString()} web app on ${info.url}`))
    .catch(error => console.error(`${new Date().toISOString()} web app not started`, error));
  await updateLock(home, { ...lock, ready: true });
  // Clients that cannot locate alpd themselves (the Paseo plugin) start it from here next time.
  const { install } = daemonPaths(home);
  await writeFile(`${install}.tmp`, JSON.stringify({ entry: fileURLToPath(import.meta.url), version: VERSION }), { mode: 0o600 })
    .then(() => rename(`${install}.tmp`, install))
    .catch(error => console.error(`${new Date().toISOString()} could not record alpd's location`, error));
  console.log(`${new Date().toISOString()} alpd ${VERSION} ready on ${socket} (pid ${process.pid})`);
}

const home = alpHome();
if (process.argv.includes('--detach')) await detach(home);
else {
  if (process.argv.includes('--service')) await serviceLog(home);
  await run(home);
}
