import { access } from 'node:fs/promises';
import path from 'node:path';
import { closeTask, createTask, epicReport, gatesOf, loadTasks, readyTasks, reopenTask, resolveGate, summarize } from '../../../src/core/tasks.js';
import type { PluginServerContext } from './compat.js';
import { tasksAdd, tasksChange, tasksList, type TaskRow } from '../shared/tasks.js';
import { sessionTasks } from './session-tasks.js';

/** The nearest directory at or above `directory` that holds an ALP project. */
export async function projectOf(directory: string) {
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    try { await access(path.join(current, '.alp')); return current; }
    catch {}
    if (path.dirname(current) === current) return null;
  }
}

async function requireProject(directory: string) {
  const root = await projectOf(directory);
  if (!root) throw new Error(`${directory} is not in an ALP project; run alp init`);
  return root;
}

/** The Tasks panel's server side: reads and changes .alp/tasks as the user, without alpd. */
export function registerTaskRpc(server: PluginServerContext) {
  server.handle(tasksList, async ({ directory }) => {
    const projectRoot = await projectOf(directory);
    if (!projectRoot) return { projectRoot: null, tasks: [], unreadable: [] };
    const { tasks, errors } = await loadTasks(projectRoot);
    const ready = new Set(readyTasks(tasks).map(task => task.id));
    // Each parent's children, closed and in all.
    const children = new Map<string, { done: number; total: number }>();
    for (const task of tasks) {
      if (!task.parent) continue;
      const count = children.get(task.parent) ?? { done: 0, total: 0 };
      count.total += 1;
      if (task.status === 'closed') count.done += 1;
      children.set(task.parent, count);
    }
    const rows: TaskRow[] = tasks.map(task => {
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
    // The tasks each session worked on, of this project only.
    const known = new Set(tasks.map(task => task.id));
    const sessions = Object.fromEntries([...sessionTasks].map(([id, worked]) => [id, worked.filter(task => known.has(task))]).filter(([, worked]) => worked.length));
    return { projectRoot, tasks: rows, unreadable: errors, sessions };
  });

  server.handle(tasksAdd, async ({ directory, title, priority }) => {
    const task = await createTask(await requireProject(directory), { title, ...(priority !== undefined ? { priority } : {}) }, 'user');
    return { id: task.id };
  });

  server.handle(tasksChange, async ({ directory, id, action, gate, note }) => {
    const root = await requireProject(directory);
    const task =
      action === 'close' ? await closeTask(root, id, { reason: 'done', ...(note ? { summary: note } : {}) }, 'user')
      : action === 'reopen' ? await reopenTask(root, id, { ...(note ? { note } : {}) }, 'user')
      : await resolveGate(root, id, gate ?? '', { by: 'user', ...(note ? { note } : {}) });
    if (action !== 'close') return { id: task.id, status: task.status };
    const { tasks } = await loadTasks(root);
    const landed = tasks.some(entry => entry.parent === task.id) ? epicReport(task.id, tasks).text.split('\n')[0] : undefined;
    return { id: task.id, status: task.status, ...(landed ? { landed } : {}) };
  });
}
