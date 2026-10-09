import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * Which workspaces' hooks the user trusts (ALPD §45). A project's hooks come with its
 * repository, so ALP asks the user once per project before running them; once the user
 * agrees, that project's hooks run from then on, including hooks added or changed later.
 * Hooks in the user's library are always trusted. Kept in $ALP_HOME/state/trust.json.
 */

const file = home => path.join(home, 'state', 'trust.json');
/** One key per workspace, however its path was spelled. */
const key = root => realpath(path.resolve(root)).catch(() => path.resolve(root));

async function load(home) {
  try {
    const value = JSON.parse(await readFile(file(home), 'utf8'));
    return value && typeof value === 'object' && value.projects && typeof value.projects === 'object' ? value : { projects: {} };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { projects: {} };
    throw error;
  }
}

async function store(home, value) {
  await mkdir(path.dirname(file(home)), { recursive: true });
  const temporary = `${file(home)}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await rename(temporary, file(home));
}

/** Whether the user trusts this project's hooks. */
export async function isTrusted(home, projectRoot) {
  return Object.hasOwn((await load(home)).projects, await key(projectRoot));
}

/** Records that the user trusts this project's hooks; `by` says how they agreed. */
export async function trustProject(home, projectRoot, by = 'user') {
  const value = await load(home);
  value.projects[await key(projectRoot)] = { trustedAt: new Date().toISOString(), by };
  await store(home, value);
}

/** Forgets a project's trust: ALP asks again before its hooks run. Returns whether it was trusted. */
export async function revokeProject(home, projectRoot) {
  const value = await load(home);
  const root = await key(projectRoot);
  if (!Object.hasOwn(value.projects, root)) return false;
  delete value.projects[root];
  await store(home, value);
  return true;
}

/** Every trusted project, with when and how the user agreed. */
export async function trustedProjects(home) {
  return Object.entries((await load(home)).projects).map(([root, entry]) => ({ root, ...entry })).sort((a, b) => a.root.localeCompare(b.root));
}
