import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AlpError } from './errors.js';
import { validateAgentConfig, validateHook, validateSettings, normalizeMcp, validateResolvedAgent } from './validation.js';
import { librarySkills } from './library.js';
export { AlpError } from './errors.js';

export async function optionalText(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

export async function jsonObject(file, code) {
  const text = await optionalText(file);
  if (text === undefined) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object');
    return value;
  } catch (cause) { throw new AlpError(code, `${file}: ${cause.message}`, { cause }); }
}

async function entries(directory) {
  try { return (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

/** The agents ALP ships; their files come from the package's templates. */
export const BUILTIN_AGENTS = ['main', 'lead', 'peer', 'oracle', 'reviewer', 'supervisor'];
const TEMPLATE_ROOT = new URL('../../templates/', import.meta.url);
const validName = name => typeof name === 'string' && /^[\w.-]+$/.test(name) && name !== '.' && name !== '..';

/** A shipped template file, from `templates` when given (bundles embed them), else from the package. */
export async function builtinText(relative, templates) {
  if (templates) return templates[relative];
  try { return await readFile(new URL(relative, TEMPLATE_ROOT), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined; throw error; }
}

/**
 * Where each agent comes from (ALPD §41): ALP's built-ins, then the user's library
 * (`library`, ALP_HOME), then the project's `.alp/agents`. A later layer replaces an
 * agent of the same name entirely.
 * @returns {Promise<Map<string, { source: 'builtin' | 'library' | 'project', directory?: string, overrides?: 'builtin' | 'library' }>>}
 */
export async function agentSources(root, { library, templates } = {}) {
  const found = new Map();
  for (const name of BUILTIN_AGENTS) if (await builtinText(`agents/${name}/AGENT.md`, templates) !== undefined) found.set(name, { source: 'builtin' });
  const layer = async (directory, source) => {
    for (const entry of await entries(directory)) {
      if (!entry.isDirectory() || !validName(entry.name)) continue;
      // A library entry needs its instructions; a project directory always counts, as before, and reports a missing AGENT.md when used.
      if (source === 'library' && (await optionalText(path.join(directory, entry.name, 'AGENT.md'))) === undefined) continue;
      const previous = found.get(entry.name);
      found.set(entry.name, { source, directory: path.join(directory, entry.name), ...(previous ? { overrides: previous.source } : {}) });
    }
  };
  if (library) await layer(path.join(library, 'agents'), 'library');
  await layer(path.join(path.resolve(root), '.alp', 'agents'), 'project');
  return found;
}

export async function discoverAgents(root, options = {}) {
  return [...(await agentSources(root, options)).keys()].sort((a, b) => a.localeCompare(b));
}

/** What a library kind holds, and the file that defines each entry. */
const KINDS = {
  skills: name => path.join(name, 'SKILL.md'),
  mcp: name => `${name}.json`,
  hooks: name => `${name}.json`,
};
export const LIBRARY_KINDS = ['agents', ...Object.keys(KINDS)];

/**
 * Every entry of one kind with where it comes from (ALPD §41): `agents`, `skills`, `mcp`
 * or `hooks`. A project entry overrides a library one of the same name. `usedBy` lists
 * the agents that name a skill, MCP server or hook; for skills it includes the roles
 * role-skills.json gives it.
 * @returns {Promise<Array<{ name: string, source: 'builtin' | 'library' | 'project', path?: string, overrides?: 'builtin' | 'library', description?: string, usedBy?: string[] }>>}
 */
export async function libraryEntries(kind, projectRoot, { library, templates } = {}) {
  const root = path.resolve(projectRoot);
  if (kind === 'agents') {
    const rows = [];
    for (const [name, source] of await agentSources(root, { library, templates })) {
      const text = source.directory ? await optionalText(path.join(source.directory, 'agent.json')) : await builtinText(`agents/${name}/agent.json`, templates);
      let description;
      try { description = text === undefined ? undefined : JSON.parse(text).description; } catch {}
      rows.push({ name, source: source.source, ...(source.directory ? { path: source.directory } : {}), ...(source.overrides ? { overrides: source.overrides } : {}), ...(typeof description === 'string' ? { description } : {}) });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }
  const file = KINDS[kind];
  if (!file) throw new AlpError('INVALID_KIND', `Unknown library kind '${kind}'; use one of ${LIBRARY_KINDS.join(', ')}`);
  const found = new Map();
  const layer = async (directory, source) => {
    for (const entry of await entries(directory)) {
      const name = kind === 'skills' ? (entry.isDirectory() ? entry.name : undefined) : (entry.isFile() && entry.name.endsWith('.json') ? entry.name.slice(0, -5) : undefined);
      if (!name || !validName(name)) continue;
      const entryPath = path.join(directory, file(name));
      if (!(await stat(entryPath).then(info => info.isFile(), () => false))) continue;
      const previous = found.get(name);
      found.set(name, { name, source, path: entryPath, ...(previous ? { overrides: previous.source } : {}) });
    }
  };
  if (library) await layer(path.join(library, kind), 'library');
  await layer(path.join(root, '.alp', kind), 'project');
  // Who uses each entry: the agents naming it in agent.json, and for skills the roles given it.
  const users = new Map();
  const use = (name, agent) => users.set(name, [...new Set([...(users.get(name) ?? []), agent])]);
  for (const [agent, source] of await agentSources(root, { library, templates })) {
    const text = source.directory ? await optionalText(path.join(source.directory, 'agent.json')) : await builtinText(`agents/${agent}/agent.json`, templates);
    try { for (const name of (text === undefined ? {} : JSON.parse(text))[kind] ?? []) use(name, agent); } catch {}
  }
  if (kind === 'skills' && library) {
    try { for (const [role, names] of Object.entries(JSON.parse((await optionalText(path.join(library, 'role-skills.json'))) ?? '{}'))) for (const name of Array.isArray(names) ? names : []) use(name, role); } catch {}
  }
  return [...found.values()].map(row => ({ ...row, ...(users.has(row.name) ? { usedBy: users.get(row.name).sort() } : {}) })).sort((a, b) => a.name.localeCompare(b.name));
}

/** A named entry of a library kind (skills, mcp, hooks): the project's first, then the library's. */
async function namedEntry(root, library, kind, name, file) {
  const candidates = [path.join(root, '.alp', kind, file(name)), ...(library ? [path.join(library, kind, file(name))] : [])];
  for (const candidate of candidates) if (await stat(candidate).then(info => info.isFile(), () => false)) return candidate;
  return undefined;
}

/**
 * `library` is the user's library (ALP_HOME): its agents and the skills, MCP servers and
 * hooks agents name. The agent's own skills/ directory replaces a skill of the same name.
 * @returns {Promise<import('./types.js').ResolvedAgent>}
 */
export async function resolveAgent(projectRoot, { agent, library, templates } = {}) {
  const root = path.resolve(projectRoot);
  const settingsPath = path.join(root, '.alp', 'settings.json');
  const settings = await jsonObject(settingsPath, 'INVALID_SETTINGS');
  const projectRuntime = validateSettings(settings, settingsPath);
  const name = agent ?? settings.defaultAgent ?? 'main';
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[\\/\x00]/.test(name)) {
    throw new AlpError('INVALID_AGENT', 'Agent name must be a single nonempty directory name');
  }
  const source = (await agentSources(root, { library, templates })).get(name);
  if (!source) throw new AlpError('AGENT_NOT_FOUND', `Agent '${name}' not found: it is not built in, nor under ${library ? `${path.join(library, 'agents')} or ` : ''}${path.join(root, '.alp', 'agents')}`);
  const directory = source.directory;
  const agentPath = directory ? path.join(directory, 'AGENT.md') : `built-in agents/${name}/AGENT.md`;
  const instructions = directory ? await optionalText(agentPath) : await builtinText(`agents/${name}/AGENT.md`, templates);
  if (instructions === undefined) throw new AlpError('AGENT_INSTRUCTIONS_MISSING', `Missing ${agentPath}`);
  const configPath = directory ? path.join(directory, 'agent.json') : `built-in agents/${name}/agent.json`;
  const configText = directory ? await optionalText(configPath) : await builtinText(`agents/${name}/agent.json`, templates);
  let config = {};
  if (configText !== undefined) {
    try { config = JSON.parse(configText); }
    catch (cause) { throw new AlpError('INVALID_AGENT_CONFIG', `${configPath}: ${cause.message}`, { cause }); }
  }
  validateAgentConfig(config, configPath);

  // The role's library skills; a project skill of the same name in .alp/skills replaces one.
  const skills = [];
  for (const skill of library ? await librarySkills(library, name) : []) {
    skills.push({ name: skill.name, path: (await namedEntry(root, undefined, 'skills', skill.name, entry => path.join(entry, 'SKILL.md'))) ?? skill.path });
  }
  const addSkill = (skillName, skillPath) => {
    const shadowed = skills.findIndex(skill => skill.name === skillName);
    if (shadowed >= 0) skills.splice(shadowed, 1);
    skills.push({ name: skillName, path: skillPath });
  };
  for (const skillName of config.skills ?? []) {
    const skillPath = await namedEntry(root, library, 'skills', skillName, entry => path.join(entry, 'SKILL.md'));
    if (!skillPath) throw new AlpError('SKILL_NOT_FOUND', `${configPath}: skill '${skillName}' is neither in ${path.join(root, '.alp', 'skills')} nor in the library`);
    addSkill(skillName, skillPath);
  }
  if (directory) {
    for (const entry of await entries(path.join(directory, 'skills'))) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(directory, 'skills', entry.name, 'SKILL.md');
      try { if ((await stat(skillPath)).isFile()) addSkill(entry.name, skillPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));

  const hooks = directory ? (await entries(path.join(directory, 'hooks'))).filter(e => e.isFile()).map(e => ({ name: e.name, path: path.join(directory, 'hooks', e.name) })) : [];
  for (const hookName of config.hooks ?? []) {
    const hookPath = await namedEntry(root, library, 'hooks', hookName, entry => `${entry}.json`);
    if (!hookPath) throw new AlpError('HOOK_NOT_FOUND', `${configPath}: hook '${hookName}' is neither in ${path.join(root, '.alp', 'hooks')} nor in the library`);
    validateHook(await jsonObject(hookPath, 'INVALID_HOOK'), hookPath);
    hooks.push({ name: hookName, path: hookPath });
  }

  // Named MCP servers first, then the agent's own .mcp.json; a name used twice is an error.
  const servers = {};
  for (const serverName of config.mcp ?? []) {
    const serverPath = await namedEntry(root, library, 'mcp', serverName, entry => `${entry}.json`);
    if (!serverPath) throw new AlpError('MCP_NOT_FOUND', `${configPath}: MCP server '${serverName}' is neither in ${path.join(root, '.alp', 'mcp')} nor in the library`);
    const definition = await jsonObject(serverPath, 'INVALID_MCP');
    Object.assign(servers, normalizeMcp({ mcpServers: { [serverName]: definition } }, path.dirname(serverPath), serverPath).mcpServers);
  }
  const mcpPath = directory ? path.join(directory, '.mcp.json') : undefined;
  const own = mcpPath ? normalizeMcp(await jsonObject(mcpPath, 'INVALID_MCP'), directory, mcpPath).mcpServers : {};
  for (const [serverName, server] of Object.entries(own)) {
    if (Object.hasOwn(servers, serverName)) throw new AlpError('INVALID_MCP', `${mcpPath}: MCP server '${serverName}' is also named in ${configPath}`);
    servers[serverName] = server;
  }

  // The agent's own provider, model and thinking come before the project's defaults.
  const runtime = {
    ...projectRuntime,
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.thinking !== undefined ? { reasoning: config.thinking } : {}),
  };
  return validateResolvedAgent({
    name, projectRoot: root, source: source.source,
    instructions: { project: (await optionalText(path.join(root, 'ALP.md'))) ?? '', agent: instructions },
    skills, hooks, runtime,
    ...(config.mode !== undefined ? { mode: config.mode } : {}),
    ...(config.description !== undefined ? { description: config.description } : {}),
    mcp: { mcpServers: servers },
  });
}
