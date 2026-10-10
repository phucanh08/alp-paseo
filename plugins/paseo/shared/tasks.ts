import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

/**
 * The Tasks panel's contract with the plugin server (plans/reference/ALPD.md §22).
 * Shared by the client bundle and the server bundle, so it imports only the SDK and zod.
 */

export const TaskRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
  priority: z.number(),
  status: z.enum(['open', 'in_progress', 'review', 'closed']),
  parent: z.string().optional(),
  assignee: z.string().optional(),
  ready: z.boolean(),
  /** Open tasks that must close first, including those of ancestors. */
  blockedBy: z.array(z.string()).optional(),
  /** Open gates, as labels. */
  waits: z.array(z.string()).optional(),
  /** Open human gates of this task: the user approves them here. */
  approvals: z.array(z.object({ gate: z.string(), note: z.string() })).optional(),
  handoff: z.object({ outcome: z.string(), summary: z.string(), agent: z.string().optional() }).optional(),
  closed: z.object({ reason: z.string(), summary: z.string().optional(), at: z.string() }).optional(),
  /** What the task is about, for its detail view; at most 4000 characters. */
  description: z.string().optional(),
  labels: z.array(z.string()).optional(),
  paths: z.array(z.string()).optional(),
  /** An epic or parent task: how many of its children are closed. */
  progress: z.object({ done: z.number(), total: z.number() }).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string(),
});
export type TaskRow = z.infer<typeof TaskRowSchema>;

const Directory = z.string().min(1);

export const tasksList = defineRpc({
  name: 'alp.tasks.list',
  input: z.object({ directory: Directory }),
  output: z.object({
    /** The ALP project containing the directory, or null when there is none. */
    projectRoot: z.string().nullable(),
    tasks: z.array(TaskRowSchema),
    unreadable: z.array(z.object({ file: z.string(), error: z.string() })),
    /** By provider session id: the tasks that session's tree worked on (ALPD §55). */
    sessions: z.record(z.string(), z.array(z.string())).optional(),
  }),
});

export const tasksAdd = defineRpc({
  name: 'alp.tasks.add',
  input: z.object({ directory: Directory, title: z.string().trim().min(1).max(200), priority: z.number().int().min(0).max(4).optional() }),
  output: z.object({ id: z.string() }),
});

export const tasksChange = defineRpc({
  name: 'alp.tasks.change',
  input: z.object({
    directory: Directory,
    id: z.string().min(1),
    action: z.enum(['close', 'reopen', 'approve']),
    /** For approve: the human gate. */
    gate: z.string().optional(),
    note: z.string().max(2000).optional(),
  }),
  /** landed: the first line of the report when the close landed an epic. */
  output: z.object({ id: z.string(), status: z.string(), landed: z.string().optional() }),
});

export type BoardSection = { key: string; title: string; tasks: TaskRow[] };

const rank = (a: TaskRow, b: TaskRow) => a.priority - b.priority || a.id.localeCompare(b.id);

/**
 * Groups tasks the way the user acts on them: what waits for the user first,
 * then what waits for main, what runs, what is ready, what waits, and what closed.
 */
export function boardSections(tasks: TaskRow[], closedLimit = 20): BoardSection[] {
  const open = tasks.filter(task => task.status !== 'closed');
  const sections: BoardSection[] = [
    { key: 'approve', title: 'Waiting for your approval', tasks: open.filter(task => task.approvals?.length).sort(rank) },
    { key: 'review', title: 'In review', tasks: open.filter(task => task.status === 'review').sort(rank) },
    { key: 'progress', title: 'In progress', tasks: open.filter(task => task.status === 'in_progress').sort(rank) },
    { key: 'ready', title: 'Ready', tasks: open.filter(task => task.ready).sort(rank) },
    { key: 'waiting', title: 'Blocked or waiting', tasks: open.filter(task => task.status === 'open' && !task.ready && !task.approvals?.length && task.type !== 'epic').sort(rank) },
    { key: 'epics', title: 'Epics', tasks: open.filter(task => task.type === 'epic' && !task.approvals?.length).sort(rank) },
    { key: 'closed', title: 'Closed', tasks: tasks.filter(task => task.status === 'closed').sort((a, b) => (b.closed?.at ?? b.updatedAt).localeCompare(a.closed?.at ?? a.updatedAt)).slice(0, closedLimit) },
  ];
  return sections.filter(section => section.tasks.length);
}
