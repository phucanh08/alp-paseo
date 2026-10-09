import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AlpError } from './errors.js';

/**
 * The user's skill library: skills and the skills each role gets, kept in
 * ALP_HOME and shared by every project. ALP seeds it from its templates once,
 * then updates only files the user has not changed; a file the user edited or
 * deleted stays that way across app updates.
 */

/** ALP_HOME, the user's ALP directory: alpd's home and the skill library. */
export function alpHome(env = process.env) {
  return path.resolve(env.ALP_HOME || path.join(os.homedir(), '.alp'));
}

const MANIFEST = 'library.json';
const sha = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');

async function optional(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

/** Shipped library files: role-skills.json and every file under skills/. */
async function shippedFiles({ templateRoot, templates }) {
  if (templates) return Object.fromEntries(Object.entries(templates).filter(([name]) => name === 'role-skills.json' || name.startsWith('skills/')));
  const root = templateRoot ?? new URL('../../templates/', import.meta.url);
  const files = { 'role-skills.json': await readFile(new URL('role-skills.json', root), 'utf8') };
  async function walk(relative) {
    for (const entry of await readdir(new URL(`${relative}/`, root), { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(`${relative}/${entry.name}`);
      else if (entry.isFile()) files[`${relative}/${entry.name}`] = await readFile(new URL(`${relative}/${entry.name}`, root), 'utf8');
    }
  }
  await walk('skills');
  return files;
}

/**
 * Seeds or updates the library in `home`. A file is written when ALP never
 * shipped it before, and replaced only while it still holds what ALP last wrote.
 * @param {string} home
 * @param {{ templateRoot?: URL, templates?: Record<string, string> }} [options]
 */
export async function seedLibrary(home, options = {}) {
  const shipped = await shippedFiles(options);
  const manifestPath = path.join(home, MANIFEST);
  const manifestText = await optional(manifestPath);
  const manifest = manifestText ? JSON.parse(manifestText) : { files: {} };
  const created = [];
  const updated = [];
  for (const [name, content] of Object.entries(shipped).sort(([a], [b]) => a.localeCompare(b))) {
    const target = path.join(home, ...name.split('/'));
    const current = await optional(target);
    const seeded = manifest.files[name];
    if (seeded === undefined) {
      // A file the user made under a shipped name stays theirs.
      if (current !== undefined) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      manifest.files[name] = sha(content);
      created.push(name);
    } else if (current !== undefined && sha(current) === seeded && seeded !== sha(content)) {
      await writeFile(target, content);
      manifest.files[name] = sha(content);
      updated.push(name);
    }
    // Missing after seeding: the user deleted it. Changed: the user edited it. Both are kept.
  }
  if (created.length || updated.length || manifestText === undefined) {
    await mkdir(home, { recursive: true });
    const temporary = `${manifestPath}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + '\n');
    await rename(temporary, manifestPath);
  }
  return { created, updated };
}

const seeding = new Map();

/** Seeds a library once per process; sessions call it on every open. */
export function ensureLibrary(home, options = {}) {
  let done = seeding.get(home);
  if (!done) {
    done = seedLibrary(home, options).catch(error => { seeding.delete(home); throw error; });
    seeding.set(home, done);
  }
  return done;
}

const skillName = name => typeof name === 'string' && /^[\w.-]+$/.test(name) && name !== '.' && name !== '..';

/** The library skills assigned to an agent, as named absolute SKILL.md paths that exist. */
export async function librarySkills(home, agent) {
  const file = path.join(home, 'role-skills.json');
  const text = await optional(file);
  if (text === undefined) return [];
  let roles;
  try { roles = JSON.parse(text); }
  catch (cause) { throw new AlpError('INVALID_LIBRARY', `${file}: ${cause.message}`, { cause }); }
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) throw new AlpError('INVALID_LIBRARY', `${file}: expected an object of role names to skill lists`);
  const names = roles[agent] ?? [];
  if (!Array.isArray(names) || !names.every(skillName)) throw new AlpError('INVALID_LIBRARY', `${file}: ${agent} must list skill directory names`);
  const skills = [];
  for (const name of new Set(names)) {
    const skillPath = path.join(home, 'skills', name, 'SKILL.md');
    if (await optional(skillPath) !== undefined) skills.push({ name, path: skillPath });
  }
  return skills;
}
