import { spawn } from 'node:child_process';

/** Where agents send feedback about ALP itself: its process, tools and agent instructions. */
export const ALP_REPO = 'phucanh08/alp-paseo';

/** Runs the GitHub CLI with optional standard input and returns its standard output. Tests replace it. */
export type GitHubRunner = (args: string[], options: { cwd: string; input?: string }) => Promise<string>;

function run(command: string, args: string[], { cwd, input }: { cwd: string; input?: string }) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', error => reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`${command} is not installed or not on PATH`) : error));
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error((stderr || stdout).trim() || `${command} exited with ${code}`)));
    child.stdin.end(input ?? '');
  });
}

export const gh: GitHubRunner = (args, options) => run(process.env.ALP_GH_BIN ?? 'gh', args, options);

/** The owner/name of the GitHub repository a project's origin remote points to. */
export async function projectRepo(projectRoot: string) {
  let url: string;
  try {
    url = (await run('git', ['remote', 'get-url', 'origin'], { cwd: projectRoot })).trim();
  } catch {
    throw new Error('This project has no git remote named origin; use target "alp" for feedback about ALP, or tell the user');
  }
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error(`The origin remote is not on GitHub (${url}); issues are filed with the GitHub CLI only`);
  return `${match[1]}/${match[2]}`;
}
