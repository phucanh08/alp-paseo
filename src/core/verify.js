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
const COMMAND_CHARS = 2000;
const OUTPUT_CHARS = 4000;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (source, message) => { throw new AlpError('INVALID_SETTINGS', `${source}: ${message}`); };

/** Checks a `verify` setting; returns it normalized, or undefined when absent. */
export function validateVerify(verify, source) {
  if (verify === undefined) return undefined;
  if (!object(verify)) fail(source, 'verify must be an object');
  const extra = Object.keys(verify).filter(key => ![...VERIFY_STEPS, 'timeoutSec'].includes(key));
  if (extra.length) fail(source, `unsupported verify field '${extra[0]}'; use ${VERIFY_STEPS.join(', ')} and timeoutSec`);
  for (const step of VERIFY_STEPS) {
    if (verify[step] !== undefined && (typeof verify[step] !== 'string' || !verify[step].trim() || verify[step].length > COMMAND_CHARS)) fail(source, `verify.${step} must be a command of at most ${COMMAND_CHARS} characters`);
  }
  if (!VERIFY_STEPS.some(step => verify[step] !== undefined)) fail(source, `verify needs at least one of ${VERIFY_STEPS.join(', ')}`);
  if (verify.timeoutSec !== undefined && (!Number.isSafeInteger(verify.timeoutSec) || verify.timeoutSec < 1 || verify.timeoutSec > 7200)) fail(source, 'verify.timeoutSec must be 1 to 7200 seconds');
  return {
    ...Object.fromEntries(VERIFY_STEPS.filter(step => verify[step] !== undefined).map(step => [step, verify[step].trim()])),
    timeoutSec: verify.timeoutSec ?? VERIFY_TIMEOUT_SEC,
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

/** Runs one command through the shell, keeping the end of its output; a timeout kills its process group. */
function runCommand(command, cwd, timeoutMs, env) {
  return new Promise(resolve => {
    const started = Date.now();
    const windows = process.platform === 'win32';
    const child = spawn(windows ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh', windows ? ['/d', '/s', '/c', command] : ['-c', command], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: !windows, windowsHide: true,
    });
    let output = '';
    const keep = chunk => { output = (output + chunk).slice(-OUTPUT_CHARS * 2); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { windows ? child.kill() : process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeoutMs);
    const finish = (exitCode, error) => {
      clearTimeout(timer);
      const tail = output.length > OUTPUT_CHARS ? `…${output.slice(-OUTPUT_CHARS)}` : output;
      resolve({ exitCode, ms: Date.now() - started, output: error ? `${tail}${error}` : tail, ...(timedOut ? { timedOut: true } : {}) });
    };
    child.once('error', error => finish(127, error.message));
    child.once('close', (code, signal) => finish(timedOut ? 124 : code ?? (signal ? 128 : 1)));
  });
}

/**
 * Runs the configured steps in `cwd`, in order, stopping at the first failure.
 * @returns {Promise<{ passed: boolean, cwd: string, commands: Array<{ step: string, command: string, exitCode: number, ms: number, output: string, timedOut?: boolean }> }>}
 */
export async function runVerify(cwd, config, { env = process.env } = {}) {
  const commands = [];
  for (const step of VERIFY_STEPS) {
    if (!config[step]) continue;
    const result = await runCommand(config[step], cwd, config.timeoutSec * 1000, { ...env, ALP_VERIFY: '1' });
    commands.push({ step, command: config[step], ...result });
    if (result.exitCode !== 0) return { passed: false, cwd, commands };
  }
  return { passed: true, cwd, commands };
}

/** One line for a verification: passed, or the step that failed. */
export function describeVerification(verified) {
  if (verified.skipped) return `verification skipped: ${verified.skipped}`;
  const failed = verified.commands.find(command => command.exitCode !== 0);
  return verified.passed ? `verified (${verified.commands.map(command => command.step).join(', ')})`
    : `verification failed: ${failed.step} ${failed.timedOut ? 'timed out' : `exited ${failed.exitCode}`}`;
}
