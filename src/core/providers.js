import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AlpError } from './errors.js';
import { settingsKeys, unknownMessage } from './validation.js';

/**
 * ACP providers (ALPD §46): agents that speak the Agent Client Protocol, such as Gemini
 * CLI or opencode, defined in the user's library as providers/<id>.json. An agent runs
 * on one with `provider: "<id>"` in its agent.json, or with the model `acp:<id>` or
 * `acp:<id>/<model>`. Providers live only in the library: a project's would run a
 * command from its repository on the user's machine.
 *
 *   { "kind": "acp", "label": "Gemini", "command": "gemini", "args": ["--experimental-acp"],
 *     "env": {}, "models": [{ "id": "gemini-2.5-pro" }] }
 */

export const PROVIDER_SETTINGS = ['$schema', 'kind', 'label', 'description', 'command', 'args', 'env', 'models'];
/** Runtimes ALP has built in; no provider takes their names. */
export const BUILTIN_RUNTIMES = ['codex', 'claude', 'acp'];

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const validId = id => typeof id === 'string' && /^[\w.-]+$/.test(id) && id !== '.' && id !== '..';

/** Checks a provider definition. */
export function validateProvider(config, source, id) {
  const check = (ok, message) => { if (!ok) throw new AlpError('INVALID_PROVIDER', `${source}: ${message}`); };
  if (id !== undefined) check(validId(id) && !BUILTIN_RUNTIMES.includes(id), `'${id}' cannot name a provider: ${BUILTIN_RUNTIMES.join(', ')} are built in`);
  check(object(config), 'expected an object');
  const { unknown } = settingsKeys(config, PROVIDER_SETTINGS);
  check(!unknown.length, unknown.length ? unknownMessage(unknown[0], PROVIDER_SETTINGS) : '');
  check(config.kind === 'acp', 'kind must be "acp"');
  for (const key of ['label', 'description']) if (config[key] !== undefined) check(typeof config[key] === 'string', `${key} must be a string`);
  check(nonempty(config.command), 'command must be a nonempty string');
  if (config.args !== undefined) check(Array.isArray(config.args) && config.args.every(arg => typeof arg === 'string'), 'args must be a list of strings');
  if (config.env !== undefined) check(object(config.env) && Object.values(config.env).every(value => typeof value === 'string'), 'env must map names to strings');
  if (config.models !== undefined) {
    check(Array.isArray(config.models) && config.models.every(model => object(model) && nonempty(model.id) && !/\s/.test(model.id) &&
      Object.keys(model).every(key => ['id', 'label', 'description'].includes(key)) &&
      ['label', 'description'].every(key => model[key] === undefined || typeof model[key] === 'string')), 'models must list { id, label?, description? }');
    check(new Set(config.models.map(model => model.id)).size === config.models.length, 'models lists an id twice');
  }
  return config;
}

/**
 * A provider of the library, with its id; undefined when there is none.
 * @returns {Promise<{ id: string, kind: 'acp', label: string, description?: string, command: string, args: string[], env: Record<string, string>, models?: Array<{ id: string, label?: string, description?: string }> } | undefined>}
 */
export async function loadProvider(library, id) {
  if (!library || !validId(id) || BUILTIN_RUNTIMES.includes(id)) return undefined;
  const file = path.join(library, 'providers', `${id}.json`);
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  let config;
  try { config = JSON.parse(text); } catch (cause) { throw new AlpError('INVALID_PROVIDER', `${file}: ${cause.message}`, { cause }); }
  validateProvider(config, file, id);
  // A relative command path is the provider file's; a bare name is looked up on PATH.
  const command = /[\\/]/.test(config.command) ? path.resolve(path.dirname(file), config.command) : config.command;
  return { id, ...config, label: config.label ?? id, command, args: config.args ?? [], env: config.env ?? {} };
}

/** Every provider of the library, by id. */
export async function listProviders(library) {
  if (!library) return [];
  let names = [];
  try { names = await readdir(path.join(library, 'providers')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const providers = [];
  for (const name of names.filter(name => name.endsWith('.json')).sort()) {
    const provider = await loadProvider(library, name.slice(0, -5));
    if (provider) providers.push(provider);
  }
  return providers;
}

/**
 * Splits an ACP model id, `<provider>` or `<provider>/<model>`, as resolveSession keeps it
 * after the `acp:` prefix.
 */
export function acpModel(model) {
  const slash = model.indexOf('/');
  return slash < 0 ? { provider: model, model: undefined } : { provider: model.slice(0, slash), model: model.slice(slash + 1) || undefined };
}
