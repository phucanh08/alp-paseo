import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AlpError } from './errors.js';
import { validateSettings, normalizeMcp, validateResolvedAgent } from './validation.js';
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

export async function discoverAgents(root) {
  return (await entries(path.join(root, '.alp', 'agents'))).filter(e => e.isDirectory()).map(e => e.name);
}

/** @returns {Promise<import('./types.js').ResolvedAgent>} */
export async function resolveAgent(projectRoot, { agent } = {}) {
  const root = path.resolve(projectRoot);
  const settingsPath = path.join(root, '.alp', 'settings.json');
  const settings = await jsonObject(settingsPath, 'INVALID_SETTINGS');
  const runtime = validateSettings(settings, settingsPath);
  const name = agent ?? settings.defaultAgent ?? 'main';
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[\\/\x00]/.test(name)) {
    throw new AlpError('INVALID_AGENT', 'Agent name must be a single nonempty directory name');
  }
  if (!(await discoverAgents(root)).includes(name)) throw new AlpError('AGENT_NOT_FOUND', `Agent '${name}' not found under ${path.join(root, '.alp', 'agents')}`);
  const directory = path.join(root, '.alp', 'agents', name);
  const agentPath = path.join(directory, 'AGENT.md');
  const instructions = await optionalText(agentPath);
  if (instructions === undefined) throw new AlpError('AGENT_INSTRUCTIONS_MISSING', `Missing ${agentPath}`);
  const skills = [];
  for (const entry of await entries(path.join(directory, 'skills'))) {
    if (entry.isDirectory()) {
      const skillPath = path.join(directory, 'skills', entry.name, 'SKILL.md');
      try { if ((await stat(skillPath)).isFile()) skills.push({ name: entry.name, path: skillPath }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const hooks = (await entries(path.join(directory, 'hooks'))).filter(e => e.isFile()).map(e => ({ name: e.name, path: path.join(directory, 'hooks', e.name) }));
  const mcpPath = path.join(directory, '.mcp.json');
  return validateResolvedAgent({
    name, projectRoot: root,
    instructions: { project: (await optionalText(path.join(root, 'ALP.md'))) ?? '', agent: instructions },
    skills, hooks, runtime,
    mcp: normalizeMcp(await jsonObject(mcpPath, 'INVALID_MCP'), directory, mcpPath),
  });
}
