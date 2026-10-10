import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { RuntimeKind, SessionSpec } from './resolve.js';
import type { Worktree } from './workspace.js';

/**
 * Assignments that are running, kept on disk so the next alpd can continue them
 * after a crash or a restart (plans/reference/ALPD.md §31). An entry is written once
 * its native thread exists and removed when the assignment starts to finish, so a
 * crash while finishing never runs finished work again.
 */

export type LiveEntry = {
  assignmentId: string;
  rootId: string;
  /** The requester's session, which must be open again before this one continues. */
  parentId: string;
  callId: string;
  agent: string;
  /** The project root, whose tasks and board the assignment uses. */
  project: string;
  ancestry: string[];
  runtime: RuntimeKind;
  /** The model without its runtime prefix, as the session resolved it. */
  model: string;
  threadId: string;
  /** The spec the assignment's session was opened with. */
  spec: SessionSpec;
  delegation: boolean;
  mode: string;
  isolation: 'shared' | 'worktree';
  taskId?: string;
  worktree?: Worktree;
  /** The requester's directory, when the assignment worked in a disposable copy of it. */
  copyOf?: string;
  lease?: string;
  fingerprint?: string;
  startedAt: number;
  /** The brief it was given, repeated to it after a compaction (ALPD §57). */
  brief?: string;
  /** The alpd process that wrote the entry; another epoch means an earlier alpd. */
  epoch: string;
};

const valid = (entry: any): entry is LiveEntry => !!entry && typeof entry === 'object' &&
  ['assignmentId', 'rootId', 'parentId', 'agent', 'project', 'runtime', 'model', 'threadId', 'mode', 'isolation', 'epoch'].every(key => typeof entry[key] === 'string') &&
  Array.isArray(entry.ancestry) && !!entry.spec && typeof entry.spec === 'object' && typeof entry.startedAt === 'number';

/** The book of running assignments, in `file` when given, else in memory. */
export function createLiveBook(file?: string) {
  let entries: LiveEntry[] = [];
  if (file) {
    try { entries = (JSON.parse(readFileSync(file, 'utf8')) as unknown[]).filter(valid); } catch {}
  }
  let writes = Promise.resolve();
  const save = () => {
    if (!file) return writes;
    const body = JSON.stringify(entries, null, 2) + '\n';
    writes = writes.then(async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, file);
    }).catch(error => console.error(`${new Date().toISOString()} live assignments`, error));
    return writes;
  };
  return {
    all: () => [...entries],
    get: (assignmentId: string) => entries.find(entry => entry.assignmentId === assignmentId),
    put(entry: LiveEntry) {
      entries = [...entries.filter(existing => existing.assignmentId !== entry.assignmentId), entry];
      return save();
    },
    remove(assignmentId: string) {
      if (!entries.some(entry => entry.assignmentId === assignmentId)) return writes;
      entries = entries.filter(entry => entry.assignmentId !== assignmentId);
      return save();
    },
    flush: () => writes,
  };
}

export type LiveBook = ReturnType<typeof createLiveBook>;
