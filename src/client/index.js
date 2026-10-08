import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** Wire protocol of alpd (plans/reference/ALPD.md §3). Bump only for incompatible changes. */
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME = 16 * 1024 * 1024;

export function alpHome(env = process.env) {
  return path.resolve(env.ALP_HOME || path.join(os.homedir(), '.alp'));
}

/** Unix socket paths are limited to about 104 bytes; long homes get a short socket in the temp directory. */
export function daemonPaths(home) {
  const preferred = path.join(home, 'alpd.sock');
  const socket = Buffer.byteLength(preferred) < 100
    ? preferred
    : path.join(os.tmpdir(), `alpd-${createHash('sha256').update(home).digest('hex').slice(0, 12)}.sock`);
  return { home, lock: path.join(home, 'alpd.lock'), socket, log: path.join(home, 'logs', 'alpd.log'), install: path.join(home, 'alpd.json') };
}

const isFile = file => stat(file).then(info => info.isFile(), () => false);

/** Global bin directories that a GUI app's PATH may lack. */
const BIN_DIRECTORIES = [path.join(os.homedir(), '.npm-global', 'bin'), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];

/**
 * Finds alpd.js for a client that cannot locate it beside itself, such as the Paseo
 * plugin, which Paseo re-bundles: the first existing candidate, then where alpd last
 * recorded itself ($ALP_HOME/alpd.json), then the ALP CLI (`alp`) on PATH.
 */
export async function findDaemonEntry({ home = alpHome(), env = process.env, candidates = /** @type {Array<string | undefined>} */ ([]) } = {}) {
  for (const candidate of candidates) if (candidate && await isFile(candidate)) return candidate;
  try {
    const { entry } = JSON.parse(await readFile(daemonPaths(home).install, 'utf8'));
    if (typeof entry === 'string' && await isFile(entry)) return entry;
  } catch {}
  for (const directory of [...(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...BIN_DIRECTORIES]) {
    const cli = await realpath(path.join(directory, 'alp')).catch(() => undefined);
    if (!cli || path.basename(cli) !== 'cli.js') continue;
    const root = path.resolve(path.dirname(cli), '..');
    const name = await readFile(path.join(root, 'package.json'), 'utf8').then(text => JSON.parse(text).name, () => undefined);
    const entry = path.join(root, 'dist', 'alpd.js');
    if (name === 'alp' && await isFile(entry)) return entry;
  }
  return undefined;
}

/** Wall-clock boot time; a lock from an earlier boot is stale even if its pid is reused. */
export function bootTime() {
  return Math.round((Date.now() - os.uptime() * 1000) / 1000);
}

export async function readLock(home) {
  try {
    return JSON.parse(await readFile(daemonPaths(home).lock, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function lockAlive(lock) {
  if (!lock || !Number.isSafeInteger(lock.pid) || Math.abs((lock.bootTime ?? 0) - bootTime()) > 30) return false;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export class AlpRpcError extends Error {
  constructor(error) {
    super(error?.message ?? 'ALP daemon request failed');
    this.code = error?.code;
    this.data = error?.data;
  }
}

/** One JSON-RPC 2.0 connection to alpd; events arrive as `event` notifications. */
export class AlpClient {
  #socket;
  #sequence = 0;
  #pending = new Map();
  #events = new Set();
  #closes = new Set();
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME) { socket.destroy(new Error('ALP daemon frame exceeds size limit')); return; }
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) this.#receive(line);
      }
    });
    socket.on('close', () => this.#finish(new Error('ALP daemon connection closed')));
    socket.on('error', error => this.#finish(error));
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { this.#socket.destroy(new Error('Invalid frame from ALP daemon')); return; }
    if (message.method === 'event') {
      for (const listener of this.#events) listener(message.params);
      return;
    }
    const waiter = this.#pending.get(message.id);
    if (!waiter) return;
    this.#pending.delete(message.id);
    if (message.error) waiter.reject(new AlpRpcError(message.error));
    else waiter.resolve(message.result);
  }

  #finish(error) {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#pending.values()) waiter.reject(error);
    this.#pending.clear();
    for (const listener of this.#closes) listener(error);
  }

  get closed() { return this.#closed; }

  request(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error('ALP daemon connection closed'));
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  onEvent(listener) {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  onClose(listener) {
    this.#closes.add(listener);
    return () => this.#closes.delete(listener);
  }

  close() {
    this.#socket.end();
    this.#finish(new Error('ALP daemon connection closed'));
  }
}

/** Connects and performs the version handshake. */
export async function connect(socketPath, client = { name: 'alp', version: '0' }) {
  const socket = await new Promise((resolve, reject) => {
    const candidate = net.createConnection(socketPath);
    candidate.once('connect', () => { candidate.off('error', reject); resolve(candidate); });
    candidate.once('error', reject);
  });
  const connection = new AlpClient(socket);
  try {
    await connection.request('daemon.hello', { protocolVersion: PROTOCOL_VERSION, client });
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}

async function tail(file, lines = 30) {
  try { return (await readFile(file, 'utf8')).split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

/**
 * Returns the socket of a ready daemon, starting one when none runs.
 * `entry` is the daemon script; it is started through its own detaching launcher so the
 * daemon outlives the client that started it.
 */
export async function ensureDaemon({ home = alpHome(), entry = /** @type {string | undefined} */ (undefined), env = process.env, execPath = process.execPath, timeoutMs = 15_000 } = {}) {
  const ready = async () => {
    const lock = await readLock(home);
    return lockAlive(lock) && lock.ready ? lock.socket : undefined;
  };
  const live = await ready();
  if (live) return live;
  if (!lockAlive(await readLock(home))) {
    entry ??= await findDaemonEntry({ home, env });
    if (!entry) throw new Error('ALP daemon is not running and alpd.js was not found. Install the ALP CLI and run `alp daemon start`, or set ALP_DAEMON_ENTRY to alpd.js');
    await new Promise((resolve, reject) => {
      const launcher = spawn(execPath, [entry, '--detach'], {
        env: { ...env, ALP_HOME: home, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'ignore',
        windowsHide: true,
      });
      launcher.once('error', reject);
      launcher.once('exit', code => code === 0 ? resolve() : reject(new Error(`ALP daemon launcher exited (${code})`)));
    });
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const socket = await ready();
    if (socket) return socket;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const log = await tail(daemonPaths(home).log);
  throw new Error(`ALP daemon did not become ready within ${timeoutMs} ms${log ? `\n${log}` : ''}`);
}
