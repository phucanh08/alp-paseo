import { readFile, writeFile, mkdir, mkdtemp, lstat, readdir, rename, rmdir } from 'node:fs/promises';
import path from 'node:path';
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
  'ALP.md': ['c2785aac6538d10e79bd6fb59b11066ccdec77287edf950fad59aa57bf3417f1'],
  '.alp/agents/main/AGENT.md': ['15d217cbc5ede782790d1086124598d9a2b5ff13bcf971a37231962fcef1b47c', 'e7201a1ed7800d7500b5c8091bd8a435aa9d5138f247c2b02b8bf76299387c90', '5001b807bbb686aa1a3b7ecadf9501428909e052e8231281454fd41cbe0ebf27', '90f9903fcc97ddf6336e1a28b81103dddc60a6038dcf74d326be8998862cb022'],
  '.alp/agents/lead/AGENT.md': ['c259b085a3c102445f97e5c7d402ca68347bcc1a9b02d6ab96e02be6d8b6f9af', '2eef2a4474f757cd89b35b50638a1b23fe49a54c26bf0dedb24a96d7117ddd92', '6c71393c9b3aa655c4731bda96396ea3ec0d4da62cddb3ad50d1a24113416b77'],
  '.alp/agents/peer/AGENT.md': ['f3dcf16c8c899a5378a468e922ca3956fd72cbb3e3798ed1109f11e01aa8f476', '39ccf3317eba3003faad77ebad4489fae3eb3c4d89258a03f619d1d3d65af0b7', 'c59e45e8f22eb0daca9b8b5e1b19e90666156807f160e75a21eca48b5fee1102'],
};

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
  for (const name of new Set([...Object.keys(legacy), ...Object.keys(teamV1)])) {
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
    await replace('.alp/settings.json', settingsText, JSON.stringify({ ...settings, ...(shippedGraph ? { delegation: undefined } : {}), workflow: { mode: shippedGraph ? 'supervised' : 'smart', maxPeers: 2 } }, null, 2) + '\n');
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
  return result;
}
