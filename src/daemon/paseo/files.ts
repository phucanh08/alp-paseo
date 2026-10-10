import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import { git } from './git.js';

/**
 * Finding directories and files for the app (D31 step 6, ALPD §62): the folder to add as a
 * project, typed as a path or a name under home, and a workspace's files for `@` mentions, the
 * command center and file links. Read-only, as Paseo's daemon answers `directory_suggestions`.
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
