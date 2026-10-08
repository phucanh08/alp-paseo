import { mkdir, writeFile, lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const starterAgents = ['main', 'lead', 'peer', 'oracle', 'reviewer'];

/**
 * Fill missing scaffold files without replacing existing user content.
 * @param {string} projectRoot
 * @param {{ templateRoot?: URL, templates?: Record<string, string> }} [options]
 */
export async function initProject(projectRoot, { templateRoot, templates } = {}) {
  const root = path.resolve(projectRoot);
  const sourceRoot = () => templateRoot ?? new URL('../../templates/', import.meta.url);
  const template = name => templates ? Promise.resolve(templates[name]) : readFile(new URL(name, sourceRoot()), 'utf8');
  // Load the complete starter before modifying the destination.
  const files = {
    'ALP.md': await template('ALP.md'),
    '.alp/settings.json': JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'smart', maxPeers: 2 } }, null, 2) + '\n',
  };
  const directories = ['.alp', '.alp/agents'];
  const roleSkills = JSON.parse(await template('role-skills.json'));
  async function collectSkill(source, destination) {
    if (templates) {
      for (const [name, content] of Object.entries(templates)) {
        if (!name.startsWith(`${source}/`)) continue;
        const target = `${destination}/${name.slice(source.length + 1)}`;
        directories.push(path.posix.dirname(target));
        files[target] = content;
      }
      return;
    }
    directories.push(destination);
    const entries = await readdir(new URL(`${source}/`, sourceRoot()), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) await collectSkill(`${source}/${entry.name}`, `${destination}/${entry.name}`);
      else if (entry.isFile()) files[`${destination}/${entry.name}`] = await template(`${source}/${entry.name}`);
      else throw new Error(`Unsupported skill template entry: ${source}/${entry.name}`);
    }
  }
  for (const name of starterAgents) {
    const directory = `.alp/agents/${name}`;
    directories.push(directory, `${directory}/skills`, `${directory}/hooks`);
    files[`${directory}/AGENT.md`] = await template(`agents/${name}/AGENT.md`);
    files[`${directory}/.mcp.json`] = '{\n  "mcpServers": {}\n}\n';
    for (const skill of roleSkills[name]) await collectSkill(`skills/${skill}`, `${directory}/skills/${skill}`);
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
