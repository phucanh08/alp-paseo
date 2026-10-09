import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { AlpError } from './errors.js';
import { builtinText, optionalText } from './resolver.js';
import { settingsKeys, unknownMessage } from './validation.js';

/**
 * Teams (ALPD §42): a main agent, its members, who may delegate to whom, and the
 * house rules every member follows. Phở and Cafe ship as built-in teams; the user's
 * library (ALP_HOME/teams) and the project (.alp/teams) add teams or override one by
 * its id, the later layer replacing the team whole.
 */

export const BUILTIN_TEAMS = ['pho', 'cafe'];
export const TEAM_SETTINGS = ['$schema', 'label', 'description', 'main', 'members', 'delegation', 'maxPeers', 'supervisor'];
export const TEAM_ROLES = ['lead', 'peer', 'advisor', 'reviewer'];
const MEMBER_SETTINGS = ['role', 'model', 'thinking'];
const SUPERVISOR_SETTINGS = ['agent', 'model', 'thinking'];

/** Names of teams before they were renamed; settings and resumed sessions may still carry them. */
const aliases = { smart: 'pho', supervised: 'cafe' };
/** The team an id selects, accepting the old names. */
export const teamOf = id => aliases[id] ?? id;

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const validName = name => typeof name === 'string' && /^[\w.-]+$/.test(name) && name !== '.' && name !== '..';

function keys(value, known, check, where) {
  const { unknown } = settingsKeys(value, known);
  check(!unknown.length, unknown.length ? `${where}${unknownMessage(unknown[0], known)}` : '');
}

/** Checks a team.json; the delegation graph must name members and stay acyclic. */
export function validateTeam(config, source) {
  const check = (ok, message) => { if (!ok) throw new AlpError('INVALID_TEAM', `${source}: ${message}`); };
  check(object(config), 'expected an object');
  keys(config, TEAM_SETTINGS, check, '');
  check(nonempty(config.label), 'label must be a nonempty string');
  if (config.description !== undefined) check(typeof config.description === 'string', 'description must be a string');
  check(validName(config.main), 'main must name an agent');
  check(object(config.members), 'members must map agent names to { role, model, thinking }');
  check(Object.hasOwn(config.members, config.main), `members must include main (${config.main})`);
  for (const [name, member] of Object.entries(config.members)) {
    const where = `members.${name}`;
    check(validName(name) && object(member), `${where} must be an object under an agent name`);
    keys(member, MEMBER_SETTINGS, check, `${where}: `);
    if (name === config.main) check(member.role === undefined || member.role === 'main', `${where}.role: main's role is main`);
    else check(TEAM_ROLES.includes(member.role), `${where}.role must be one of ${TEAM_ROLES.join(', ')}`);
    for (const key of ['model', 'thinking']) if (member[key] !== undefined) check(nonempty(member[key]), `${where}.${key} must be a nonempty string`);
  }
  check(object(config.delegation), 'delegation must map members to the members they may delegate to');
  for (const [owner, targets] of Object.entries(config.delegation)) {
    check(Object.hasOwn(config.members, owner), `delegation.${owner}: not a member`);
    check(Array.isArray(targets) && new Set(targets).size === targets.length, `delegation.${owner} must list members once each`);
    for (const target of targets) check(Object.hasOwn(config.members, target) && target !== config.main, `delegation.${owner}: ${target} is not a member main can be assigned to`);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = owner => {
    check(!visiting.has(owner), `delegation cycle at '${owner}'`);
    if (visited.has(owner)) return;
    visiting.add(owner);
    for (const target of config.delegation[owner] ?? []) visit(target);
    visiting.delete(owner);
    visited.add(owner);
  };
  for (const owner of Object.keys(config.delegation)) visit(owner);
  if (config.maxPeers !== undefined) check(Number.isSafeInteger(config.maxPeers) && config.maxPeers >= 1, 'maxPeers must be a positive integer');
  if (config.supervisor !== undefined && config.supervisor !== false) {
    check(object(config.supervisor), 'supervisor must be false or { agent, model, thinking }');
    keys(config.supervisor, SUPERVISOR_SETTINGS, check, 'supervisor: ');
    check(validName(config.supervisor.agent), 'supervisor.agent must name an agent');
    check(!Object.hasOwn(config.members, config.supervisor.agent), 'supervisor.agent watches the team and cannot be a member');
    for (const key of ['model', 'thinking']) if (config.supervisor[key] !== undefined) check(nonempty(config.supervisor[key]), `supervisor.${key} must be a nonempty string`);
  }
  return config;
}

async function directories(directory) {
  try { return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() && validName(entry.name)).map(entry => entry.name).sort(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/**
 * Where each team comes from: built in, then the library, then the project. A team
 * directory counts only with a team.json. `root` may be undefined outside a project.
 * @returns {Promise<Map<string, { source: 'builtin' | 'library' | 'project', directory?: string, overrides?: 'builtin' | 'library' }>>}
 */
export async function teamSources(root, { library, templates } = {}) {
  const found = new Map();
  for (const id of BUILTIN_TEAMS) if (await builtinText(`teams/${id}/team.json`, templates) !== undefined) found.set(id, { source: 'builtin' });
  const layer = async (directory, source) => {
    for (const id of await directories(directory)) {
      if ((await optionalText(path.join(directory, id, 'team.json'))) === undefined) continue;
      const previous = found.get(id);
      found.set(id, { source, directory: path.join(directory, id), ...(previous ? { overrides: previous.source } : {}) });
    }
  };
  if (library) await layer(path.join(library, 'teams'), 'library');
  // Without a project, only the built-ins and the library apply.
  if (root !== undefined) await layer(path.join(path.resolve(root), '.alp', 'teams'), 'project');
  return found;
}

/**
 * A team by id, with its house rules.
 * @returns {Promise<{ id: string, source: 'builtin' | 'library' | 'project', label: string, description?: string, main: string,
 *   members: Record<string, { role?: string, model?: string, thinking?: string }>, delegation: Record<string, string[]>,
 *   maxPeers?: number, supervisor: false | { agent: string, model?: string, thinking?: string }, houseRules: string }>}
 */
export async function resolveTeam(root, id, { library, templates } = {}) {
  const team = teamOf(id);
  const sources = await teamSources(root, { library, templates });
  const found = sources.get(team);
  if (!found) throw new AlpError('TEAM_NOT_FOUND', `Team '${id}' not found; teams: ${[...sources.keys()].join(', ')}`);
  const where = found.directory ? path.join(found.directory, 'team.json') : `built-in teams/${team}/team.json`;
  const text = found.directory ? await optionalText(where) : await builtinText(`teams/${team}/team.json`, templates);
  let config;
  try { config = JSON.parse(text ?? ''); }
  catch (cause) { throw new AlpError('INVALID_TEAM', `${where}: ${cause.message}`, { cause }); }
  validateTeam(config, where);
  const houseRules = (found.directory ? await optionalText(path.join(found.directory, 'HOUSE_RULES.md')) : await builtinText(`teams/${team}/HOUSE_RULES.md`, templates)) ?? '';
  return {
    id: team, source: found.source, label: config.label,
    ...(config.description !== undefined ? { description: config.description } : {}),
    main: config.main, members: config.members, delegation: config.delegation,
    ...(config.maxPeers !== undefined ? { maxPeers: config.maxPeers } : {}),
    supervisor: config.supervisor ?? false,
    houseRules: houseRules.trim(),
  };
}

/**
 * Every team a project can use, in order: built-in, library, project; with what each overrides.
 * A team that does not load is listed with its error.
 * @param {string | undefined} root
 * @param {{ library?: string, templates?: Record<string, string> }} [options]
 * @returns {Promise<Array<{ id: string, source: 'builtin' | 'library' | 'project', label?: string, description?: string, overrides?: 'builtin' | 'library', path?: string, error?: string }>>}
 */
export async function listTeams(root, options = {}) {
  /** @type {Array<{ id: string, source: 'builtin' | 'library' | 'project', label?: string, description?: string, overrides?: 'builtin' | 'library', path?: string, error?: string }>} */
  const rows = [];
  for (const [id, source] of await teamSources(root, options)) {
    let team;
    try { team = await resolveTeam(root, id, options); }
    catch (error) { rows.push({ id, source: source.source, ...(source.overrides ? { overrides: source.overrides } : {}), error: error.message }); continue; }
    rows.push({ id, source: source.source, label: team.label, ...(team.description !== undefined ? { description: team.description } : {}), ...(source.overrides ? { overrides: source.overrides } : {}), ...(source.directory ? { path: source.directory } : {}) });
  }
  const rank = { builtin: 0, library: 1, project: 2 };
  return rows.sort((a, b) => rank[a.source] - rank[b.source] || (BUILTIN_TEAMS.indexOf(a.id) + 1 || 99) - (BUILTIN_TEAMS.indexOf(b.id) + 1 || 99) || a.id.localeCompare(b.id));
}
