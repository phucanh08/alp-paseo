/**
 * Text the CLI prints for sessions and run logs, kept apart from the commands so
 * golden tests can render fixtures without an alpd (ALPD §39).
 */

const TASK_PAST = { create: 'created', update: 'updated', link: 'linked', start: 'started', close: 'closed', reopen: 'reopened', delegate: 'delegated', submit: 'submitted', release: 'released', gate: 'gated', clear: 'cleared a gate of', orphaned: 'reopened (its assignment ended with alpd)' };

/** How long ago `since` was, as 42s, 3m05s or 2h10m. */
export const ago = (since, now = Date.now()) => {
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}m`;
};
/** A duration in the same form. */
export const duration = ms => ago(new Date(0).toISOString(), ms);

/** `alp ps`: sessions as a tree, one line each. */
export function renderPs(sessions) {
  const lines = [];
  const children = new Map();
  for (const session of sessions) {
    const key = session.parentId ?? '';
    children.set(key, [...(children.get(key) ?? []), session]);
  }
  const print = (session, depth) => {
    const status = session.parked ? `parked (${session.parked})` : session.status === 'running' || session.status === 'idle' ? (session.activeTurnId ? 'running' : session.busy ? 'waiting' : 'idle') : session.lastError?.code ?? session.status;
    lines.push(`${'  '.repeat(depth)}${session.id}  ${session.agent}  ${session.runtime}:${session.model}  ${session.mode}  ${status}${depth ? '' : `  ${session.projectRoot}${session.title ? `  "${session.title}"` : ''}`}`);
    for (const child of children.get(session.id) ?? []) print(child, depth + 1);
  };
  for (const root of children.get('') ?? []) print(root, 0);
  return lines;
}

/** `alp log`: one line per run-log entry, with its time. */
export function renderLog(rootId, entries) {
  const lines = [];
  const agents = new Map();
  for (const entry of entries) {
    const time = entry.ts.slice(11, 19);
    let text;
    switch (entry.event) {
      case 'assignment.started':
        agents.set(entry.assignmentId, entry.agent);
        text = `${entry.parentAgent} → ${entry.agent} (${entry.mode}${entry.isolation === 'worktree' ? ', worktree' : ''}, ${entry.model}${entry.wait === false ? ', async' : ''}): ${entry.task.split('\n')[0].slice(0, 120)}`;
        break;
      case 'assignment.finished':
        text = `${entry.agent} ${entry.status} after ${duration(entry.durationMs ?? 0)}${entry.handoff ? `, handoff ${entry.handoff.outcome}${entry.handoff.verdict ? `, verdict ${entry.handoff.verdict.result.toUpperCase()}` : ''}: ${entry.handoff.summary.split('\n')[0].slice(0, 120)}` : ''}${entry.error ? `: ${entry.error}` : ''}${entry.reconciled ? ' (after a restart)' : ''}`;
        break;
      case 'mail':
        // Board pins are logged once, as board.pin, not per reader.
        if (entry.kind === 'board') continue;
        text = `✉ ${entry.kind} ${entry.from} → ${entry.to === rootId ? 'main' : agents.get(entry.to) ?? entry.to}${entry.body ? `: ${entry.body.split('\n')[0].slice(0, 120)}` : ''}`;
        break;
      case 'board.pin':
        text = `${entry.kind === 'claim' ? '⚑' : entry.kind === 'decision' ? '◆' : '•'} ${entry.agent} pins ${entry.kind} ${entry.pinId}${entry.task ? ` for ${entry.task}` : ''}${entry.paths ? ` [${entry.paths.join(', ')}]` : ''}: ${entry.body.split('\n')[0].slice(0, 120)}`;
        break;
      case 'task':
        text = `☐ ${entry.agent} ${TASK_PAST[entry.action] ?? entry.action} ${entry.id} "${entry.title}" → ${entry.status}${entry.detail ? `: ${entry.detail.split('\n')[0].slice(0, 120)}` : ''}`;
        break;
      case 'board.unpin':
        text = `⚐ ${entry.pinId} by ${entry.agent} ${entry.reason === 'session_ended' ? 'released when its session ended' : 'taken down'}`;
        break;
      case 'human.question':
        text = `? ${entry.agent} asks the user [${entry.questionId}]: ${entry.body.split('\n')[0].slice(0, 120)}`;
        break;
      case 'verify':
        text = `${entry.skipped ? '–' : entry.passed ? '✓' : '✗'} verify in the ${entry.where}${entry.taskId ? ` for ${entry.taskId}` : ''}${entry.assignmentId ? ` (${entry.assignmentId})` : ''}: ${entry.skipped ? `skipped: ${entry.skipped}` : entry.detail}`;
        break;
      case 'epic.landed':
        text = `◆ ${entry.agent} closed ${entry.id} "${entry.title}": ${entry.tasks} tasks, ${entry.reworked} reworked`;
        break;
      case 'notice':
        text = `${entry.level === 'error' ? '‼' : entry.level === 'warning' ? '!' : 'ℹ'} ${entry.text}`;
        break;
      case 'assignment.parked':
        text = `⏸ ${entry.agent} ${entry.assignmentId} parked: ${entry.reason}`;
        break;
      case 'assignment.resumed':
        text = `▶ ${entry.agent} ${entry.assignmentId} resumed`;
        break;
      case 'instructions':
        text = `# ${entry.agent} instructions ${entry.sha} (ALP.md ${entry.parts?.project}, AGENT.md ${entry.parts?.agent}, ${entry.chars} chars)`;
        break;
      case 'context':
        text = `◔ ${entry.agent} context ${entry.percent}% full: ${entry.level === 'now' ? 'told to hand off now' : 'told to plan a handoff'}`;
        break;
      case 'assignment.interrupted':
        text = `⏹ ${entry.agent} ${entry.assignmentId} interrupted: ${entry.reason}; the next alpd continues it`;
        break;
      case 'assignment.recovered':
        text = `↻ ${entry.agent} ${entry.assignmentId} reopened after alpd restarted`;
        break;
      case 'session.restarted':
        text = `↻ ${entry.agent}'s native process stopped (${entry.error}); restart ${entry.restarts}`;
        break;
      case 'session.revived':
        text = `▶ ${entry.agent} running again`;
        break;
      case 'session.revive_failed':
        text = `✗ ${entry.agent} could not be restarted: ${entry.error}`;
        break;
      case 'human.answer':
        text = `↳ ${entry.questionId} ${entry.outcome}${entry.answer !== undefined ? `: ${entry.answer.split('\n')[0].slice(0, 120)}` : ''}`;
        break;
      default:
        text = `${entry.event}${entry.branch ? ` ${entry.branch}` : ''}${entry.status ? ` ${entry.status}` : ''}`;
    }
    lines.push(`${time}  ${text}`);
  }
  return lines;
}
