import { execFile, spawn } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { closeTask, createTask, epicReport, loadTasks, reopenTask, resolveGate } from '../core/tasks.js';
import { taskRows } from '../core/task-rows.js';

/**
 * What a viewer outside Paseo needs beside sessions (ALPD §61): a project's tasks,
 * the folders to open a project from, and the changes in its checkout. They act as
 * the user, as the Paseo plugin's own server does.
 */

const run = promisify(execFile);
/** How much of a checkout's diff a viewer gets. */
const DIFF_CHARS = 400_000;
const BROWSE_LIMIT = 500;

async function absoluteDirectory(value: unknown, what = 'projectRoot') {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${what} must be an absolute path`);
  const directory = path.resolve(value);
  if (!(await stat(directory).catch(() => undefined))?.isDirectory()) throw new Error(`${directory} is not a directory`);
  return directory;
}

const isProject = (directory: string) => access(path.join(directory, '.alp')).then(() => true, () => false);

async function project(value: unknown) {
  const directory = await absoluteDirectory(value);
  if (!await isProject(directory)) throw new Error(`${directory} is not an ALP project`);
  return directory;
}

export function workspaceHandlers(): Record<string, (params: any) => Promise<unknown>> {
  return {
    async 'tasks.list'({ projectRoot }) {
      const root = await absoluteDirectory(projectRoot);
      if (!await isProject(root)) return { projectRoot: root, tasks: [], unreadable: [] };
      return { projectRoot: root, ...await taskRows(root) };
    },

    async 'tasks.add'({ projectRoot, title, priority }) {
      if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('title must be 1 to 200 characters');
      if (priority !== undefined && (!Number.isInteger(priority) || priority < 0 || priority > 4)) throw new Error('priority must be 0 to 4');
      const task = await createTask(await project(projectRoot), { title: title.trim(), ...(priority !== undefined ? { priority } : {}) }, 'user');
      return { id: task.id };
    },

    async 'tasks.change'({ projectRoot, id, action, gate, note }) {
      const root = await project(projectRoot);
      if (typeof id !== 'string' || !id) throw new Error('id is required');
      if (note !== undefined && (typeof note !== 'string' || note.length > 2000)) throw new Error('note must be at most 2000 characters');
      if (!['close', 'reopen', 'approve'].includes(action)) throw new Error('action must be close, reopen or approve');
      const task =
        action === 'close' ? await closeTask(root, id, { reason: 'done', ...(note ? { summary: note } : {}) }, 'user')
        : action === 'reopen' ? await reopenTask(root, id, { ...(note ? { note } : {}) }, 'user')
        : await resolveGate(root, id, gate ?? '', { by: 'user', ...(note ? { note } : {}) });
      if (action !== 'close') return { id: task.id, status: task.status };
      const { tasks } = await loadTasks(root);
      const landed = tasks.some(entry => entry.parent === task.id) ? epicReport(task.id, tasks).text.split('\n')[0] : undefined;
      return { id: task.id, status: task.status, ...(landed ? { landed } : {}) };
    },

    /** The folders inside a directory, to choose a project from; hidden ones are left out. */
    async 'project.browse'({ path: where }) {
      const directory = where === undefined ? os.homedir() : await absoluteDirectory(where, 'path');
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => { throw new Error(`Cannot read ${directory}: ${error.code ?? error.message}`); });
      const folders = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort((a, b) => a.localeCompare(b)).slice(0, BROWSE_LIMIT);
      const parent = path.dirname(directory);
      return {
        path: directory,
        parent: parent === directory ? null : parent,
        home: os.homedir(),
        project: await isProject(directory),
        directories: await Promise.all(folders.map(async name => ({ name, project: await isProject(path.join(directory, name)) }))),
      };
    },

    /** The checkout's branch, for viewers that copy it. */
    async 'project.info'({ projectRoot }) {
      const root = await absoluteDirectory(projectRoot);
      const branch = await run('git', ['-C', root, 'branch', '--show-current']).then(result => result.stdout.trim(), () => undefined);
      return { projectRoot: root, git: branch !== undefined, ...(branch ? { branch } : {}) };
    },

    /** Shows a directory in the system's file manager, on the user's machine. */
    async 'project.reveal'({ path: where }) {
      const directory = await absoluteDirectory(where, 'path');
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      spawn(opener, [directory], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
      return {};
    },

    /** The checkout's changed files and its diff against HEAD, untracked files listed. */
    async 'project.changes'({ projectRoot }) {
      const root = await absoluteDirectory(projectRoot);
      const git = (...args: string[]) => run('git', ['-C', root, ...args], { maxBuffer: 16 * 1024 * 1024 }).then(result => result.stdout);
      const inside = await git('rev-parse', '--is-inside-work-tree').then(out => out.trim() === 'true', () => false);
      if (!inside) return { git: false, files: [], diff: '' };
      const [branch, status, diff] = await Promise.all([
        git('branch', '--show-current').then(out => out.trim(), () => ''),
        git('status', '--porcelain=v1', '--untracked-files=all'),
        git('diff', 'HEAD', '--no-color', '--no-ext-diff').catch(() => git('diff', '--no-color', '--no-ext-diff')),
      ]);
      const files = status.split('\n').filter(Boolean).map(line => ({ status: line.slice(0, 2).trim() || '?', path: line.slice(3) }));
      return { git: true, branch, files, diff: diff.length > DIFF_CHARS ? diff.slice(0, DIFF_CHARS) : diff, ...(diff.length > DIFF_CHARS ? { truncated: true } : {}) };
    },
  };
}
