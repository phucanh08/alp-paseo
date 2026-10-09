import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AlpError } from './errors.js';
import { validateHook } from './validation.js';

/**
 * The hook definitions an agent uses (ALPD §45): those it names in agent.json and the
 * JSON files in its own hooks/ directory. `project` marks a hook that comes from the
 * project's .alp/, which runs only once the user trusts the workspace.
 * @param {import('./types.js').ResolvedAgent} agent
 * @returns {Promise<Array<{ name: string, path: string, project: boolean, event: string, command: string, blocking?: boolean, timeoutSec?: number, match?: { agent?: string, label?: string }, description?: string }>>}
 */
export async function loadHooks(agent) {
  const project = path.join(agent.projectRoot, '.alp') + path.sep;
  const hooks = [];
  for (const { name, path: file } of agent.hooks) {
    if (!file.endsWith('.json')) throw new AlpError('INVALID_HOOK', `${file}: a hook is a JSON definition, hooks/<name>.json, with an event and a command`);
    let config;
    try { config = JSON.parse(await readFile(file, 'utf8')); }
    catch (cause) { throw new AlpError('INVALID_HOOK', `${file}: ${cause.message}`, { cause }); }
    validateHook(config, file);
    hooks.push({ ...config, name: name.replace(/\.json$/, ''), path: file, project: file.startsWith(project) });
  }
  return hooks;
}

/**
 * Whether a hook applies: to its agent, if it names one, and to tasks with its label, if it names one.
 * @param {{ match?: { agent?: string, label?: string } }} hook
 * @param {{ agent: string, labels?: string[] }} context
 */
export function hookMatches(hook, { agent, labels = [] }) {
  if (hook.match?.agent && hook.match.agent !== agent) return false;
  if (hook.match?.label && !labels.includes(hook.match.label)) return false;
  return true;
}
