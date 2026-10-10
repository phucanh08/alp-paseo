// Copied from Paseo (https://github.com/getpaseo/paseo, commit b63a325, packages/server/src/server/agent/chat-search/index.ts),
// Copyright (c) 2025-present Mohamed Boudra, Apache License 2.0 (paseo-web/LICENSE).
// Changed for ALP: it searches the store's projected rows, and an assistant message's Markdown source as a whole
// (Paseo counts rendered blocks with markdown-it); the app recounts on the rendered text either way. See ALPD §62.

import type { ProjectedTimelineRow } from './timeline-projection.js';

const PAGE_SIZE = 200;

export type SearchLocation = { seq: number; role: 'user' | 'assistant'; count: number };

function searchPattern(query: string): RegExp {
  const source = query
    .trim()
    .split(/\s+/)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(source, 'giu');
}

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  for (const _ of text.matchAll(pattern)) count += 1;
  return count;
}

/** The user and assistant messages after `cursor` that match, up to a page of them. */
export function searchTimeline({ rows, query, cursor = 0 }: { rows: readonly ProjectedTimelineRow[]; query: string; cursor?: number }) {
  const locations: SearchLocation[] = [];
  if (!query.trim()) return { locations, nextCursor: null };
  const pattern = searchPattern(query);
  for (const entry of rows) {
    if (entry.seqEnd <= cursor) continue;
    const item = entry.item;
    if (item.type !== 'user_message' && item.type !== 'assistant_message') continue;
    const count = countMatches(item.text.replace(/\r/g, ''), pattern);
    if (!count) continue;
    if (locations.length === PAGE_SIZE) return { locations, nextCursor: locations[PAGE_SIZE - 1]!.seq };
    locations.push({ seq: entry.seqEnd, role: item.type === 'user_message' ? 'user' : 'assistant', count });
  }
  return { locations, nextCursor: null };
}
