import { useSyncExternalStore } from 'react';
import type { Envelope, SessionSnapshot, TimelineItem, UserQuestion } from './types';

/**
 * Every session the page follows, built from alpd's events: items are snapshots keyed
 * by id, so a later one replaces an earlier one (ALPD §4.2), in the order first seen.
 */

export type SessionView = {
  id: string;
  snapshot?: SessionSnapshot;
  items: Map<string, TimelineItem>;
  order: string[];
  running: boolean;
  closed: boolean;
  error?: string;
  /** Children in the order they opened. */
  children: string[];
};

const sessions = new Map<string, SessionView>();
/** Questions to the user by root. */
const questions = new Map<string, Map<string, UserQuestion>>();
let version = 0;
const listeners = new Set<() => void>();

function view(id: string) {
  let session = sessions.get(id);
  if (!session) {
    session = { id, items: new Map(), order: [], running: false, closed: false, children: [] };
    sessions.set(id, session);
  }
  return session;
}

let scheduled = false;
/** Streams arrive in bursts: one render per frame. */
function changed() {
  version++;
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    for (const listener of listeners) listener();
  });
}

export function apply(envelope: Envelope) {
  const session = view(envelope.sessionId);
  const { event } = envelope;
  switch (event.type) {
    case 'session.opened':
    case 'session.updated': {
      session.snapshot = event.session;
      session.closed = false;
      const parent = event.session.parentId;
      if (parent && !view(parent).children.includes(session.id)) {
        const requester = view(parent);
        sessions.set(parent, { ...requester, children: [...requester.children, session.id] });
      }
      break;
    }
    case 'session.closed': session.closed = true; session.running = false; break;
    case 'session.failed': session.error = event.error.message; session.running = false; break;
    case 'turn.started': session.running = true; session.error = undefined; break;
    case 'turn.ended': session.running = false; if (event.state === 'failed') session.error = event.error?.message ?? 'The turn failed'; break;
    case 'prompt.failed': session.error = event.error.message; break;
    case 'item': {
      // A new snapshot of the same item replaces it; a new array keeps React's memo honest.
      const items = new Map(session.items);
      if (!items.has(event.item.id)) session.order = [...session.order, event.item.id];
      items.set(event.item.id, event.item);
      session.items = items;
      break;
    }
    case 'question': {
      const asked = questions.get(event.question.rootId) ?? new Map();
      asked.set(event.question.id, event.question);
      questions.set(event.question.rootId, new Map(asked));
      break;
    }
    case 'question.resolved':
      for (const [root, asked] of questions) if (asked.has(event.questionId)) { const next = new Map(asked); next.delete(event.questionId); questions.set(root, next); }
      break;
    default: return;
  }
  sessions.set(session.id, { ...session });
  changed();
}

/** Forgets a tree's events before alpd replays it, after a reconnect. */
export function forget(rootId: string) {
  const drop = (id: string) => { for (const child of sessions.get(id)?.children ?? []) drop(child); sessions.delete(id); };
  drop(rootId);
  questions.delete(rootId);
  changed();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useSession(id: string | undefined) {
  return useSyncExternalStore(subscribe, () => (id ? sessions.get(id) : undefined));
}

export function useQuestions(rootId: string | undefined) {
  return useSyncExternalStore(subscribe, () => (rootId ? questions.get(rootId) : undefined));
}

export function useVersion() {
  return useSyncExternalStore(subscribe, () => version);
}

export function sessionOf(id: string) {
  return sessions.get(id);
}

/** The child a requester's tool call started. */
export function childOf(parentId: string, callId: string) {
  return sessions.get(parentId)?.children.map(id => sessions.get(id)).find(child => child?.snapshot?.toolCallId === callId);
}
