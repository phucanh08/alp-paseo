import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initProject } from '../../src/core/init.js';

export const BUILTIN = ['main', 'lead', 'peer', 'oracle', 'reviewer', 'supervisor'];

/** A project as `alp init` made it before ALPD §41: ALP.md, settings and a copy of each built-in agent. */
export async function legacyProject(root, agents = BUILTIN) {
  await initProject(root);
  for (const name of agents) {
    const directory = path.join(root, '.alp/agents', name);
    for (const sub of ['skills', 'hooks']) await mkdir(path.join(directory, sub), { recursive: true });
    await writeFile(path.join(directory, 'AGENT.md'), await readFile(new URL(`../../templates/agents/${name}/AGENT.md`, import.meta.url), 'utf8'));
    await writeFile(path.join(directory, '.mcp.json'), '{\n  "mcpServers": {}\n}\n');
  }
}
