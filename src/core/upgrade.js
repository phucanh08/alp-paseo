import { readFile, writeFile, mkdir, mkdtemp, lstat, readdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { initProject } from './init.js';
import { validateSettings } from './validation.js';
import { resolveDelegation } from './delegation.js';

const legacy = {
  'ALP.md': '# Project instructions\n\nAdd project-wide instructions here.\n',
  '.alp/agents/main/AGENT.md': '# Main agent\n\nHelp with tasks in this project.\n',
};
// SHA-256 of shipped role definitions after CRLF normalization. Custom
// definitions do not match and remain untouched. Keep historical IDs immutable.
const teamV1 = {
  'ALP.md': ['c2785aac6538d10e79bd6fb59b11066ccdec77287edf950fad59aa57bf3417f1', '0875293195d35d965effb70bb150d1edbc789f66f72c545f7760dea4346b1a9a'],
  '.alp/agents/main/AGENT.md': ['15d217cbc5ede782790d1086124598d9a2b5ff13bcf971a37231962fcef1b47c', 'e7201a1ed7800d7500b5c8091bd8a435aa9d5138f247c2b02b8bf76299387c90', '5001b807bbb686aa1a3b7ecadf9501428909e052e8231281454fd41cbe0ebf27', '90f9903fcc97ddf6336e1a28b81103dddc60a6038dcf74d326be8998862cb022', '9085ab906e2744a4151ae5c63dd66a545115cd4c876be1fd80f0a0ed4e623da8', 'fb55cfb0852d07592090de2c49e6c5c2b57936cbffc823dd24767c2db5e5f7fb'],
  '.alp/agents/lead/AGENT.md': ['c259b085a3c102445f97e5c7d402ca68347bcc1a9b02d6ab96e02be6d8b6f9af', '2eef2a4474f757cd89b35b50638a1b23fe49a54c26bf0dedb24a96d7117ddd92', '6c71393c9b3aa655c4731bda96396ea3ec0d4da62cddb3ad50d1a24113416b77', 'a382f0faa724e23a0ba9c212205978aa3fef87c3aecdf8823fba136e04568487', '547e3f8fc354b22c7beb3432182d68f4de1f24938375c8bfb167ae8afbf97de2'],
  '.alp/agents/peer/AGENT.md': ['f3dcf16c8c899a5378a468e922ca3956fd72cbb3e3798ed1109f11e01aa8f476', '39ccf3317eba3003faad77ebad4489fae3eb3c4d89258a03f619d1d3d65af0b7', 'c59e45e8f22eb0daca9b8b5e1b19e90666156807f160e75a21eca48b5fee1102', '9623dbf76eda598f6267629e993663c149acb0efd253f3900a4ee1eda8f2f9e7'],
  '.alp/agents/oracle/AGENT.md': ['cdce1babcd587a190dc94a32a951ed70ce2c75f99c205a4049df940851ac7059'],
  '.alp/agents/reviewer/AGENT.md': ['6eab9f918c79335a0665bf4e3a3a26b66258684d6725c4c95637e70e8d355123'],
};
/** Profiles' names before 0.4. */
const renamedProfiles = { smart: 'pho', supervised: 'cafe' };

/** A skill directory's regular files by relative path, CRLF-normalized; undefined when absent or not plain files. */
async function skillFiles(directory) {
  const files = new Map();
  async function walk(relative) {
    for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!await walk(name)) return false; }
      else if (entry.isFile()) files.set(name, (await readFile(path.join(directory, name), 'utf8')).replaceAll('\r\n', '\n'));
      else return false;
    }
    return true;
  }
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined;
    return await walk('') ? files : undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Explicit migration of the original scaffold; custom instructions remain owned by the user. */
export async function upgradeProject(projectRoot) {
  const root = path.resolve(projectRoot);
  // Validate before creating files or changing settings.
  let settingsText;
  try { settingsText = await readFile(path.join(root, '.alp/settings.json'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const settings = settingsText === undefined ? undefined : JSON.parse(settingsText);
  if (settings !== undefined) validateSettings(settings, '.alp/settings.json');
  await resolveDelegation(root);
  const result = { ...await initProject(root), updated: [], removed: [], customSkills: [], customInstructions: [], backup: undefined };
  async function backupPath(name) {
    if (!result.backup) {
      const backups = path.join(root, '.alp/backups');
      await mkdir(backups, { recursive: true });
      result.backup = await mkdtemp(path.join(backups, 'upgrade-'));
    }
    const backup = path.join(result.backup, name);
    await mkdir(path.dirname(backup), { recursive: true });
    return backup;
  }
  async function replace(name, before, after) {
    const target = path.join(root, name);
    if (!(await lstat(target)).isFile() || await readFile(target, 'utf8') !== before) throw new Error(`File changed during upgrade: ${target}`);
    const backup = await backupPath(name);
    await writeFile(backup, before, { flag: 'wx' });
    await writeFile(target, after);
    result.updated.push(name);
  }
  for (const name of ['ALP.md']) {
    const current = await readFile(path.join(root, name), 'utf8');
    const template = name === 'ALP.md' ? 'ALP.md' : name.slice('.alp/'.length);
    const desired = await readFile(new URL(`../../templates/${template}`, import.meta.url), 'utf8');
    const normalized = current.replaceAll('\r\n', '\n');
    const known = normalized === legacy[name] || teamV1[name]?.includes(createHash('sha256').update(normalized).digest('hex'));
    if (current !== desired && known) await replace(name, current, desired);
    else if (current !== desired) result.customInstructions.push(name);
  }
  const oldGraph = settings?.delegation;
  const shippedGraph = oldGraph && Object.keys(oldGraph).length === 2 && JSON.stringify(oldGraph.main) === '["lead"]' && JSON.stringify(oldGraph.lead) === '["peer"]';
  if (settings !== undefined && settings.workflow === undefined && (oldGraph === undefined || shippedGraph)) {
    await replace('.alp/settings.json', settingsText, JSON.stringify({ ...settings, ...(shippedGraph ? { delegation: undefined } : {}), workflow: { mode: shippedGraph ? 'cafe' : 'pho', maxPeers: 2 } }, null, 2) + '\n');
  } else if (settings !== undefined && Object.hasOwn(renamedProfiles, settings.workflow?.mode)) {
    await replace('.alp/settings.json', settingsText, JSON.stringify({ ...settings, workflow: { ...settings.workflow, mode: renamedProfiles[settings.workflow.mode] } }, null, 2) + '\n');
  }
  // Skills now come from the user's library; archive project copies that still match what ALP shipped.
  const shipped = JSON.parse(await readFile(new URL('../../templates/role-skills.json', import.meta.url), 'utf8'));
  for (const [role, skills] of Object.entries(shipped)) {
    for (const skill of skills) {
      const relative = `.alp/agents/${role}/skills/${skill}`;
      const files = await skillFiles(path.join(root, relative));
      if (!files) continue;
      const template = await skillFiles(fileURLToPath(new URL(`../../templates/skills/${skill}`, import.meta.url)));
      const same = template && files.size === template.size && [...files].every(([name, text]) => template.get(name) === text);
      if (!same) { result.customSkills.push(relative); continue; }
      for (const name of files.keys()) await rename(path.join(root, relative, name), await backupPath(`${relative}/${name}`));
      await rm(path.join(root, relative), { recursive: true });
      result.removed.push(relative);
    }
  }
  // Retire only the exact previously shipped router; archive it outside discovery.
  for (const role of ['main', 'lead', 'peer']) {
    const relative = `.alp/agents/${role}/skills/ask-alp`;
    const directory = path.join(root, relative);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) { result.customSkills.push(relative); continue; }
      const names = await readdir(directory);
      const file = path.join(directory, 'SKILL.md');
      if (names.length !== 1 || names[0] !== 'SKILL.md' || !(await lstat(file)).isFile()) { result.customSkills.push(relative); continue; }
      const content = await readFile(file, 'utf8');
      const hash = createHash('sha256').update(content.replaceAll('\r\n', '\n')).digest('hex');
      if (hash !== 'f38128fafa2e8a75a0237a2fda9a71fc92ed3f1e0e62878db50e5a07376f2108') { result.customSkills.push(relative); continue; }
      await rename(file, await backupPath(`${relative}/SKILL.md`));
      await rmdir(directory);
      result.removed.push(relative);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await retireAgentCopies(root, result, backupPath, replace);
  return result;
}

const known = (name, text) => {
  const normalized = text.replaceAll('\r\n', '\n');
  return normalized === legacy[name] || teamV1[name]?.includes(createHash('sha256').update(normalized).digest('hex'));
};

/** An agent directory's entries apart from AGENT.md, when they hold nothing: an empty .mcp.json and empty skills/ and hooks/. */
async function onlyInstructions(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'AGENT.md' && entry.isFile()) continue;
    if (entry.name === '.mcp.json' && entry.isFile()) {
      try { const mcp = JSON.parse(await readFile(path.join(directory, entry.name), 'utf8')); if (!Object.keys(mcp.mcpServers ?? {}).length && Object.keys(mcp).every(key => key === 'mcpServers')) continue; } catch {}
      return false;
    }
    if ((entry.name === 'skills' || entry.name === 'hooks') && entry.isDirectory() && !(await readdir(path.join(directory, entry.name))).length) continue;
    return false;
  }
  return true;
}

/**
 * Projects used to get a copy of each built-in agent (ALPD §41). A copy that is still
 * what ALP shipped, with nothing added, is backed up and removed, so the project uses
 * the built-in and its updates. A shipped copy the user added skills, MCP servers or
 * hooks to stays as the project's override, with its instructions brought up to date;
 * customized instructions stay as they are.
 */
async function retireAgentCopies(root, result, backupPath, replace) {
  for (const name of ['main', 'lead', 'peer', 'oracle', 'reviewer', 'supervisor']) {
    const relative = `.alp/agents/${name}`;
    const directory = path.join(root, relative);
    const info = await lstat(directory).catch(() => undefined);
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    const file = `${relative}/AGENT.md`;
    const current = await readFile(path.join(root, file), 'utf8').catch(() => undefined);
    if (current === undefined) continue;
    const desired = await readFile(new URL(`../../templates/agents/${name}/AGENT.md`, import.meta.url), 'utf8');
    const shipped = current === desired || known(file, current);
    if (!shipped) { result.customInstructions.push(file); continue; }
    if (await onlyInstructions(directory)) {
      // Its empty skills/ and hooks/ go; its files go to the backup, beside any skills archived above.
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await rmdir(path.join(directory, entry.name));
        else await rename(path.join(directory, entry.name), await backupPath(`${relative}/${entry.name}`));
      }
      await rmdir(directory);
      result.removed.push(relative);
    } else if (current !== desired) {
      await replace(file, current, desired);
    }
  }
  await rmdir(path.join(root, '.alp/agents')).catch(() => {});
}
