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
  gates: TaskGate[];
  assignee: { agent: string; session?: string; assignment?: string; since: string } | null;
  handoff: Record<string, unknown> | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closed: { at: string; by: string; reason: CloseReason; summary?: string } | null;
  log: TaskLogEntry[];
  compacted?: { at: string; by: string; chars: number };
};

export type GateKind = 'human' | 'timer' | 'gh:pr' | 'gh:run';
export type TaskGate = {
  id: string;
  kind: GateKind;
  note?: string;
  until?: string;
  repo?: string;
  ref?: string;
  at: string;
  by: string;
  resolved?: { at: string; by: string; note?: string };
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
export type TaskSummary = Pick<Task, 'id' | 'title' | 'type' | 'priority' | 'status'> & { labels?: string[]; parent?: string; blockedBy?: string[]; gates?: string[]; assignee?: string };
type WriteOptions = { ifRev?: number };

export const TASKS_DIR: string;
export const TASK_TYPES: TaskType[];
export const TASK_STATUSES: TaskStatus[];
export const CLOSE_REASONS: CloseReason[];
export const GATE_KINDS: GateKind[];
export const MAX_GATES: number;
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
export function submitTask(projectRoot: string, id: string, submit: { assignment: string; handoff: { outcome: string; summary: string } & Record<string, unknown>; agent: string }, by: string): Promise<Task>;
export function releaseTask(projectRoot: string, id: string, release: { assignment: string; handoff?: ({ outcome: string; summary: string } & Record<string, unknown>) | null; agent: string; reason: string }, by: string): Promise<Task>;
export function taskDigest(tasks: Task[], errors?: Array<{ file: string; error: string }>): string;
export function startRefusal(task: Task, tasks: Task[]): string | undefined;
export function gateOpen(gate: TaskGate, now?: number): boolean;
export function describeGate(gate: TaskGate): string;
export function gatesOf(task: Task, tasks: Task[]): string[];
export function addGate(projectRoot: string, id: string, gate: { kind: GateKind; note?: string; until?: string; ref?: string | number }, by: string): Promise<Task>;
export function resolveGate(projectRoot: string, id: string, gateId: string, resolve: { by: string; note?: string; remove?: boolean }): Promise<Task>;
export function checkGates(projectRoot: string, gh: (args: string[], options: { cwd: string }) => Promise<string>): Promise<{ cleared: Array<{ task: string; gate: string; detail: string }>; pending: Array<{ task: string; gate: string; detail: string }>; errors: Array<{ task: string; gate: string; error: string }> }>;
export function compactTasks(projectRoot: string, options: { days?: number; dryRun?: boolean }, by: string): Promise<Array<{ id: string; before: number; after: number }>>;
