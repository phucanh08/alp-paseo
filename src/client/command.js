import { spawn } from 'node:child_process';

/** Runs a command; resolves with its exit code and output, never rejects. */
export function runCommand(command, args, { cwd, env = process.env, timeoutMs = 15_000 } = {}) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ code: -1, stdout: '', stderr: error.message }); return; }
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}
