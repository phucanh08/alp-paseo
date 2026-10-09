import { mkdir, writeFile, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

const starterAgents = ['main', 'lead', 'peer', 'oracle', 'reviewer', 'supervisor'];

/**
 * Fill missing scaffold files without replacing existing user content.
 * Skills live in the user's library (library.js); an agent's skills/ directory
 * starts empty and holds only skills meant for this project.
 * `agents` limits the starter agents to fill, for a project that only lacks a newer one.
 * @param {string} projectRoot
 * @param {{ templateRoot?: URL, templates?: Record<string, string>, agents?: string[] }} [options]
 */
export async function initProject(projectRoot, { templateRoot, templates, agents = starterAgents } = {}) {
  const root = path.resolve(projectRoot);
  const sourceRoot = () => templateRoot ?? new URL('../../templates/', import.meta.url);
  const template = name => templates ? Promise.resolve(templates[name]) : readFile(new URL(name, sourceRoot()), 'utf8');
  // Load the complete starter before modifying the destination.
  const files = {
    'ALP.md': await template('ALP.md'),
    '.alp/settings.json': JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'pho', maxPeers: 2 } }, null, 2) + '\n',
  };
  const directories = ['.alp', '.alp/agents'];
  for (const name of starterAgents.filter(agent => agents.includes(agent))) {
    const directory = `.alp/agents/${name}`;
    directories.push(directory, `${directory}/skills`, `${directory}/hooks`);
    files[`${directory}/AGENT.md`] = await template(`agents/${name}/AGENT.md`);
    files[`${directory}/.mcp.json`] = '{\n  "mcpServers": {}\n}\n';
  }
  const created = [];
  const preserved = [];
  await mkdir(root, { recursive: true });
  for (const directory of directories) {
    const target = path.join(root, directory);
    try {
      await mkdir(target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await lstat(target)).isDirectory()) throw new Error(`Expected a directory: ${target}`);
    }
  }
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, name);
    try {
      await writeFile(target, content, { flag: 'wx' });
      created.push(name);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await lstat(target)).isFile()) throw new Error(`Expected a regular file: ${target}`);
      preserved.push(name);
    }
  }
  return { created, preserved };
}
