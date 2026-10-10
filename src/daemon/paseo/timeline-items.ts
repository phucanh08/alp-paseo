import type { AgentTimelineItem } from '@getpaseo/protocol/agent-types';
import type { TimelineItem } from '../../runtime/index.js';

/**
 * ALP's timeline items are snapshots by id (ALPD §4.2); Paseo's timeline is a log where text
 * grows by deltas and a tool call is the same call seen again (ALPD §62). This keeps the last
 * snapshot of each item and turns the next one into what Paseo appends, as Paseo does for
 * plugin providers (mapTimelineItem in packages/server/src/server/agent/plugin-provider.ts there).
 */
export class TimelineDeltas {
  private readonly last = new Map<string, TimelineItem>();

  /** What to append for this snapshot, or nothing when it adds nothing. */
  next(item: TimelineItem): AgentTimelineItem | null {
    const previous = this.last.get(item.id);
    this.last.set(item.id, item);
    switch (item.kind) {
      case 'assistant_message': {
        const before = previous?.kind === 'assistant_message' ? previous.text : '';
        const text = item.text.startsWith(before) ? item.text.slice(before.length) : item.text;
        return text ? { type: 'assistant_message', text, messageId: item.id } : null;
      }
      case 'user_message':
        if (previous?.kind === 'user_message' && previous.text === item.text) return null;
        // The app shows its own copy of the message until one with the id it sent arrives.
        return { type: 'user_message', text: item.text, messageId: item.clientMessageId ?? item.id, ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}) };
      case 'notice':
        if (previous?.kind === 'notice' && previous.text === item.text) return null;
        return { type: 'notification', level: item.level, message: item.text };
      case 'compaction':
        if (item.status === 'failed') return { type: 'notification', level: 'warning', message: 'Compacting the context failed' };
        return { type: 'compaction', status: item.status === 'running' ? 'loading' : 'completed', ...(item.trigger ? { trigger: item.trigger } : {}), ...(item.preTokens !== undefined ? { preTokens: item.preTokens } : {}) };
      case 'todo':
        return { type: 'todo', items: item.items.map(entry => ({ id: entry.id, text: entry.text, status: entry.status, completed: entry.status === 'completed' })) };
      case 'tool_call': {
        const detail = item.detail.type === 'shell'
          ? { type: 'shell' as const, command: item.detail.command, ...(item.detail.cwd ? { cwd: item.detail.cwd } : {}), output: item.detail.output, ...(item.detail.exitCode !== undefined ? { exitCode: item.detail.exitCode } : {}) }
          : { type: 'unknown' as const, input: (item.detail.input ?? null) as never, output: (item.detail.output ?? null) as never };
        return item.status === 'failed'
          ? { type: 'tool_call', callId: item.callId, name: item.name, status: 'failed', error: item.error ?? 'Tool call failed', detail }
          : { type: 'tool_call', callId: item.callId, name: item.name, status: item.status, error: null, detail };
      }
    }
  }
}
