import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AlpError } from './errors.js';

/**
 * The project's verification gate (plans/reference/ALPD.md §28): commands from
 * `verify` in .alp/settings.json that alpd runs before it applies an assignment's
 * change, and after a writer in the shared checkout. They run in order and stop
 * at the first failure.
 */

export const VERIFY_STEPS = ['setup', 'typecheck', 'test'];
export const VERIFY_TIMEOUT_SEC = 600;
/** How long a stopped command gets between SIGTERM and SIGKILL. */
export const VERIFY_GRACE_MS = 5000;
/** The exit code (EX_TEMPFAIL) by which a step says it could not run, rather than that the change is wrong. */
export const VERIFY_INFRA_EXIT = 75;
const COMMAND_CHARS = 2000;
const OUTPUT_CHARS = 4000;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (source, message) => { throw new AlpError('INVALID_SETTINGS', `${source}: ${message}`); };

/** Checks a `verify` setting; returns it normalized, or undefined when absent. */
export function validateVerify(verify, source) {
  if (verify === undefined) return undefined;
  if (!object(verify)) fail(source, 'verify must be an object');
  const extra = Object.keys(verify).filter(key => ![...VERIFY_STEPS, 'timeoutSec', 'idleSec'].includes(key));
  if (extra.length) fail(source, `unsupported verify field '${extra[0]}'; use ${VERIFY_STEPS.join(', ')}, timeoutSec and idleSec`);
  for (const step of VERIFY_STEPS) {
    if (verify[step] !== undefined && (typeof verify[step] !== 'string' || !verify[step].trim() || verify[step].length > COMMAND_CHARS)) fail(source, `verify.${step} must be a command of at most ${COMMAND_CHARS} characters`);
  }
  if (!VERIFY_STEPS.some(step => verify[step] !== undefined)) fail(source, `verify needs at least one of ${VERIFY_STEPS.join(', ')}`);
  if (verify.timeoutSec !== undefined && (!Number.isSafeInteger(verify.timeoutSec) || verify.timeoutSec < 1 || verify.timeoutSec > 7200)) fail(source, 'verify.timeoutSec must be 1 to 7200 seconds');
  if (verify.idleSec !== undefined && (!Number.isSafeInteger(verify.idleSec) || verify.idleSec < 1 || verify.idleSec > 7200)) fail(source, 'verify.idleSec must be 1 to 7200 seconds');
  return {
    ...Object.fromEntries(VERIFY_STEPS.filter(step => verify[step] !== undefined).map(step => [step, verify[step].trim()])),
    timeoutSec: verify.timeoutSec ?? VERIFY_TIMEOUT_SEC,
    ...(verify.idleSec !== undefined ? { idleSec: verify.idleSec } : {}),
  };
}

/** The project's verify setting, or undefined when it has none. */
export async function verifyConfig(projectRoot) {
  const file = path.join(projectRoot, '.alp', 'settings.json');
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  let settings;
  try { settings = JSON.parse(text); } catch (error) { fail(file, `invalid JSON: ${error.message}`); }
  return object(settings) ? validateVerify(settings.verify, file) : undefined;
}

/**
 * Runs one command through the shell, keeping the end of its output. When it runs
 * past `timeoutMs`, or prints nothing for `idleMs`, its process group gets SIGTERM,
 * then SIGKILL after VERIFY_GRACE_MS, so its own cleanup can run.
 */
function runCommand(command, cwd, { timeoutMs, idleMs }, env) {
  return new Promise(resolve => {
    const started = Date.now();
    const windows = process.platform === 'win32';
    const child = spawn(windows ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh', windows ? ['/d', '/s', '/c', command] : ['-c', command], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: !windows, windowsHide: true,
    });
    let output = '';
    let stopped;
    let idle;
    const signal = name => { try { windows ? child.kill() : process.kill(-child.pid, name); } catch {} };
    const stop = reason => {
      if (stopped) return;
      stopped = reason;
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), VERIFY_GRACE_MS).unref();
    };
    const quiet = () => {
      if (!idleMs) return;
      clearTimeout(idle);
      idle = setTimeout(() => stop('idle'), idleMs);
    };
    const keep = chunk => { output = (output + chunk).slice(-OUTPUT_CHARS * 2); quiet(); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    quiet();
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    let done = false;
    const finish = (exitCode, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(idle);
      const tail = output.length > OUTPUT_CHARS ? `…${output.slice(-OUTPUT_CHARS)}` : output;
      resolve({
        exitCode, ms: Date.now() - started, output: error ? `${tail}${error}` : tail,
        ...(stopped === 'timeout' ? { timedOut: true } : stopped === 'idle' ? { idle: true } : {}),
        ...(error ? { spawnError: true } : {}),
      });
    };
    child.once('error', error => finish(127, error.message));
    child.once('close', (code, signal) => finish(stopped ? 124 : code ?? (signal ? 128 : 1)));
  });
}

/**
 * Runs the configured steps in `cwd`, in order, stopping at the first failure.
 * A step that exits VERIFY_INFRA_EXIT, or whose shell does not start, ends the run as skipped.
 * @returns {Promise<{ passed: boolean, cwd: string, skipped?: string, commands: Array<{ step: string, command: string, exitCode: number, ms: number, output: string, timedOut?: boolean, idle?: boolean }> }>}
 */
export async function runVerify(cwd, config, { env = process.env } = {}) {
  const commands = [];
  for (const step of VERIFY_STEPS) {
    if (!config[step]) continue;
    const { spawnError, ...result } = await runCommand(config[step], cwd, { timeoutMs: config.timeoutSec * 1000, idleMs: config.idleSec ? config.idleSec * 1000 : undefined }, { ...env, ALP_VERIFY: '1' });
    commands.push({ step, command: config[step], ...result });
    // A step that could not run says nothing about the change: the check is skipped, not failed.
    if (spawnError || result.exitCode === VERIFY_INFRA_EXIT) {
      return { passed: false, cwd, commands, skipped: `infra: ${step} could not run (${spawnError ? 'the shell did not start' : `exit ${VERIFY_INFRA_EXIT}`})` };
    }
    if (result.exitCode !== 0) return { passed: false, cwd, commands };
  }
  return { passed: true, cwd, commands };
}

/** One line for a verification: passed, or the step that failed. */
export function describeVerification(verified) {
  if (verified.skipped) return `verification skipped: ${verified.skipped}`;
  const failed = verified.commands.find(command => command.exitCode !== 0);
  return verified.passed ? `verified (${verified.commands.map(command => command.step).join(', ')})`
    : `verification failed: ${failed.step} ${failed.timedOut ? 'timed out' : failed.idle ? 'printed nothing for too long' : `exited ${failed.exitCode}`}`;
}
