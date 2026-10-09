import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { AlpError } from './errors.js';
import { agentSources, builtinText, jsonObject, libraryEntries, optionalText } from './resolver.js';
import { teamSources, validateTeam } from './teams.js';
import { normalizeMcp, validateAgentConfig, validateHook } from './validation.js';

/**
 * Editing the library (ALPD §43): agents, skills, MCP servers, hooks and teams, in the
 * user's library (ALP_HOME) or as a project's override (.alp/). Built-ins are never
 * written; duplicate one, or save an entry of its name, to change it. Every save is
 * checked first and written file by file through a temporary file and a rename; a
 * revision taken when the entry was read refuses a save over someone else's change.
 *
 * An entry's content, by kind:
 *   agents  { instructions, config? }   AGENT.md and agent.json
 *   skills  { body }                    SKILL.md
 *   mcp     { server }                  mcp/<name>.json
 *   hooks   { hook }                    hooks/<name>.json
 *   teams   { team, houseRules? }       team.json and HOUSE_RULES.md
 */

export const EDIT_KINDS = ['agents', 'skills', 'mcp', 'hooks', 'teams'];
const validName = name => typeof name === 'string' && /^[\w.-]+$/.test(name) && name !== '.' && name !== '..';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw new AlpError(code, message); };

/** The files an entry has, relative to its kind's directory, and what each holds. */
const FILES = {
  agents: name => [[`${name}/AGENT.md`, 'instructions', 'text'], [`${name}/agent.json`, 'config', 'json']],
  skills: name => [[`${name}/SKILL.md`, 'body', 'text']],
  mcp: name => [[`${name}.json`, 'server', 'json']],
  hooks: name => [[`${name}.json`, 'hook', 'json']],
  teams: name => [[`${name}/team.json`, 'team', 'json'], [`${name}/HOUSE_RULES.md`, 'houseRules', 'text']],
};
/** The directory an entry owns, if any: removed whole on delete and moved whole on rename. */
const ownDirectory = kind => ['agents', 'skills', 'teams'].includes(kind);

function kindOf(kind) {
  if (!EDIT_KINDS.includes(kind)) fail('INVALID_KIND', `Unknown kind '${kind}'; use one of ${EDIT_KINDS.join(', ')}`);
  return kind;
}
function nameOf(name) {
  if (!validName(name)) fail('INVALID_NAME', `'${name}' is not a valid name: use letters, digits, '.', '_' or '-'`);
  return name;
}
/** The directory a scope writes to. */
function base(scope, { root, library }) {
  if (scope === 'library') return library ?? fail('INVALID_SCOPE', 'No library: ALP_HOME is not set');
  if (scope === 'project') return root ? path.join(path.resolve(root), '.alp') : fail('INVALID_SCOPE', 'No project directory');
  return fail('INVALID_SCOPE', `Scope must be library or project, not '${scope}'`);
}
const revisionOf = content => content === undefined ? null : createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16);

/** An entry's content as one layer holds it, or undefined when that layer has none. */
async function readLayer(kind, name, directory) {
  const content = {};
  let found = false;
  for (const [file, key, type] of FILES[kind](name)) {
    const target = path.join(directory, kind, file);
    const text = await optionalText(target);
    if (text === undefined) continue;
    found = true;
    if (type === 'text') { content[key] = text; continue; }
    try { content[key] = JSON.parse(text); }
    catch (cause) { throw new AlpError('INVALID_ENTRY', `${target}: ${cause.message}`, { cause }); }
  }
  // An agent or skill is its instructions; a team its team.json.
  const main = { agents: 'instructions', skills: 'body', teams: 'team' }[kind];
  return found && (!main || content[main] !== undefined) ? content : undefined;
}

/** A built-in entry's content: the agents and teams ALP ships. */
async function readBuiltin(kind, name, templates) {
  if (kind === 'agents') {
    const instructions = await builtinText(`agents/${name}/AGENT.md`, templates);
    if (instructions === undefined) return undefined;
    const config = await builtinText(`agents/${name}/agent.json`, templates);
    return { instructions, ...(config !== undefined ? { config: JSON.parse(config) } : {}) };
  }
  if (kind === 'teams') {
    const team = await builtinText(`teams/${name}/team.json`, templates);
    if (team === undefined) return undefined;
    return { team: JSON.parse(team), houseRules: (await builtinText(`teams/${name}/HOUSE_RULES.md`, templates)) ?? '' };
  }
  return undefined;
}

/** Each layer's version of an entry, in order: built-in, library, project. */
async function layers(kind, name, { root, library, templates }) {
  return {
    builtin: await readBuiltin(kind, name, templates),
    library: library ? await readLayer(kind, name, library) : undefined,
    project: root ? await readLayer(kind, name, path.join(path.resolve(root), '.alp')) : undefined,
  };
}

/**
 * One entry: the version that applies (the project's, else the library's, else the
 * built-in), or one scope's version with `scope`. `revision` goes back with a save.
 * @param {'agents' | 'skills' | 'mcp' | 'hooks' | 'teams'} kind
 * @param {string} name
 * @param {{ root?: string, library?: string, templates?: Record<string, string>, scope?: 'library' | 'project' }} [options]
 * @returns {Promise<{ kind: 'agents' | 'skills' | 'mcp' | 'hooks' | 'teams', name: string, source: 'builtin' | 'library' | 'project', overrides?: 'builtin' | 'library' | 'project', content: Record<string, unknown>, revision: string | null, usedBy: string[] }>}
 */
export async function getEntry(kind, name, { root, library, templates, scope } = {}) {
  kindOf(kind); nameOf(name);
  const found = await layers(kind, name, { root, library, templates });
  const order = scope ? [scope] : ['project', 'library', 'builtin'];
  const source = order.find(layer => found[layer] !== undefined);
  if (!source) fail('NOT_FOUND', `No ${kind} entry '${name}'${scope ? ` in the ${scope}` : ''}`);
  const below = ['builtin', 'library', 'project'].slice(0, ['builtin', 'library', 'project'].indexOf(source)).reverse().find(layer => found[layer] !== undefined);
  return { kind, name, source: /** @type {'builtin' | 'library' | 'project'} */ (source), ...(below ? { overrides: /** @type {'builtin' | 'library'} */ (below) } : {}), content: found[source], revision: revisionOf(found[source]), usedBy: await usersOf(kind, name, { root, library, templates }) };
}

/** Every entry of a kind with its source and users, as `alp <kind>` lists them. */
export async function listEntries(kind, { root, library, templates } = {}) {
  kindOf(kind);
  if (kind !== 'teams') return libraryEntries(kind, root, { library, templates });
  const rows = [];
  for (const [name, source] of await teamSources(root, { library, templates })) rows.push({ name, source: source.source, ...(source.overrides ? { overrides: source.overrides } : {}), ...(source.directory ? { path: source.directory } : {}), usedBy: await usersOf(kind, name, { root, library, templates }) });
  return rows;
}

/** Who refers to an entry: agents naming it, teams with it as a member, settings and role-skills.json. */
export async function usersOf(kind, name, { root, library, templates } = {}) {
  const users = new Set();
  if (kind === 'teams') {
    if (root) {
      const settings = await jsonObject(path.join(path.resolve(root), '.alp', 'settings.json'), 'INVALID_SETTINGS').catch(() => ({}));
      if (settings.workflow?.mode === name) users.add('project settings');
    }
    return [...users];
  }
  if (kind === 'agents') {
    for (const [team, source] of await teamSources(root, { library, templates })) {
      const text = source.directory ? await optionalText(path.join(source.directory, 'team.json')) : await builtinText(`teams/${team}/team.json`, templates);
      try {
        const config = JSON.parse(text ?? '{}');
        if (config.main === name || Object.hasOwn(config.members ?? {}, name) || config.supervisor?.agent === name) users.add(`team ${team}`);
      } catch {}
    }
    if (root) {
      const settings = await jsonObject(path.join(path.resolve(root), '.alp', 'settings.json'), 'INVALID_SETTINGS').catch(() => ({}));
      if (settings.defaultAgent === name) users.add('project settings');
      for (const [owner, targets] of Object.entries(object(settings.delegation) ? settings.delegation : {})) if (owner === name || (Array.isArray(targets) && targets.includes(name))) users.add('project delegation');
    }
    return [...users].sort();
  }
  // Agents naming it in agent.json, and for skills the roles role-skills.json gives it.
  const rows = await libraryEntries(kind, root, { library, templates });
  for (const user of rows.find(row => row.name === name)?.usedBy ?? []) users.add(`agent ${user}`);
  return [...users].sort();
}

/** Checks content for a kind, and that what it names exists where the entry will live. */
async function check(kind, name, content, { scope, root, library, templates }) {
  if (!object(content)) fail('INVALID_ENTRY', `${kind} '${name}': content must be an object`);
  const where = `${scope} ${kind} '${name}'`;
  const visible = scope === 'project' ? { root, library, templates } : { library, templates };
  const text = (key, required) => {
    if (content[key] === undefined && !required) return;
    if (typeof content[key] !== 'string' || (required && !content[key].trim())) fail('INVALID_ENTRY', `${where}: ${key} must be ${required ? 'nonempty ' : ''}text`);
  };
  const only = keys => { for (const key of Object.keys(content)) if (!keys.includes(key)) fail('INVALID_ENTRY', `${where}: unknown field '${key}'; expected ${keys.join(', ')}`); };
  if (kind === 'agents') {
    only(['instructions', 'config']);
    text('instructions', true);
    if (content.config !== undefined) {
      validateAgentConfig(content.config, `${where} agent.json`);
      for (const [list, entries] of [['skills', 'skills'], ['mcp', 'mcp'], ['hooks', 'hooks']]) {
        if (!content.config[list]?.length) continue;
        const known = new Set((await libraryEntries(entries, visible.root, visible)).map(row => row.name));
        for (const entry of content.config[list]) if (!known.has(entry)) fail('NOT_FOUND', `${where}: ${list} names '${entry}', which is not in the ${scope === 'project' ? 'project or the library' : 'library'}`);
      }
    }
  } else if (kind === 'skills') {
    only(['body']);
    text('body', true);
  } else if (kind === 'mcp') {
    only(['server']);
    normalizeMcp({ mcpServers: { [name]: content.server } }, base(scope, { root, library }), where);
  } else if (kind === 'hooks') {
    only(['hook']);
    validateHook(content.hook, where);
  } else {
    only(['team', 'houseRules']);
    text('houseRules', false);
    validateTeam(content.team, `${where} team.json`);
    const agents = await agentSources(visible.root, visible);
    const supervisor = content.team.supervisor ? [content.team.supervisor.agent] : [];
    for (const agent of [...Object.keys(content.team.members), ...supervisor]) if (!agents.has(agent)) fail('NOT_FOUND', `${where}: agent '${agent}' is not built in, nor in the ${scope === 'project' ? 'project or the library' : 'library'}`);
  }
}

async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, file);
}

const exists = target => stat(target).then(() => true, () => false);

/**
 * Creates or replaces an entry in a scope. `revision` is what getEntry returned for
 * that scope (null to create); a different current revision refuses the save.
 * @returns {Promise<{ revision: string | null }>}
 */
export async function saveEntry(kind, name, content, { scope, root, library, templates, revision } = {}) {
  kindOf(kind); nameOf(name);
  const directory = base(scope, { root, library });
  await check(kind, name, content, { scope, root, library, templates });
  const current = await readLayer(kind, name, directory);
  if (revision !== undefined && revision !== revisionOf(current)) {
    fail('REVISION_CONFLICT', current === undefined ? `${kind} '${name}' was removed from the ${scope} since you opened it` : revision === null ? `${kind} '${name}' already exists in the ${scope}` : `${kind} '${name}' changed in the ${scope} since you opened it; reload it and apply your change again`);
  }
  for (const [file, key, type] of FILES[kind](name)) {
    const target = path.join(directory, kind, file);
    const value = content[key];
    // An empty agent.json or house rules file is no file.
    const empty = value === undefined || (type === 'json' && key === 'config' && !Object.keys(value).length) || (type === 'text' && key === 'houseRules' && !value.trim());
    if (empty) { await rm(target, { force: true }); continue; }
    await writeAtomic(target, type === 'json' ? JSON.stringify(value, null, 2) + '\n' : value.endsWith('\n') ? value : `${value}\n`);
  }
  return { revision: revisionOf(await readLayer(kind, name, directory)) };
}

/**
 * Removes an entry from a scope. When nothing else of that name is left below it, an
 * entry others refer to stays, and the error lists them.
 * @returns {Promise<{ removed: boolean, now?: 'builtin' | 'library' }>}
 */
export async function deleteEntry(kind, name, { scope, root, library, templates, revision } = {}) {
  kindOf(kind); nameOf(name);
  const directory = base(scope, { root, library });
  const current = await readLayer(kind, name, directory);
  if (current === undefined) fail('NOT_FOUND', `No ${kind} entry '${name}' in the ${scope}`);
  if (revision !== undefined && revision !== revisionOf(current)) fail('REVISION_CONFLICT', `${kind} '${name}' changed in the ${scope} since you opened it`);
  const found = await layers(kind, name, { root: scope === 'project' ? root : undefined, library: scope === 'project' ? library : undefined, templates });
  const fallback = scope === 'project' ? found.library ?? found.builtin : found.builtin;
  if (fallback === undefined) {
    const users = await usersOf(kind, name, { root, library, templates });
    if (users.length) fail('IN_USE', `${kind} '${name}' is used by ${users.join(', ')}; change them first`);
  }
  if (ownDirectory(kind)) await rm(path.join(directory, kind, name), { recursive: true, force: true });
  else for (const [file] of FILES[kind](name)) await rm(path.join(directory, kind, file), { force: true });
  /** @type {'builtin' | 'library'} */
  const now = scope === 'project' && found.library !== undefined ? 'library' : 'builtin';
  return { removed: true, ...(fallback !== undefined ? { now } : {}) };
}

/** Copies the entry that applies under `from` to a new entry `to` in a scope; built-ins are copied this way. */
export async function duplicateEntry(kind, from, to, { scope, root, library, templates } = {}) {
  const { content } = await getEntry(kind, from, { root, library, templates });
  return saveEntry(kind, to, structuredClone(content), { scope, root, library, templates, revision: null });
}

/** Renames an entry within a scope; refused while others refer to it by its old name. */
export async function renameEntry(kind, from, to, { scope, root, library, templates } = {}) {
  kindOf(kind); nameOf(from); nameOf(to);
  const directory = base(scope, { root, library });
  const content = await readLayer(kind, from, directory);
  if (content === undefined) fail('NOT_FOUND', `No ${kind} entry '${from}' in the ${scope}`);
  if (await readLayer(kind, to, directory) !== undefined) fail('REVISION_CONFLICT', `${kind} '${to}' already exists in the ${scope}`);
  const users = await usersOf(kind, from, { root, library, templates });
  if (users.length) fail('IN_USE', `${kind} '${from}' is used by ${users.join(', ')}; change them first`);
  await check(kind, to, content, { scope, root, library, templates });
  if (ownDirectory(kind)) {
    if (await exists(path.join(directory, kind, to))) fail('REVISION_CONFLICT', `${path.join(directory, kind, to)} already exists`);
    await rename(path.join(directory, kind, from), path.join(directory, kind, to));
  } else {
    await rename(path.join(directory, kind, `${from}.json`), path.join(directory, kind, `${to}.json`));
  }
  return { revision: revisionOf(await readLayer(kind, to, directory)) };
}

