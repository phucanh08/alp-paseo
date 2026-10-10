import { useSyncExternalStore } from 'react';

/**
 * What the user sets on sessions in this browser, as Paseo keeps it per client: pinned
 * sessions, labels, and when each session was last seen (for unread). Kept in localStorage.
 */

type Prefs = {
  pinned: string[];
  labels: Record<string, string[]>;
  /** The labels to choose from, in order. */
  catalog: string[];
  /** When the user last saw each session, as an ISO time; a session updated later is unread. */
  seen: Record<string, string>;
  /** Sessions the user marked as unread. */
  unread: string[];
};

const KEY = 'alp.prefs';
const DEFAULTS: Prefs = { pinned: [], labels: {}, catalog: ['bug', 'feature', 'review', 'blocked'], seen: {}, unread: [] };

function load(): Prefs {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { ...DEFAULTS }; }
}

let prefs = load();
/** Whether `seen` was ever filled: the first visit counts everything as seen. */
let started = (() => { try { return localStorage.getItem(KEY) !== null; } catch { return false; } })();
const listeners = new Set<() => void>();

function save(next: Prefs) {
  prefs = next;
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch {}
  for (const listener of listeners) listener();
}

export function usePrefs() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => prefs);
}

export function togglePin(id: string) {
  save({ ...prefs, pinned: prefs.pinned.includes(id) ? prefs.pinned.filter(entry => entry !== id) : [id, ...prefs.pinned] });
}

export function toggleLabel(id: string, label: string) {
  const current = prefs.labels[id] ?? [];
  const next = current.includes(label) ? current.filter(entry => entry !== label) : [...current, label];
  const labels = { ...prefs.labels, [id]: next };
  if (!next.length) delete labels[id];
  save({ ...prefs, labels });
}

export function addLabel(label: string) {
  const name = label.trim().toLowerCase().slice(0, 24);
  if (!name || prefs.catalog.includes(name)) return name;
  save({ ...prefs, catalog: [...prefs.catalog, name] });
  return name;
}

/** The user looked at a session now: it is read. */
export function markSeen(id: string, at = new Date().toISOString()) {
  if (prefs.seen[id] && prefs.seen[id] >= at && !prefs.unread.includes(id)) return;
  save({ ...prefs, seen: { ...prefs.seen, [id]: at }, unread: prefs.unread.filter(entry => entry !== id) });
}

export function markUnread(id: string) {
  if (!prefs.unread.includes(id)) save({ ...prefs, unread: [...prefs.unread, id] });
}

/** On the first visit every session counts as seen, so only what changes afterwards shows as unread. */
export function seedSeen(sessions: Array<{ id: string; updatedAt?: string }>) {
  if (started || !sessions.length) return;
  started = true;
  save({ ...prefs, seen: Object.fromEntries(sessions.map(session => [session.id, session.updatedAt ?? new Date().toISOString()])) });
}

export function isUnread(session: { id: string; updatedAt?: string }, current?: string) {
  if (session.id === current) return false;
  if (prefs.unread.includes(session.id)) return true;
  const seen = prefs.seen[session.id];
  return !!seen && !!session.updatedAt && session.updatedAt > seen;
}
