import { spawn } from 'node:child_process';
import { mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import templates from 'alp:templates';
import { alpHome, daemonPaths, PROTOCOL_VERSION } from '../client/index.js';
import { createAlpRuntime, reclaimCopies, reclaimWorktrees } from '../runtime/index.js';
import { createDaemonServer } from './server.js';
import { acquireLock, heartbeat, releaseLock, updateLock } from './lock.js';
import { createStore } from './store.js';

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

async function run(home: string) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const { socket } = daemonPaths(home);
  const lock = await acquireLock(home, { version: VERSION, protocolVersion: PROTOCOL_VERSION, socket });
  const runLogDir = process.env.ALP_RUN_LOG_DIR || path.join(home, 'runs');
  const worktreeDir = path.join(home, 'worktrees');
  // Worktrees of assignments a crash interrupted: their work goes to their branches.
  for (const branch of await reclaimWorktrees(worktreeDir).catch(() => [] as string[])) console.log(`${new Date().toISOString()} kept interrupted work on branch ${branch}`);
  // Review copies of interrupted assignments hold nothing to keep.
  const copyDir = path.join(home, 'copies');
  await reclaimCopies(copyDir).catch(() => 0);
  const runtime = createAlpRuntime({ templates, runLogDir, worktreeDir, copyDir, boardDir: path.join(home, 'boards'), libraryDir: home });
  const store = createStore(path.join(home, 'state'));
  let stopping: Promise<void> | undefined;
  const shutdown = (code = 0) => {
    stopping ??= (async () => {
      const force = setTimeout(() => process.exit(code), 10_000);
      force.unref();
      clearInterval(beat);
      await server.close().catch(() => {});
      await runtime.shutdown().catch(() => {});
      await store.flush();
      await releaseLock(home);
      console.log(`${new Date().toISOString()} alpd stopped`);
      process.exit(code);
    })();
    return stopping;
  };
  const server = createDaemonServer({ runtime, socketPath: socket, version: VERSION, store, runLogDir, onShutdown: () => void shutdown() });
  const beat = setInterval(() => {
    void heartbeat(home).then(owned => { if (!owned) void shutdown(1); });
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
else await run(home);
