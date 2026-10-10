import { gatesOf, loadTasks, readyTasks, summarize } from './tasks.js';

/**
 * A project's tasks as task screens show them (ALPD §22): readiness, what blocks or waits,
 * approvals for the user, handoffs and progress. Used by the Paseo Tasks panel and the web app.
 * @param {string} projectRoot
 */
export async function taskRows(projectRoot) {
  const { tasks, errors } = await loadTasks(projectRoot);
  const ready = new Set(readyTasks(tasks).map(task => task.id));
  // Each parent's children, closed and in all.
  /** @type {Map<string, { done: number, total: number }>} */
  const children = new Map();
  for (const task of tasks) {
    if (!task.parent) continue;
    const count = children.get(task.parent) ?? { done: 0, total: 0 };
    count.total += 1;
    if (task.status === 'closed') count.done += 1;
    children.set(task.parent, count);
  }
  const rows = tasks.map(task => {
    const row = summarize(task, tasks);
    const approvals = task.status === 'closed' ? [] : task.gates.filter(gate => gate.kind === 'human' && !gate.resolved).map(gate => ({ gate: gate.id, note: gate.note ?? '' }));
    const waits = task.status === 'closed' ? [] : gatesOf(task, tasks);
    return {
      id: task.id, title: task.title, type: task.type, priority: task.priority, status: task.status,
      ...(task.parent ? { parent: task.parent } : {}),
      ...(task.assignee ? { assignee: task.assignee.agent } : {}),
      ready: ready.has(task.id),
      ...(row.blockedBy ? { blockedBy: row.blockedBy } : {}),
      ...(waits.length ? { waits } : {}),
      ...(approvals.length ? { approvals } : {}),
      ...(task.handoff ? { handoff: { outcome: String(task.handoff.outcome), summary: String(task.handoff.summary ?? ''), ...(typeof task.handoff.agent === 'string' ? { agent: task.handoff.agent } : {}) } } : {}),
      ...(task.closed ? { closed: { reason: task.closed.reason, ...(task.closed.summary ? { summary: task.closed.summary } : {}), at: task.closed.at } } : {}),
      ...(task.description ? { description: task.description.slice(0, 4000) } : {}),
      ...(task.labels.length ? { labels: task.labels } : {}),
      ...(task.paths.length ? { paths: task.paths } : {}),
      ...(children.has(task.id) ? { progress: children.get(task.id) } : {}),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  });
  return { tasks: rows, unreadable: errors };
}
