import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import { git } from './git.js';

/**
 * Finding directories and files for the app (D31 step 6, ALPD §62): the folder to add as a
 * project, typed as a path or a name under home, and a workspace's files for `@` mentions, the
 * command center and file links, as Paseo's daemon answers `directory_suggestions`; and the
 * read-only Files panel (step 8).
 */

type Inbound<T extends SessionInboundMessage['type']> = Extract<SessionInboundMessage, { type: T }>;
type Outbound = SessionOutboundMessage;
type Entry = { path: string; kind: 'file' | 'directory' };

/** Folders a search never walks into: big, generated, or (on macOS) behind a consent prompt. */
const SKIPPED = new Set(['node_modules', 'Library', '.git', 'dist', 'build', '.cache', 'target', '.venv', 'venv', '__pycache__']);
const HOME_SCAN_LIMIT = 5_000;
const HOME_DEPTH = 4;
const WORKSPACE_SCAN_LIMIT = 20_000;

const children = (directory: string) => readdir(directory, { withFileTypes: true }).catch(() => []);
const expand = (query: string) => query === '~' ? os.homedir() : query.startsWith('~/') ? path.join(os.homedir(), query.slice(2)) : query;

/** How well a name matches: lower is better, undefined is no match. */
function rank(candidate: string, query: string) {
  const name = candidate.toLowerCase();
  const wanted = query.toLowerCase();
  if (name === wanted) return 0;
  if (name.startsWith(wanted)) return 1;
  if (name.includes(wanted)) return 2;
  let at = 0;
  for (const char of name) if (char === wanted[at]) at += 1;
  return at === wanted.length ? 3 : undefined;
}

/** A path typed by the user: the folders in its parent that start with what follows the last slash. */
async function pathCompletions(query: string, limit: number): Promise<Entry[]> {
  const typed = expand(query.trim());
  const parent = typed.endsWith('/') ? typed : path.dirname(typed);
  const prefix = typed.endsWith('/') ? '' : path.basename(typed).toLowerCase();
  return (await children(parent))
    .filter(entry => entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix) && (!entry.name.startsWith('.') || prefix.startsWith('.')))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit)
    .map(name => ({ path: path.join(parent, name), kind: 'directory' as const }));
}

/** A name: folders under home whose name matches, nearest and best first. */
async function homeSearch(query: string, limit: number): Promise<Entry[]> {
  const found: Array<{ path: string; score: number; depth: number }> = [];
  let queue = [os.homedir()];
  let scanned = 0;
  for (let depth = 1; depth <= HOME_DEPTH && queue.length && scanned < HOME_SCAN_LIMIT; depth += 1) {
    const next: string[] = [];
    for (const directory of queue) {
      for (const entry of await children(directory)) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue;
        const full = path.join(directory, entry.name);
        scanned += 1;
        const score = rank(entry.name, query);
        if (score !== undefined) found.push({ path: full, score, depth });
        next.push(full);
        if (scanned >= HOME_SCAN_LIMIT) break;
      }
      if (scanned >= HOME_SCAN_LIMIT) break;
    }
    queue = next;
  }
  return found.sort((a, b) => a.score - b.score || a.depth - b.depth || a.path.localeCompare(b.path)).slice(0, limit).map(entry => ({ path: entry.path, kind: 'directory' }));
}

/** A workspace's files and folders, relative to it: git's list when it is a repository (so ignored files stay out), else a walk. */
async function workspaceEntries(root: string): Promise<Entry[]> {
  const listed = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { maxBuffer: 64 * 1024 * 1024 }).catch(() => undefined);
  if (listed !== undefined) {
    const files = listed.split('\0').filter(Boolean).slice(0, WORKSPACE_SCAN_LIMIT);
    const directories = new Set<string>();
    for (const file of files) for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) directories.add(dir);
    return [...[...directories].map(dir => ({ path: dir, kind: 'directory' as const })), ...files.map(file => ({ path: file, kind: 'file' as const }))];
  }
  const entries: Entry[] = [];
  const walk = async (relative: string) => {
    for (const entry of await children(path.join(root, relative))) {
      if (entries.length >= WORKSPACE_SCAN_LIMIT) return;
      if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { entries.push({ path: child, kind: 'directory' }); await walk(child); }
      else if (entry.isFile()) entries.push({ path: child, kind: 'file' });
    }
  };
  await walk('');
  return entries;
}

async function workspaceSearch(message: Inbound<'directory_suggestions_request'>, root: string, limit: number): Promise<Entry[]> {
  const wantFiles = message.includeFiles === true;
  const wantDirectories = message.includeDirectories !== false;
  const keep = (entry: Entry) => entry.kind === 'file' ? wantFiles : wantDirectories;
  const query = message.query.trim().replace(/^\.\//, '');
  if (!query) {
    return (await children(root)).filter(entry => !entry.name.startsWith('.'))
      .map((entry): Entry => ({ path: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })).filter(keep)
      .sort((a, b) => a.path.localeCompare(b.path)).slice(0, limit);
  }
  const all = (await workspaceEntries(root)).filter(keep);
  if (message.matchMode === 'suffix') {
    const wanted = query.toLowerCase();
    return all.filter(entry => entry.path.toLowerCase() === wanted || entry.path.toLowerCase().endsWith(`/${wanted}`)).sort((a, b) => a.path.length - b.path.length).slice(0, limit);
  }
  return all.map(entry => {
    const byName = rank(path.posix.basename(entry.path), query);
    const byPath = rank(entry.path, query);
    const score = byName ?? (byPath === undefined ? undefined : byPath + 4);
    return { entry, score };
  }).filter((row): row is { entry: Entry; score: number } => row.score !== undefined)
    .sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit).map(row => row.entry);
}

export async function directorySuggestions(message: Inbound<'directory_suggestions_request'>): Promise<Outbound> {
  const limit = message.limit ?? 30;
  try {
    const cwd = message.cwd?.trim();
    const query = message.query.trim();
    const entries = cwd ? await workspaceSearch(message, path.resolve(expand(cwd)), limit)
      : !query ? []
      : query.startsWith('/') || query.startsWith('~') ? await pathCompletions(query, limit)
      : await homeSearch(query, limit);
    return { type: 'directory_suggestions_response', payload: { requestId: message.requestId, directories: entries.filter(entry => entry.kind === 'directory').map(entry => entry.path), entries, error: null } };
  } catch (error: any) {
    return { type: 'directory_suggestions_response', payload: { requestId: message.requestId, directories: [], entries: [], error: error?.message ?? String(error) } };
  }
}

const IMAGES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
/** The most a preview reads when the app names no limit. */
const PREVIEW_BYTES = 50 * 1024 * 1024;

/** A path inside the workspace, links followed; anything that leads outside is refused. */
async function inside(root: string, relative: string) {
  const realRoot = await realpath(root);
  const target = path.resolve(realRoot, relative || '.');
  const real = await realpath(target);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('Access outside of workspace is not allowed');
  return { realRoot, real, target };
}

const posixRelative = (root: string, target: string) => path.relative(root, target).split(path.sep).join('/') || '.';

function textOf(buffer: Buffer) {
  if (buffer.includes(0)) return undefined;
  let control = 0;
  const head = buffer.subarray(0, 16 * 1024);
  for (const byte of head) if (byte < 9 || (byte > 13 && byte < 32)) control++;
  if (head.length && control / head.length > 0.3) return undefined;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return undefined; }
}

/**
 * The Files panel, read-only (D31 step 8): a directory's entries, links that stay inside included,
 * and a file's content as text, an image, or only its size for anything binary. Editing, and new,
 * renamed or deleted files, answer "in development".
 */
export async function fileExplorer(message: Inbound<'file_explorer_request'>): Promise<Outbound> {
  const reply = (fields: Partial<Extract<Outbound, { type: 'file_explorer_response' }>['payload']>): Outbound =>
    ({ type: 'file_explorer_response', payload: { requestId: message.requestId, cwd: message.cwd, path: message.path ?? '.', mode: message.mode, directory: null, file: null, error: null, ...fields } });
  try {
    const root = path.resolve(expand(message.cwd));
    const { realRoot, real, target } = await inside(root, message.path ?? '.');
    const relative = posixRelative(realRoot, real);
    if (message.mode === 'list') {
      const entries = [];
      for (const entry of await readdir(real, { withFileTypes: true })) {
        const child = path.join(real, entry.name);
        const resolved = entry.isSymbolicLink() ? await inside(realRoot, path.relative(realRoot, child)).then(found => found.real, () => undefined) : child;
        if (!resolved) continue;
        const info = await stat(resolved).catch(() => undefined);
        if (!info) continue;
        entries.push({ name: entry.name, path: posixRelative(realRoot, child), kind: info.isDirectory() ? 'directory' as const : 'file' as const, size: info.size, modifiedAt: info.mtime.toISOString() });
      }
      entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      return reply({ path: relative, directory: { path: relative, entries } });
    }
    const info = await stat(real);
    if (!info.isFile()) throw new Error(`${posixRelative(root, target)} is not a file`);
    if (info.size > (message.maxBytes ?? PREVIEW_BYTES)) throw new Error('File is too large to display');
    const buffer = await readFile(real);
    const base = { path: relative, size: info.size, modifiedAt: info.mtime.toISOString(), revision: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` };
    const image = IMAGES[path.extname(real).toLowerCase()];
    if (image) return reply({ path: relative, file: { ...base, kind: 'image', encoding: 'base64', content: buffer.toString('base64'), mimeType: image } });
    const text = textOf(buffer);
    if (text === undefined) return reply({ path: relative, file: { ...base, kind: 'binary', encoding: 'none', mimeType: 'application/octet-stream' } });
    return reply({ path: relative, file: { ...base, kind: 'text', encoding: 'utf-8', content: text, mimeType: path.extname(real).toLowerCase() === '.json' ? 'application/json' : 'text/plain' } });
  } catch (error: any) {
    return reply({ error: error?.code === 'ENOENT' ? 'No such file or directory' : error?.message ?? String(error) });
  }
}
