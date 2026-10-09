/**
 * Text another agent wrote, or a command printed, reaches an agent's prompt through
 * mail, handoffs, the board, recall answers, task text and tool results. A literal
 * system-reminder tag in it could pose as the harness, so ALP strips those tags
 * before such text enters a prompt (plans/reference/ALPD.md §32). Stripping repeats
 * until nothing changes, so a tag nested inside another cannot survive.
 */

const TAG = /<\s*\/?\s*system-reminder\b[^>]*>/gi;

/** `text` without system-reminder open or close tags. */
export function promptSafe(text) {
  if (typeof text !== 'string') return text;
  for (let current = text; ;) {
    const next = current.replace(TAG, '');
    if (next === current) return next;
    current = next;
  }
}
