import { mkdir, writeFile, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Fill missing scaffold files without replacing existing user content: ALP.md and
 * .alp/settings.json. Agents, skills, MCP servers and hooks come from ALP's built-ins
 * and the user's library (ALPD §41); a project adds its own under .alp/ only to
 * override them.
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
    '.alp/settings.json': JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'pho' } }, null, 2) + '\n',
  };
  const directories = ['.alp'];
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
