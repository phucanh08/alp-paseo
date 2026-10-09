import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { RuntimeKind } from './resolve.js';

/**
 * Finished assignments whose native threads alp_recall can question (ALPD §27).
 * The threads stay on disk for RECALL_KEEP_MS; then ALP deletes them.
 */

export type RecallEntry = {
  assignmentId: string;
  rootId: string;
  /** The requester and its requesters, nearest first: who may recall it besides a root of the project. */
  requesters: string[];
  agent: string;
  project: string;
  runtime: RuntimeKind;
  threadId: string;
  /** Where it worked: the project, or a worktree or copy that may be gone by now. */
  cwd: string;
  model: string;
  thinking?: string;
  taskId?: string;
  status: string;
  finishedAt: string;
};

export const RECALL_KEEP_MS = 14 * 24 * 60 * 60 * 1000;
export const RECALL_MAX = 1000;
export const RECALL_QUESTION_CHARS = 4000;
export const RECALL_TIMEOUT_MS = 300_000;

const valid = (entry: any): entry is RecallEntry => !!entry && typeof entry === 'object' &&
  ['assignmentId', 'rootId', 'agent', 'project', 'runtime', 'threadId', 'cwd', 'model', 'status', 'finishedAt'].every(key => typeof entry[key] === 'string') &&
  Array.isArray(entry.requesters);

/** The record of recallable threads, kept in `file` when given, else in memory. */
export function createRecallBook(file?: string) {
  let entries: Promise<RecallEntry[]> | undefined;
  let writes = Promise.resolve();
  const load = () => entries ??= file
    ? readFile(file, 'utf8').then(text => (JSON.parse(text) as unknown[]).filter(valid), () => [] as RecallEntry[])
    : Promise.resolve([]);
  const save = (list: RecallEntry[]) => {
    if (!file) return writes;
    const body = JSON.stringify(list, null, 2) + '\n';
    writes = writes.then(async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, file);
    }).catch(() => {});
    return writes;
  };
  return {
    async all() { return [...await load()]; },
    async add(entry: RecallEntry) {
      const list = await load();
      list.push(entry);
      await save(list);
    },
    /** Removes and returns the entries past their time, and the oldest beyond RECALL_MAX. */
    async expire(now = Date.now()) {
      const list = await load();
      const kept = list.filter(entry => now - Date.parse(entry.finishedAt) < RECALL_KEEP_MS).slice(-RECALL_MAX);
      if (kept.length === list.length) return [];
      const gone = list.filter(entry => !kept.includes(entry));
      list.splice(0, list.length, ...kept);
      await save(list);
      return gone;
    },
    flush: () => writes,
  };
}

/** What a recalled assignment is told before the question. */
export function recallPrompt(asker: string, question: string) {
  return `ALP recall: ${asker} asks about the assignment you finished in this conversation. ` +
    'Answer from what you did, saw and decided then; read files only to check a detail. ' +
    'This is a read-only copy of your session: change nothing, and do not call ALP tools; they are unavailable. ' +
    `Answer briefly and concretely.\n\nQuestion: ${question}`;
}
