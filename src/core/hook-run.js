import { spawn } from 'node:child_process';

const OUTPUT_LIMIT = 64 * 1024;
const GRACE_MS = 2000;

/**
 * Runs a hook's command once (ALPD §43): through /bin/sh in `cwd`, with the event as JSON
 * on stdin and `env` added to ALP's environment. Past its timeout it gets SIGTERM, then
 * SIGKILL two seconds later. Output beyond 64 KiB per stream is cut.
 * @param {{ command: string, timeoutSec?: number }} hook
 * @param {unknown} payload
 * @param {{ cwd: string, env?: Record<string, string>, timeoutMs?: number }} options
 * @returns {Promise<{ exitCode: number | null, signal: string | null, timedOut: boolean, stdout: string, stderr: string, durationMs: number }>}
 */
export function runHook(hook, payload, { cwd, env = {}, timeoutMs } = {}) {
  const limit = timeoutMs ?? (hook.timeoutSec ?? 60) * 1000;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', hook.command], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = { stdout: '', stderr: '' };
    for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8');
      child[stream].on('data', chunk => { if (output[stream].length < OUTPUT_LIMIT) output[stream] = (output[stream] + chunk).slice(0, OUTPUT_LIMIT); });
    }
    let timedOut = false;
    let kill;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      kill = setTimeout(() => child.kill('SIGKILL'), GRACE_MS);
    }, limit);
    child.on('error', error => { clearTimeout(timer); clearTimeout(kill); reject(error); });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      clearTimeout(kill);
      resolve({ exitCode, signal, timedOut, ...output, durationMs: Date.now() - started });
    });
    // A command that does not read stdin closes it early; that is not an error.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload) + '\n');
  });
}

/** A payload like the one ALP sends for an event, for trying a hook out. */
export function samplePayload(event, { project, agent = 'main', session = 'alp-sample-session', task } = {}) {
  return {
    event, sample: true, project, session, agent,
    ...(task ? { task } : {}),
    ...(event === 'handoff' ? { handoff: { outcome: 'complete', summary: 'Sample handoff for a hook test' } } : {}),
    ...(event === 'task.close' ? { task: task ?? 'alp-sample', reason: 'done' } : {}),
    ...(event === 'merge' ? { branch: 'alp/sample', files: [] } : {}),
  };
}
