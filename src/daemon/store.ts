import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Envelope, SessionSnapshot, SessionSpec } from '../runtime/index.js';

/**
 * alpd's durable state (plans/reference/ALPD.md §5): one JSON record per session,
 * written atomically, one append-only JSONL timeline per tree, and one receipt per
 * delivered prompt.
 */

export type SessionStatus = 'initializing' | 'idle' | 'running' | 'error' | 'closed';

export type SessionRecord = {
  version: 1;
  id: string;
  rootId: string;
  /** The client's request, kept for roots so they can be resumed. */
  spec?: SessionSpec;
  delegation?: boolean;
  session?: SessionSnapshot;
  status: SessionStatus;
  lastError?: { code?: string; message: string };
  title?: string;
  createdAt: string;
  updatedAt: string;
};

/** Delivery of one clientMessageId; `pending` means alpd may have stopped while sending it. */
export type Receipt = {
  version: 1;
  sessionId: string;
  clientMessageId: string;
  fingerprint: string;
  state: 'pending' | 'completed';
  updatedAt: string;
};

const SAFE = /[^\w.:-]/g;
const fileName = (id: string) => id.replace(SAFE, '_');

export type Store = ReturnType<typeof createStore>;

export function createStore(root: string) {
  const sessionsDir = path.join(root, 'sessions');
  const timelineDir = path.join(root, 'timeline');
  const receiptsDir = path.join(root, 'receipts');
  const writes = new Map<string, Promise<void>>();
  const appends = new Map<string, Promise<void>>();
  let ready: Promise<void> | undefined;
  const prepare = () => ready ??= Promise.all([
    mkdir(sessionsDir, { recursive: true, mode: 0o700 }),
    mkdir(timelineDir, { recursive: true, mode: 0o700 }),
    mkdir(receiptsDir, { recursive: true, mode: 0o700 }),
  ]).then(() => {});

  async function writeAtomic(file: string, body: string) {
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, file);
  }

  /** Serializes work per key so a later write never lands before an earlier one. */
  function queue(map: Map<string, Promise<void>>, key: string, work: () => Promise<void>) {
    const next = (map.get(key) ?? Promise.resolve()).then(prepare).then(work);
    const settled = next.catch(error => { console.error(`${new Date().toISOString()} store`, error); });
    map.set(key, settled);
    void settled.then(() => { if (map.get(key) === settled) map.delete(key); });
    return settled;
  }

  return {
    put(record: SessionRecord) {
      const file = path.join(sessionsDir, `${fileName(record.id)}.json`);
      const body = JSON.stringify(record);
      return queue(writes, record.id, () => writeAtomic(file, body));
    },

    async receipt(key: string): Promise<Receipt | undefined> {
      await writes.get(`receipt:${key}`);
      try {
        const receipt = JSON.parse(await readFile(path.join(receiptsDir, `${fileName(key)}.json`), 'utf8'));
        return receipt?.version === 1 ? receipt : undefined;
      } catch (error: any) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      }
    },

    putReceipt(key: string, receipt: Receipt) {
      const body = JSON.stringify(receipt);
      return queue(writes, `receipt:${key}`, () => writeAtomic(path.join(receiptsDir, `${fileName(key)}.json`), body));
    },

    /** Deletes receipts not written for `maxAgeMs`. */
    async pruneReceipts(maxAgeMs: number) {
      await prepare();
      const now = Date.now();
      for (const name of await readdir(receiptsDir)) {
        const file = path.join(receiptsDir, name);
        const info = await stat(file).catch(() => undefined);
        if (info && now - info.mtimeMs > maxAgeMs) await rm(file, { force: true });
      }
    },

    async list(): Promise<SessionRecord[]> {
      await prepare();
      const records: SessionRecord[] = [];
      for (const name of await readdir(sessionsDir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const record = JSON.parse(await readFile(path.join(sessionsDir, name), 'utf8'));
          if (record?.version === 1 && typeof record.id === 'string') records.push(record);
          else console.error(`${new Date().toISOString()} store: skipped invalid record ${name}`);
        } catch {
          console.error(`${new Date().toISOString()} store: skipped unreadable record ${name}`);
        }
      }
      return records;
    },

    append(rootId: string, envelope: Envelope) {
      const line = `${JSON.stringify(envelope)}\n`;
      return queue(appends, rootId, () => appendFile(path.join(timelineDir, `${fileName(rootId)}.jsonl`), line, { mode: 0o600 }));
    },

    async timeline(rootId: string): Promise<Envelope[]> {
      await appends.get(rootId);
      try {
        const text = await readFile(path.join(timelineDir, `${fileName(rootId)}.jsonl`), 'utf8');
        return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      } catch (error: any) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },

    /** Removes a whole tree: its records and its timeline. */
    async remove(rootId: string, ids: string[]) {
      await Promise.all([...ids.map(id => writes.get(id)), appends.get(rootId)]);
      await Promise.all([
        ...ids.map(id => rm(path.join(sessionsDir, `${fileName(id)}.json`), { force: true })),
        rm(path.join(timelineDir, `${fileName(rootId)}.jsonl`), { force: true }),
      ]);
    },

    async flush() {
      await Promise.all([...writes.values(), ...appends.values()]);
    },
  };
}
