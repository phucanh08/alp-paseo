import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import type { ClientContext, Handler } from './gateway.js';
import { checkoutFacts, git } from './git.js';

/**
 * A checkout's git state and changes for the app (D31 step 8, ALPD §62): the branch, base and how
 * far apart they are for the header, and the Changes panel's diff, uncommitted or against the
 * base branch, pushed again when the checkout changes. Read-only: committing, pushing, pulling,
 * merging and switching branches answer "in development". The unified-diff parser is ported from
 * Paseo's daemon (packages/server/src/server/utils/diff-highlighter.ts, Copyright (c)
 * 2025-present Mohamed Boudra, Apache License 2.0), without its syntax highlighting.
 */

type Inbound<T extends SessionInboundMessage['type']> = Extract<SessionInboundMessage, { type: T }>;
type Outbound = SessionOutboundMessage;
type StatusPayload = Extract<Outbound, { type: 'checkout_status_response' }>['payload'];
/** A status without its request id, each of the union's shapes kept apart. */
type Status = StatusPayload extends infer P ? P extends unknown ? Omit<P, 'requestId'> : never : never;
type DiffFile = Extract<Outbound, { type: 'checkout_diff_update' }>['payload']['files'][number];
type Hunk = DiffFile['hunks'][number];
type Compare = Inbound<'subscribe_checkout_diff_request'>['compare'];

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Paseo's limits: one file's patch, and all of them. */
const FILE_PATCH_BYTES = 1024 * 1024;
const TOTAL_PATCH_BYTES = 2 * 1024 * 1024;
const UNTRACKED_LIMIT = 200;
const POLL_MS = 3_000;

// --- Ported from Paseo's diff-highlighter.ts (parseDiff and its helpers) ---

function extractPathFromMetadata(lines: string[], prefix: '--- ' | '+++ '): string | null {
  const line = lines.find(candidate => candidate.startsWith(prefix));
  if (!line) return null;
  const found = line.slice(prefix.length).replace(/\t.*$/, '').trimEnd();
  return found === '/dev/null' ? null : found;
}

function extractPathFromDiffHeader(lines: string[]): string {
  const firstLine = lines[0] ?? '';
  const prefixed = firstLine.match(/^a\/(.+) b\/(.+)$/);
  if (prefixed) return prefixed[2];
  const metadataPath = extractPathFromMetadata(lines, '+++ ') ?? extractPathFromMetadata(lines, '--- ');
  if (metadataPath) return metadataPath.replace(/^[ab]\//, '');
  return 'unknown';
}

const isMetadataLine = (line: string) => line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('new file mode') || line.startsWith('deleted file mode');

function parseHunkHeader(line: string): Hunk | null {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;
  return {
    oldStart: parseInt(match[1], 10),
    oldCount: parseInt(match[2] ?? '1', 10),
    newStart: parseInt(match[3], 10),
    newCount: parseInt(match[4] ?? '1', 10),
    lines: [{ type: 'header', content: line.match(/^(@@ .+? @@)/)?.[1] ?? line }],
  };
}

function parseSectionBody(lines: string[]) {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let additions = 0;
  let deletions = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (isMetadataLine(line)) continue;
    const next = parseHunkHeader(line);
    if (next) { if (current) hunks.push(current); current = next; continue; }
    if (!current) continue;
    if (line.startsWith('+')) { current.lines.push({ type: 'add', content: line.slice(1) }); additions++; }
    else if (line.startsWith('-')) { current.lines.push({ type: 'remove', content: line.slice(1) }); deletions++; }
    else if (line.startsWith(' ')) current.lines.push({ type: 'context', content: line.slice(1) });
    else if (line.length > 0 && !line.startsWith('\\')) current.lines.push({ type: 'context', content: line });
  }
  if (current) hunks.push(current);
  return { hunks, additions, deletions };
}

export function parseDiff(diffText: string): DiffFile[] {
  if (!diffText.trim()) return [];
  const files: DiffFile[] = [];
  for (const section of diffText.split(/^diff --git /m).filter(Boolean)) {
    const lines = section.split('\n');
    const isNew = section.includes('new file mode') || section.includes('--- /dev/null');
    const isDeleted = section.includes('deleted file mode') || section.includes('+++ /dev/null');
    const { hunks, additions, deletions } = parseSectionBody(lines);
    // ALP: renames keep where they came from, and a binary file says so.
    const renamedFrom = lines.find(line => line.startsWith('rename from '))?.slice('rename from '.length);
    const binary = lines.some(line => line.startsWith('Binary files ') || line === 'GIT binary patch');
    files.push({ path: extractPathFromDiffHeader(lines), ...(renamedFrom ? { oldPath: renamedFrom } : {}), isNew, isDeleted, additions, deletions, hunks, status: binary ? 'binary' : 'ok' });
  }
  return files;
}

// --- end of the port ---

/** The base branch: origin's HEAD when there is one, else main or master. */
async function defaultBase(repoRoot: string) {
  const remoteHead = await git(repoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).then(out => out.trim(), () => '');
  if (remoteHead.startsWith('refs/remotes/origin/')) return remoteHead.slice('refs/remotes/origin/'.length);
  const branches = (await git(repoRoot, ['branch', '--format=%(refname:short)']).catch(() => '')).split('\n').map(line => line.trim());
  return branches.includes('main') ? 'main' : branches.includes('master') ? 'master' : null;
}

const exists = (repoRoot: string, ref: string) => git(repoRoot, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false);
/** What a base branch is compared as: origin's copy when there is one. */
const comparable = async (repoRoot: string, base: string) => await exists(repoRoot, `refs/remotes/origin/${base}`) ? `origin/${base}` : base;

export async function checkoutStatus(cwd: string): Promise<Status> {
  const facts = await checkoutFacts(cwd);
  if (!facts.isGit) {
    return { cwd, error: null, isGit: false, isPaseoOwnedWorktree: false, repoRoot: null, currentBranch: null, isDirty: null, baseRef: null, aheadBehind: null, aheadOfOrigin: null, behindOfOrigin: null, hasRemote: false, remoteUrl: null };
  }
  const { repoRoot, currentBranch } = facts;
  const baseRef = await defaultBase(repoRoot);
  let aheadBehind: { ahead: number; behind: number } | null = null;
  if (baseRef && currentBranch && currentBranch !== baseRef) {
    const counts = await git(repoRoot, ['rev-list', '--left-right', '--count', `${await comparable(repoRoot, baseRef)}...HEAD`]).then(out => out.trim().split(/\s+/).map(Number), () => undefined);
    if (counts?.length === 2 && counts.every(Number.isFinite)) aheadBehind = { behind: counts[0], ahead: counts[1] };
  }
  let upstreamRef: string | null = null;
  let aheadOfOrigin: number | null = null;
  let behindOfOrigin: number | null = null;
  if (currentBranch) {
    const [upstream, track = ''] = (await git(repoRoot, ['for-each-ref', '--format=%(upstream)%00%(upstream:track,nobracket)', `refs/heads/${currentBranch}`]).catch(() => '')).trim().split('\0');
    if (upstream && track !== 'gone') {
      upstreamRef = upstream;
      aheadOfOrigin = Number(track.match(/ahead (\d+)/)?.[1] ?? 0);
      behindOfOrigin = Number(track.match(/behind (\d+)/)?.[1] ?? 0);
    }
  }
  return {
    cwd, error: null, isGit: true, isPaseoOwnedWorktree: false, repoRoot, mainRepoRoot: null, currentBranch, isDirty: facts.isDirty, baseRef,
    aheadBehind, aheadOfOrigin, behindOfOrigin, hasRemote: facts.remoteUrl !== null, remoteUrl: facts.remoteUrl, upstreamRef,
  };
}

/** Whether a file looks binary: NUL bytes, or more than 30% control characters, in its first 16 KB. */
async function looksBinary(file: string) {
  const handle = await open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(16 * 1024), 0, 16 * 1024, 0);
    const head = buffer.subarray(0, bytesRead);
    if (head.includes(0)) return true;
    let control = 0;
    for (const byte of head) if (byte < 9 || (byte > 13 && byte < 32)) control++;
    return bytesRead > 0 && control / bytesRead > 0.3;
  } finally {
    await handle.close();
  }
}

/** The checkout's changes as Paseo's Changes panel shows them, with paths from the repository's root. */
export async function checkoutDiff(cwd: string, compare: Compare) {
  const facts = await checkoutFacts(cwd);
  if (!facts.isGit) return { files: [] as DiffFile[], error: { code: 'NOT_GIT_REPO' as const, message: `${cwd} is not a git repository` } };
  const { repoRoot } = facts;
  const whitespace = compare.ignoreWhitespace ? ['-w'] : [];
  const head = await exists(repoRoot, 'HEAD') ? 'HEAD' : EMPTY_TREE;
  let range: string[];
  if (compare.mode === 'base') {
    const base = compare.baseRef || await defaultBase(repoRoot);
    if (!base) return { files: [], error: null };
    const mergeBase = await git(repoRoot, ['merge-base', await comparable(repoRoot, base), 'HEAD']).then(out => out.trim(), () => '');
    if (!mergeBase) return { files: [], error: null };
    range = [mergeBase, 'HEAD'];
  } else {
    range = [head];
  }
  const text = await git(repoRoot, ['diff', '--no-color', '--no-ext-diff', '-M', ...whitespace, ...range], { maxBuffer: 256 * 1024 * 1024 });
  let total = 0;
  const files = splitSections(text).map(section => {
    const [file] = parseDiff(section);
    if (!file) return undefined;
    if (section.length > FILE_PATCH_BYTES || total + section.length > TOTAL_PATCH_BYTES) return { ...file, hunks: [], status: 'too_large' as const };
    total += section.length;
    return file;
  }).filter((file): file is DiffFile => !!file);
  if (compare.mode !== 'base') {
    const untracked = (await git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']).catch(() => '')).split('\0').filter(Boolean);
    for (const relative of untracked.slice(0, UNTRACKED_LIMIT)) {
      const absolute = path.join(repoRoot, relative);
      const info = await stat(absolute).catch(() => undefined);
      if (!info?.isFile()) continue;
      const lines = info.size > FILE_PATCH_BYTES ? 0 : await looksBinary(absolute).then(binary => binary ? -1 : 0, () => -1);
      if (info.size > FILE_PATCH_BYTES || total > TOTAL_PATCH_BYTES) { files.push({ path: relative, isNew: true, isDeleted: false, additions: 0, deletions: 0, hunks: [], status: 'too_large' }); continue; }
      if (lines < 0) { files.push({ path: relative, isNew: true, isDeleted: false, additions: 0, deletions: 0, hunks: [], status: 'binary' }); continue; }
      const patch = await git(repoRoot, ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', relative], { okCodes: [1] }).catch(() => '');
      total += patch.length;
      const [file] = parseDiff(patch);
      if (file) files.push({ ...file, path: relative, isNew: true });
    }
  }
  return { files, error: null };
}

function splitSections(text: string) {
  return text.split(/^(?=diff --git )/m).filter(section => section.startsWith('diff --git '));
}

type Subscription = { client: ClientContext; subscriptionId: string; cwd: string; compare: Compare; last?: string };

export function createCheckouts({ broadcast, log = () => {} }: { broadcast(message: Outbound): void; log?: (message: string) => void }) {
  const subscriptions = new Map<string, Subscription>();
  /** The status each directory last had, so a change goes to every client. */
  const statuses = new Map<string, string>();
  let timer: NodeJS.Timeout | undefined;

  async function payloadOf(subscription: Subscription) {
    try {
      const { files, error } = await checkoutDiff(subscription.cwd, subscription.compare);
      return { subscriptionId: subscription.subscriptionId, cwd: subscription.cwd, files, error };
    } catch (error: any) {
      return { subscriptionId: subscription.subscriptionId, cwd: subscription.cwd, files: [], error: { code: 'UNKNOWN' as const, message: error?.message ?? String(error) } };
    }
  }

  /** Reads each watched checkout again; what changed goes out. */
  async function poll(onlyCwd?: string) {
    for (const subscription of [...subscriptions.values()]) {
      if (onlyCwd && subscription.cwd !== onlyCwd) continue;
      const payload = await payloadOf(subscription);
      const text = JSON.stringify(payload);
      if (text === subscription.last || !subscriptions.has(subscription.subscriptionId)) continue;
      subscription.last = text;
      subscription.client.emit({ type: 'checkout_diff_update', payload });
    }
    for (const cwd of new Set([...subscriptions.values()].map(subscription => subscription.cwd).concat(onlyCwd ? [onlyCwd] : []))) {
      const status = await checkoutStatus(cwd).catch(() => undefined);
      if (!status) continue;
      const text = JSON.stringify(status);
      if (statuses.get(cwd) === text) continue;
      const known = statuses.has(cwd);
      statuses.set(cwd, text);
      // Paseo's status shapes carry a request id even when pushed.
      if (known) broadcast({ type: 'checkout_status_update', payload: { ...status, requestId: `alp:status:${Date.now()}` } } as Outbound);
    }
  }

  function schedule() {
    if (timer || !subscriptions.size) return;
    timer = setInterval(() => void poll().catch(error => log(`checkouts not polled: ${error?.message ?? error}`)), POLL_MS);
    timer.unref();
  }

  const handlers: Record<string, Handler> = {
    async checkout_status_request(message: Inbound<'checkout_status_request'>) {
      const status = await checkoutStatus(message.cwd);
      statuses.set(message.cwd, JSON.stringify(status));
      return { type: 'checkout_status_response', payload: { ...status, requestId: message.requestId } } as Outbound;
    },

    /** The Changes panel: the diff now, then again whenever it changes, until unsubscribed. */
    async subscribe_checkout_diff_request(message: Inbound<'subscribe_checkout_diff_request'>, client: ClientContext) {
      const subscriptionId = message.subscriptionId ?? `alp:${message.requestId}`;
      const subscription: Subscription = { client, subscriptionId, cwd: message.cwd, compare: message.compare };
      subscriptions.set(subscriptionId, subscription);
      schedule();
      const payload = await payloadOf(subscription);
      subscription.last = JSON.stringify(payload);
      return { type: 'subscribe_checkout_diff_response', payload: { ...payload, requestId: message.requestId } } satisfies Outbound;
    },

    unsubscribe_checkout_diff_request(message: Inbound<'unsubscribe_checkout_diff_request'>) {
      subscriptions.delete(message.subscriptionId);
    },

    async 'checkout.refresh.request'(message: Inbound<'checkout.refresh.request'>) {
      try {
        await poll(message.cwd);
        return { type: 'checkout.refresh.response', payload: { cwd: message.cwd, success: true, error: null, requestId: message.requestId } } satisfies Outbound;
      } catch (error: any) {
        return { type: 'checkout.refresh.response', payload: { cwd: message.cwd, success: false, error: { code: 'UNKNOWN', message: error?.message ?? String(error) }, requestId: message.requestId } } satisfies Outbound;
      }
    },

    checkout_pr_status_request: (message: Inbound<'checkout_pr_status_request'>) => ({
      type: 'checkout_pr_status_response',
      // No forge in ALP yet: "no remote" keeps the panel from asking the user to sign in to GitHub.
      payload: { requestId: message.requestId, cwd: message.cwd, status: null, githubFeaturesEnabled: false, authState: 'no_remote', forge: 'github', error: null },
    }) satisfies Outbound,
  };

  return {
    handlers,
    features: { checkoutRefresh: true },
    /** A client left: its subscriptions go. */
    drop(client: ClientContext) {
      for (const [id, subscription] of subscriptions) if (subscription.client === client) subscriptions.delete(id);
      if (!subscriptions.size && timer) { clearInterval(timer); timer = undefined; }
    },
    close() { if (timer) clearInterval(timer); timer = undefined; },
  };
}
