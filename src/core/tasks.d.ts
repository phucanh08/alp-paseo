export type TaskType = 'task' | 'bug' | 'feature' | 'chore' | 'epic';
export type TaskStatus = 'open' | 'in_progress' | 'review' | 'closed';
export type CloseReason = 'done' | 'wontfix' | 'duplicate' | 'superseded';

export type TaskLogEntry = { at: string; by: string; event: string; [detail: string]: unknown };

export type Task = {
  id: string;
  rev: number;
  title: string;
  description: string;
  type: TaskType;
  priority: number;
  status: TaskStatus;
  labels: string[];
  paths: string[];
  parent: string | null;
  blockedBy: string[];
  discoveredFrom: string | null;
  related: string[];
  assignee: { agent: string; session?: string; assignment?: string; since: string } | null;
  handoff: Record<string, unknown> | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closed: { at: string; by: string; reason: CloseReason; summary?: string } | null;
  log: TaskLogEntry[];
};

export type TaskInput = {
  title?: string;
  description?: string;
  type?: TaskType;
  priority?: number | string;
  labels?: string[];
  paths?: string[];
  parent?: string | null;
  blockedBy?: string[];
  related?: string[];
  discoveredFrom?: string | null;
};

export type TaskLinks = { blockedBy?: string[]; related?: string[]; parent?: string };
export type TaskSummary = Pick<Task, 'id' | 'title' | 'type' | 'priority' | 'status'> & { labels?: string[]; parent?: string; blockedBy?: string[]; assignee?: string };
type WriteOptions = { ifRev?: number };

export const TASKS_DIR: string;
export const TASK_TYPES: TaskType[];
export const TASK_STATUSES: TaskStatus[];
export const CLOSE_REASONS: CloseReason[];
export const TITLE_CHARS: number;
export const DESCRIPTION_CHARS: number;
export const NOTE_CHARS: number;
export const MAX_LABELS: number;
export const MAX_PATHS: number;
export const MAX_LINKS: number;

export function isTaskId(id: unknown): id is string;
export function tasksDir(projectRoot: string): string;
export function loadTasks(projectRoot: string): Promise<{ tasks: Task[]; errors: Array<{ file: string; error: string }> }>;
export function getTask(projectRoot: string, id: string): Promise<Task>;
export function blockersOf(task: Task, tasks: Task[]): string[];
export function readyTasks(tasks: Task[]): Task[];
export function childrenOf(id: string, tasks: Task[]): Task[];
export function summarize(task: Task, tasks: Task[]): TaskSummary;
export function listTasks(tasks: Task[], filter?: { status?: TaskStatus; label?: string; parent?: string; all?: boolean }): Task[];
export function createTask(projectRoot: string, input: TaskInput & { title: string }, by: string): Promise<Task>;
export function updateTask(projectRoot: string, id: string, input: TaskInput & { note?: string }, by: string, options?: WriteOptions): Promise<Task>;
export function linkTask(projectRoot: string, id: string, change: { add?: TaskLinks; remove?: TaskLinks }, by: string, options?: WriteOptions): Promise<Task>;
export function startTask(projectRoot: string, id: string, assignee: { agent: string; session?: string; assignment?: string }, by: string, options?: WriteOptions): Promise<Task>;
export function closeTask(projectRoot: string, id: string, close: { reason?: CloseReason; summary?: string }, by: string, options?: WriteOptions): Promise<Task>;
export function reopenTask(projectRoot: string, id: string, reopen: { note?: string }, by: string, options?: WriteOptions): Promise<Task>;
