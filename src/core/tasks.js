import { mkdir, readFile, readdir, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { AlpError } from './errors.js';

/**
 * The project's task graph (plans/reference/ALPD.md §20), modelled on beads:
 * one JSON file per task in .alp/tasks, committed with the project. A relation
 * lives on the dependent task, so adding a child or a blocker never touches the
 * other task's file. Every writer, the CLI and alpd alike, goes through this
 * module: it holds a lock directory while it reads, checks and writes a task.
 */

export const TASKS_DIR = path.join('.alp', 'tasks');
export const TASK_TYPES = ['task', 'bug', 'feature', 'chore', 'epic'];
export const TASK_STATUSES = ['open', 'in_progress', 'review', 'closed'];
export const CLOSE_REASONS = ['done', 'wontfix', 'duplicate', 'superseded'];
export const TITLE_CHARS = 200;
export const DESCRIPTION_CHARS = 8000;
export const NOTE_CHARS = 2000;
export const MAX_LABELS = 10;
export const MAX_PATHS = 50;
export const MAX_LINKS = 50;
const LOG_KEEP = 50;
const LOCK = '.lock';
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const GITIGNORE = `${LOCK}\n*.tmp\n`;

const ID = /^t-[0-9a-f]{4,12}(?:\.\d+)*$/;
export const isTaskId = id => typeof id === 'string' && ID.test(id);

export const tasksDir = projectRoot => path.join(path.resolve(projectRoot), TASKS_DIR);
const taskFile = (projectRoot, id) => path.join(tasksDir(projectRoot), `${id}.json`);
const now = () => new Date().toISOString();
const fail = (code, message) => { throw new AlpError(code, message); };

/** Reads every task. A file that does not parse is reported and skipped, never fatal. */
export async function loadTasks(projectRoot) {
  const dir = tasksDir(projectRoot);
  let names;
  try { names = await readdir(dir); }
  catch (error) { if (error.code === 'ENOENT') return { tasks: [], errors: [] }; throw error; }
  const tasks = [];
  const errors = [];
  for (const name of names.filter(name => name.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    try {
      const task = JSON.parse(await readFile(file, 'utf8'));
      if (!task || typeof task !== 'object' || task.id !== name.slice(0, -5) || !isTaskId(task.id) || !TASK_STATUSES.includes(task.status) || typeof task.title !== 'string') {
        throw new Error('not an ALP task, or its id differs from the file name');
      }
      tasks.push(normalize(task));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      errors.push({ file: path.relative(path.resolve(projectRoot), file), error: error.message });
    }
  }
  return { tasks, errors };
}

/** Fills fields an older or hand-written file lacks, so readers can rely on them. */
function normalize(task) {
  return {
    description: '', type: 'task', priority: 2, labels: [], paths: [], parent: null, blockedBy: [],
    discoveredFrom: null, related: [], assignee: null, handoff: null, closed: null, log: [], rev: 0,
    ...task,
  };
}

export async function getTask(projectRoot, id) {
  const { tasks } = await loadTasks(projectRoot);
  return tasks.find(task => task.id === id) ?? fail('TASK_NOT_FOUND', `No task ${id} in ${TASKS_DIR}`);
}

// --- the graph -------------------------------------------------------------

const byId = tasks => new Map(tasks.map(task => [task.id, task]));

/** Open blockers of a task: its own unclosed blockedBy, then those of its ancestors. Missing tasks block nothing. */
export function blockersOf(task, tasks, index = byId(tasks)) {
  const found = [];
  const seen = new Set();
  for (let current = task; current && !seen.has(current.id); current = current.parent ? index.get(current.parent) : undefined) {
    seen.add(current.id);
    for (const id of current.blockedBy) {
      const blocker = index.get(id);
      if (blocker && blocker.status !== 'closed' && !found.includes(id)) found.push(id);
    }
  }
  return found;
}

const rank = (a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** Tasks anyone can start now: open, not an epic, and blocked by nothing; most urgent first. */
export function readyTasks(tasks) {
  const index = byId(tasks);
  return tasks.filter(task => task.status === 'open' && task.type !== 'epic' && !blockersOf(task, tasks, index).length).sort(rank);
}

export const childrenOf = (id, tasks) => tasks.filter(task => task.parent === id).sort(rank);

/** A short row for lists and agent tool results. */
export function summarize(task, tasks, index = byId(tasks)) {
  const blockers = task.status === 'closed' ? [] : blockersOf(task, tasks, index);
  return {
    id: task.id, title: task.title, type: task.type, priority: task.priority, status: task.status,
    ...(task.labels.length ? { labels: task.labels } : {}),
    ...(task.parent ? { parent: task.parent } : {}),
    ...(blockers.length ? { blockedBy: blockers } : {}),
    ...(task.assignee ? { assignee: task.assignee.agent } : {}),
  };
}

/** Lists tasks; by default every task that is not closed, most urgent first. */
export function listTasks(tasks, { status, label, parent, all = false } = {}) {
  return tasks
    .filter(task => status ? task.status === status : all || task.status !== 'closed')
    .filter(task => !label || task.labels.includes(label))
    .filter(task => !parent || task.parent === parent)
    .sort(rank);
}

/** The chain an edge from `from` to `to` would close, or undefined. Edges: blockedBy and parent. */
function cycle(tasks, from, to) {
  const index = byId(tasks);
  const next = id => { const task = index.get(id); return task ? [...task.blockedBy, ...(task.parent ? [task.parent] : [])] : []; };
  const seen = new Set();
  const walk = (id, trail) => {
    if (id === from) return [...trail, id];
    if (seen.has(id)) return undefined;
    seen.add(id);
    for (const after of next(id)) { const found = walk(after, [...trail, id]); if (found) return found; }
    return undefined;
  };
  return walk(to, [from])?.join(' → ');
}

const ancestors = (id, tasks) => {
  const index = byId(tasks);
  const found = [];
  for (let current = index.get(id)?.parent; current && !found.includes(current); current = index.get(current)?.parent) found.push(current);
  return found;
};

// --- validation ----------------------------------------------------------------

function checkText(value, name, limit, { required = false } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > limit) fail('INVALID_TASK', `${name} must be ${required ? 'nonempty ' : ''}text of at most ${limit} characters`);
  return required ? value.trim() : value;
}

function list(value, name, limit, check = item => typeof item === 'string' && !!item.trim()) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > limit || !value.every(check)) fail('INVALID_TASK', `${name} must list at most ${limit} entries`);
  return [...new Set(value.map(item => item.trim()))];
}

function normalizePaths(value, projectRoot) {
  const paths = list(value, 'paths', MAX_PATHS);
  if (!paths) return undefined;
  const root = path.resolve(projectRoot);
  return [...new Set(paths.map(entry => {
    const relative = path.relative(root, path.resolve(root, entry)).split(path.sep).join('/');
    if (relative.startsWith('..') || path.isAbsolute(relative)) fail('INVALID_TASK', `${entry} is outside the project`);
    return relative || '.';
  }))];
}

function fields(input, projectRoot) {
  const out = {};
  if (input.title !== undefined) out.title = checkText(input.title, 'title', TITLE_CHARS, { required: true });
  if (input.description !== undefined) out.description = checkText(input.description, 'description', DESCRIPTION_CHARS);
  if (input.type !== undefined) {
    if (!TASK_TYPES.includes(input.type)) fail('INVALID_TASK', `type must be one of ${TASK_TYPES.join(', ')}`);
    out.type = input.type;
  }
  if (input.priority !== undefined) {
    const priority = typeof input.priority === 'string' ? Number(input.priority.replace(/^p/i, '')) : input.priority;
    if (!Number.isInteger(priority) || priority < 0 || priority > 4) fail('INVALID_TASK', 'priority must be 0 (urgent) to 4 (backlog)');
    out.priority = priority;
  }
  if (input.labels !== undefined) out.labels = list(input.labels, 'labels', MAX_LABELS, label => typeof label === 'string' && /^[\w.:/-]{1,50}$/.test(label));
  if (input.paths !== undefined) out.paths = normalizePaths(input.paths, projectRoot);
  return out;
}

const taskIds = (value, name) => list(value, name, MAX_LINKS, isTaskId);

function requireTask(tasks, id, role) {
  if (!isTaskId(id)) fail('INVALID_TASK', `${role} must be a task id such as t-a3f8`);
  return byId(tasks).get(id) ?? fail('TASK_NOT_FOUND', `No task ${id}`);
}

function addLog(task, by, event, details = {}) {
  task.log = [...task.log, { at: now(), by, event, ...details }].slice(-LOG_KEEP);
}

// --- storage -----------------------------------------------------------------

const queues = new Map();

/** Runs `work` holding the project's task lock: in this process, then across processes. */
async function locked(projectRoot, work) {
  const dir = tasksDir(projectRoot);
  const previous = queues.get(dir) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    await prepare(dir);
    const lock = path.join(dir, LOCK);
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try { await mkdir(lock); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const age = await stat(lock).then(info => Date.now() - info.mtimeMs, () => 0);
        if (age > LOCK_STALE_MS) { await rmdir(lock).catch(() => {}); continue; }
        if (Date.now() > deadline) fail('TASKS_LOCKED', `${path.join(TASKS_DIR, LOCK)} is held by another writer; retry, or remove it if no ALP process is running`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try { return await work(); }
    finally { await rmdir(lock).catch(() => {}); }
  });
  queues.set(dir, run);
  return run;
}

/** Creates the directory and its .gitignore on first use, so tasks are ready to commit. */
async function prepare(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '.gitignore'), GITIGNORE, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
}

async function save(projectRoot, task) {
  const file = taskFile(projectRoot, task.id);
  const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(task, null, 2) + '\n');
  await rename(temporary, file);
  return task;
}

function newId(tasks, title, parent) {
  const taken = new Set(tasks.map(task => task.id));
  if (parent) {
    const prefix = `${parent}.`;
    const used = tasks.filter(task => task.id.startsWith(prefix) && !task.id.slice(prefix.length).includes('.')).map(task => Number(task.id.slice(prefix.length)));
    return `${prefix}${Math.max(0, ...used) + 1}`;
  }
  const hash = createHash('sha256').update(`${title}\0${now()}\0${randomUUID()}`).digest('hex');
  for (let length = 4; length <= 12; length++) if (!taken.has(`t-${hash.slice(0, length)}`)) return `t-${hash.slice(0, length)}`;
  return fail('INVALID_TASK', 'Could not choose a free task id');
}

/**
 * Creates a task. `by` is user, or the agent that created it.
 * @param {string} projectRoot
 * @param {{ title: string, description?: string, type?: string, priority?: number, labels?: string[], paths?: string[], parent?: string, blockedBy?: string[], related?: string[], discoveredFrom?: string }} input
 * @param {string} by
 */
export function createTask(projectRoot, input, by) {
  return locked(projectRoot, async () => {
    const { tasks } = await loadTasks(projectRoot);
    if (input?.title === undefined) fail('INVALID_TASK', 'A task needs a title');
    const values = fields(input, projectRoot);
    const parent = input.parent === undefined || input.parent === null ? undefined : requireTask(tasks, input.parent, 'parent');
    if (parent?.status === 'closed') fail('INVALID_TASK', `Parent ${parent.id} is closed; reopen it first`);
    const blockedBy = taskIds(input.blockedBy, 'blockedBy') ?? [];
    for (const id of blockedBy) requireTask(tasks, id, 'blockedBy');
    if (parent) for (const id of blockedBy) if (id === parent.id || ancestors(parent.id, tasks).includes(id)) fail('INVALID_TASK', `A task cannot be blocked by its parent or ancestor ${id}`);
    const related = taskIds(input.related, 'related') ?? [];
    for (const id of related) requireTask(tasks, id, 'related');
    const discoveredFrom = input.discoveredFrom === undefined || input.discoveredFrom === null ? null : requireTask(tasks, input.discoveredFrom, 'discoveredFrom').id;
    const at = now();
    const task = normalize({
      id: newId(tasks, values.title, parent?.id), rev: 1, ...values, status: 'open',
      parent: parent?.id ?? null, blockedBy, discoveredFrom, related,
      createdBy: by, createdAt: at, updatedAt: at,
    });
    addLog(task, by, 'created');
    return save(projectRoot, task);
  });
}

/**
 * Changes one task under the lock. `change` edits the task in place and may
 * throw an AlpError; `ifRev` refuses the write when the task changed since read.
 */
function mutate(projectRoot, id, change, { ifRev } = {}) {
  return locked(projectRoot, async () => {
    const { tasks } = await loadTasks(projectRoot);
    const task = requireTask(tasks, id, 'id');
    if (ifRev !== undefined && task.rev !== ifRev) fail('TASK_CHANGED', `${id} changed (rev ${task.rev}, expected ${ifRev}); read it again`);
    const before = JSON.stringify(task);
    await change(task, tasks);
    if (JSON.stringify(task) === before) return task;
    task.rev += 1;
    task.updatedAt = now();
    return save(projectRoot, task);
  });
}

/** Edits title, description, type, priority, labels or paths; a note only adds to the log. */
export function updateTask(projectRoot, id, input, by, options) {
  return mutate(projectRoot, id, task => {
    const values = fields(input ?? {}, projectRoot);
    const note = checkText(input?.note, 'note', NOTE_CHARS);
    if (values.type === 'epic' && task.status !== 'open' && task.status !== 'closed') fail('INVALID_TASK', `${id} is ${task.status}; an epic is never worked on directly`);
    const changed = Object.keys(values).filter(key => JSON.stringify(task[key]) !== JSON.stringify(values[key]));
    if (!changed.length && !note) return;
    Object.assign(task, values);
    addLog(task, by, 'updated', { ...(changed.length ? { fields: changed } : {}), ...(note ? { note } : {}) });
  }, options);
}

/**
 * Adds or removes relations of a task: blockedBy, related and parent.
 * Refuses an edge that closes a cycle, naming the chain.
 * @param {{ add?: { blockedBy?: string[], related?: string[], parent?: string }, remove?: { blockedBy?: string[], related?: string[], parent?: string } }} change
 */
export async function linkTask(projectRoot, id, { add = {}, remove = {} } = {}, by, options) {
  const keys = ['blockedBy', 'related', 'parent'];
  for (const part of [add, remove]) {
    if (!part || typeof part !== 'object' || Array.isArray(part) || !Object.keys(part).every(key => keys.includes(key))) fail('INVALID_TASK', 'add and remove take blockedBy, related and parent');
  }
  return mutate(projectRoot, id, (task, tasks) => {
    const changes = [];
    for (const other of taskIds(remove.blockedBy, 'blockedBy') ?? []) {
      if (task.blockedBy.includes(other)) { task.blockedBy = task.blockedBy.filter(entry => entry !== other); changes.push(`-blockedBy ${other}`); }
    }
    for (const other of taskIds(remove.related, 'related') ?? []) {
      if (task.related.includes(other)) { task.related = task.related.filter(entry => entry !== other); changes.push(`-related ${other}`); }
    }
    if (remove.parent !== undefined) {
      if (remove.parent !== task.parent) fail('INVALID_TASK', `${id} is not a child of ${remove.parent}`);
      task.parent = null;
      changes.push(`-parent ${remove.parent}`);
    }
    // Check new edges against the graph as it stands after the removals.
    const graph = tasks.map(entry => entry.id === id ? task : entry);
    if (add.parent !== undefined) {
      const parent = requireTask(tasks, add.parent, 'parent');
      if (parent.id === id) fail('INVALID_TASK', 'A task cannot be its own parent');
      if (parent.status === 'closed') fail('INVALID_TASK', `Parent ${parent.id} is closed; reopen it first`);
      if (task.parent && task.parent !== parent.id) fail('INVALID_TASK', `${id} already has parent ${task.parent}; remove it first`);
      const above = [parent.id, ...ancestors(parent.id, graph)];
      const blocking = task.blockedBy.find(other => above.includes(other));
      if (blocking) fail('INVALID_TASK', `${id} is blocked by ${blocking}, which would become its parent or ancestor`);
      const chain = cycle(graph, id, parent.id);
      if (chain) fail('TASK_CYCLE', `That would make a cycle (each waits on the next): ${chain}`);
      if (task.parent !== parent.id) { task.parent = parent.id; changes.push(`+parent ${parent.id}`); }
    }
    for (const other of taskIds(add.blockedBy, 'blockedBy') ?? []) {
      requireTask(tasks, other, 'blockedBy');
      if (other === id) fail('INVALID_TASK', 'A task cannot block itself');
      if (ancestors(id, graph).includes(other)) fail('INVALID_TASK', `A task cannot be blocked by its parent or ancestor ${other}`);
      const chain = cycle(graph, id, other);
      if (chain) fail('TASK_CYCLE', `That would make a cycle (each waits on the next): ${chain}`);
      if (!task.blockedBy.includes(other)) { task.blockedBy = [...task.blockedBy, other]; changes.push(`+blockedBy ${other}`); }
      if (task.blockedBy.length > MAX_LINKS) fail('INVALID_TASK', `A task lists at most ${MAX_LINKS} blockers`);
    }
    for (const other of taskIds(add.related, 'related') ?? []) {
      requireTask(tasks, other, 'related');
      if (other === id) fail('INVALID_TASK', 'A task cannot relate to itself');
      if (!task.related.includes(other)) { task.related = [...task.related, other]; changes.push(`+related ${other}`); }
      if (task.related.length > MAX_LINKS) fail('INVALID_TASK', `A task lists at most ${MAX_LINKS} related tasks`);
    }
    if (changes.length) addLog(task, by, 'linked', { changes });
  }, options);
}

/**
 * Takes a ready task, or one in review back for rework, for an assignee.
 * The check and the write happen under one lock, so two starts of one task cannot both succeed.
 * @param {{ agent: string, session?: string, assignment?: string }} assignee
 */
export function startTask(projectRoot, id, assignee, by, options) {
  return mutate(projectRoot, id, (task, tasks) => {
    if (task.type === 'epic') fail('TASK_NOT_READY', `${id} is an epic; start one of its children`);
    if (task.status === 'in_progress') fail('TASK_TAKEN', `${id} is already in progress with ${task.assignee?.agent ?? 'someone'}`);
    if (task.status === 'closed') fail('TASK_NOT_READY', `${id} is closed; reopen it first`);
    const blockers = blockersOf(task, tasks);
    if (blockers.length) fail('TASK_NOT_READY', `${id} is blocked by ${blockers.join(', ')}`);
    const rework = task.status === 'review';
    task.status = 'in_progress';
    task.assignee = { ...assignee, since: now() };
    addLog(task, by, rework ? 'reworked' : 'started', { to: assignee.agent });
  }, options);
}

/** Closes a task with a reason and a summary of the outcome. */
export function closeTask(projectRoot, id, { reason = 'done', summary } = {}, by, options) {
  return mutate(projectRoot, id, (task, tasks) => {
    if (!CLOSE_REASONS.includes(reason)) fail('INVALID_TASK', `reason must be one of ${CLOSE_REASONS.join(', ')}`);
    const closing = checkText(summary, 'summary', NOTE_CHARS);
    if (task.status === 'closed') fail('INVALID_TASK', `${id} is already closed`);
    const open = childrenOf(id, tasks).filter(child => child.status !== 'closed').map(child => child.id);
    if (reason === 'done' && open.length) fail('INVALID_TASK', `${id} has open children: ${open.join(', ')}; close them first`);
    task.status = 'closed';
    task.closed = { at: now(), by, reason, ...(closing ? { summary: closing } : {}) };
    task.assignee = null;
    addLog(task, by, 'closed', { reason, ...(closing ? { summary: closing } : {}) });
  }, options);
}

/** Reopens a closed task, or puts one in progress or in review back to open. */
export function reopenTask(projectRoot, id, { note } = {}, by, options) {
  return mutate(projectRoot, id, (task, tasks) => {
    const reason = checkText(note, 'note', NOTE_CHARS);
    if (task.status === 'open') fail('INVALID_TASK', `${id} is already open`);
    const parent = task.parent ? byId(tasks).get(task.parent) : undefined;
    if (parent?.status === 'closed') fail('INVALID_TASK', `Its parent ${parent.id} is closed; reopen the parent first`);
    const from = task.status;
    task.status = 'open';
    task.assignee = null;
    task.closed = null;
    addLog(task, by, 'reopened', { from, ...(reason ? { note: reason } : {}) });
  }, options);
}
