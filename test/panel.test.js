import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as sdk from '@getpaseo/plugin';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import contribute from '../plugins/paseo/server/dist/index.js';
import { addGate, closeTask, createTask, getTask, startTask, submitTask } from '../src/core/tasks.js';

const require = createRequire(import.meta.url);
const plugin = fileURLToPath(new URL('../plugins/paseo/', import.meta.url));

// The modules Paseo 0.11.1 supplies to plugin client code (server/plugins/compiler.js); anything else fails to load.
const HOST = ['@getpaseo/plugin', '@getpaseo/plugin/client', '@getpaseo/plugin/client/react-native', '@getpaseo/plugin/client/ui', '@tanstack/react-query', 'react', 'react/jsx-runtime', 'react-native', 'zod'];

/** Bundles client code the way Paseo's plugin compiler does. */
async function compileClient(entry) {
  const result = await build({
    entryPoints: [path.join(plugin, entry)], bundle: true, format: 'cjs', jsx: 'automatic', write: false, metafile: true,
    platform: 'neutral', target: 'es2020', mainFields: ['module', 'main'], supported: { 'async-await': false }, external: HOST, logLevel: 'silent',
  });
  const externals = new Set(Object.values(result.metafile.inputs).flatMap(input => input.imports.filter(entry => entry.external && !entry.path.startsWith('<')).map(entry => entry.path)));
  // esbuild's own helpers appear as <runtime>.
  const inputs = Object.keys(result.metafile.inputs).filter(input => !input.startsWith('<'));
  return { code: result.outputFiles[0].text, externals: [...externals], inputs };
}

const tag = name => ({ children, accessibilityLabel, onPress: _onPress, style: _style, contentContainerStyle: _c, ...rest }) =>
  createElement(name, { 'data-label': accessibilityLabel, ...(rest.value !== undefined ? { 'data-value': rest.value } : {}), ...(rest.placeholder ? { 'data-placeholder': rest.placeholder } : {}) }, children);

/** Host modules for rendering in Node: React Native views become plain elements. */
function hostModules(overrides = {}) {
  return {
    '@getpaseo/plugin': sdk,
    zod: require('zod'),
    react: require('react'),
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { View: tag('view'), Text: tag('text'), Pressable: tag('button'), TextInput: tag('input') },
    '@getpaseo/plugin/client/react-native': { ScrollView: tag('scroll'), Icon: tag('icon'), TextInput: tag('input'), useToast: () => ({ show() {}, error() {} }) },
    '@getpaseo/plugin/client': { useRpc: () => async () => ({}), useWorkspace: () => null },
    // The settings kit; test/settings-screen.test.js renders it.
    '@getpaseo/plugin/client/ui': {},
    ...overrides,
  };
}

function load(code, modules = hostModules()) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(id => {
    if (!(id in modules)) throw new Error(`Module "${id}" is not available in plugin client code`);
    return modules[id];
  }, module, module.exports);
  return module.exports;
}

const theme = { colors: { surface0: '#fff', surface1: '#eee', surface2: '#ddd', border: '#ccc', foreground: '#000', foregroundMuted: '#666', accent: '#06c', accentForeground: '#fff', statusSuccess: '#0a0', statusWarning: '#a60', statusDanger: '#c00' } };

const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); };

/**
 * A client context with a host of agents: what the pills see of Paseo's agents.list,
 * workspaces and plugin RPC. Test code drives the subscription through `host`.
 */
function fakeClient(boards) {
  const host = { observers: [], released: false, pills: [], screens: [], opened: [], panels: [], commands: [], slash: [], reads: [] };
  const page = entries => ({ entries: entries.map(agent => ({ agent })), pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } });
  host.snapshot = agents => host.observers.forEach(observer => observer.snapshot({ ...page(agents), subscriptionId: 's1' }));
  host.update = payload => host.observers.forEach(observer => observer.update({ type: 'agent_update', payload }));
  const client = {
    paseo: {
      agents: {
        list: async options => ({
          ...page([]),
          subscription: options.subscribe ? { release: async () => { host.released = true; }, subscribe: observer => { host.observers.push(observer); return () => {}; } } : undefined,
        }),
      },
      workspaces: { ref: id => ({ refresh: async () => ({ id, workspaceDirectory: `/w/${id}`, projectRootPath: '/w' }) }) },
    },
    rpc: async (contract, input) => { host.reads.push([contract.name, input.directory]); return boards[input.directory] ?? { projectRoot: null, tasks: [], unreadable: [] }; },
    openScreen: input => host.opened.push(input),
    addScreen: screen => { host.screens.push(screen); return () => {}; },
    addComposerPill: contribution => {
      const pill = { ...contribution, removed: false, updates: 0 };
      host.pills.push(pill);
      return { update: patch => { pill.button = { ...pill.button, ...patch }; pill.updates += 1; }, remove: () => { pill.removed = true; } };
    },
    addWorkspacePanel: panel => { host.panels.push(panel); return () => {}; },
    addCommandCenterItem: item => { host.commands.push(item); return () => {}; },
    addSlashCommand: command => { host.slash.push(command); return () => {}; },
    addSettingsScreen: () => () => {},
  };
  return { client, host };
}

const row = (id, title, extra = {}) => ({ id, title, type: 'task', priority: 2, status: 'open', ready: false, updatedAt: '2026-10-09T00:00:00Z', ...extra });

test('the client entry bundles with only the modules Paseo supplies and registers the Tasks panel, screen, commands and pills', async () => {
  const { code, externals, inputs } = await compileClient('index.client.tsx');
  assert.deepEqual(externals.filter(id => !HOST.includes(id)), []);
  // Paseo refuses client code outside client/, shared/ and the entry.
  assert.deepEqual(inputs.filter(input => !/^(index\.client\.tsx|client\/|shared\/)/.test(path.relative(plugin, path.resolve(input)).split(path.sep).join('/'))), []);
  const { client, host } = fakeClient({});
  const cleanup = load(code).default(client);
  assert.equal(typeof cleanup, 'function');
  assert.deepEqual(host.panels.filter(panel => panel.id === 'alp-tasks').map(panel => [panel.id, panel.title, panel.icon, panel.context, typeof panel.Component]), [['alp-tasks', 'Tasks', 'ListTodo', 'workspace', 'function']]);
  assert.deepEqual(host.screens.map(screen => [screen.id, screen.title({}), screen.title({ taskId: 't-0003' }), typeof screen.Component]), [['alp-tasks', 'ALP tasks', 'ALP task t-0003', 'function']]);

  // The desktop opens the panel; the full-screen item and /alp-tasks open the screen, which phones reach.
  const workspace = { id: 'ws1', directory: '/w/ws1', projectRootPath: '/w' };
  const opened = [];
  host.commands.find(item => item.id === 'alp-open-tasks').onSelect({ openPanel: id => opened.push(id) });
  host.commands.find(item => item.id === 'alp-open-tasks-screen').onSelect({ workspace, openScreen: input => opened.push(input) });
  const [slash] = host.slash;
  assert.deepEqual([slash.name, slash.context, slash.argumentHint], ['alp-tasks', 'agent', '[task id]']);
  slash.onSubmit({ workspace, agent: { id: 'a1' }, args: '', openScreen: input => opened.push(input) });
  slash.onSubmit({ workspace: { ...workspace, directory: '' }, agent: { id: 'a1' }, args: ' t-0003 ', openScreen: input => opened.push(input) });
  assert.deepEqual(opened, [
    'alp-tasks',
    { screenId: 'alp-tasks', params: { workspaceId: 'ws1', directory: '/w/ws1' } },
    { screenId: 'alp-tasks', params: { workspaceId: 'ws1', directory: '/w/ws1' } },
    { screenId: 'alp-tasks', params: { workspaceId: 'ws1', directory: '/w', taskId: 't-0003' } },
  ]);
  await settle();
  assert.equal(host.observers.length, 1, 'the pills follow the host\'s agents');
  await cleanup();
  assert.equal(host.released, true);
});

test('each ALP agent\'s composer gets a Tasks pill whose menu opens the screen on a task', async () => {
  const { code } = await compileClient('client/task-pills.ts');
  const { addTaskPills, taskButton, menuTasks } = load(code);
  const tasks = [
    row('t-0001', 'Ship the release', { approvals: [{ gate: 'g1', note: 'Approve?' }] }),
    row('t-0002', 'Add --json', { status: 'review' }),
    row('t-0003', 'Normalize', { status: 'in_progress', priority: 1 }),
    row('t-0004', 'Fix colors', { ready: true, priority: 3 }),
    row('t-0004.1', 'Docs', { blockedBy: ['t-0002'] }),
    row('t-0006', 'Old', { status: 'closed', closed: { reason: 'done', at: '2026-10-08T00:00:00Z' } }),
    row('t-0007', 'CLI polish', { type: 'epic', progress: { done: 0, total: 2 } }),
  ];
  const { client, host } = fakeClient({ '/w/ws1': { projectRoot: '/w', tasks, unreadable: [] } });
  const stop = addTaskPills(client);
  await settle();
  // ALP agents with a workspace, not archived; other providers get none.
  host.snapshot([
    { id: 'a1', provider: 'alp', workspaceId: 'ws1', cwd: '/w/ws1/sub' },
    { id: 'a2', provider: 'codex', workspaceId: 'ws1', cwd: '/w/ws1' },
    { id: 'a3', provider: 'alp', cwd: '/w' },
    { id: 'a4', provider: 'alp', workspaceId: 'ws1', cwd: '/w', archivedAt: '2026-10-09T00:00:00Z' },
  ]);
  await settle();
  assert.deepEqual(host.pills.map(pill => [pill.id, pill.workspaceId, pill.agentId]), [['alp-tasks', 'ws1', 'a1']]);
  const [pill] = host.pills;
  // The tasks of the workspace's directory, as the panel reads them.
  assert.deepEqual(host.reads, [['alp.tasks.list', '/w/ws1']]);
  assert.deepEqual([pill.button.label, pill.button.title, pill.button.visible], ['Tasks · 5', 'ALP tasks: 5 open', true]);
  const items = pill.button.behavior.items;
  assert.deepEqual(items.map(item => item.kind === 'item' ? item.title : '---'), [
    'Approve · Ship the release', 'Review · Add --json', 'In progress · Normalize', 'Ready · Fix colors', 'Blocked · Docs', '---', 'All tasks',
  ]);
  assert.ok(items.every(item => /^[a-z][a-z0-9-]*$/.test(item.id)), 'menu ids are what the host accepts');
  items[4].behavior.onPress();
  items.at(-1).behavior.onPress();
  assert.deepEqual(host.opened, [
    { screenId: 'alp-tasks', params: { workspaceId: 'ws1', directory: '/w/ws1', taskId: 't-0004.1' } },
    { screenId: 'alp-tasks', params: { workspaceId: 'ws1', directory: '/w/ws1' } },
  ]);

  // An unchanged board leaves the pill alone, so an open menu stays open.
  const updates = pill.updates;
  host.update({ kind: 'upsert', agent: { id: 'a5', provider: 'alp', workspaceId: 'ws2', cwd: '/elsewhere' } });
  await settle();
  assert.equal(pill.updates, updates);
  // Outside an ALP project the pill hides; a removed agent loses it.
  const other = host.pills.find(entry => entry.agentId === 'a5');
  assert.equal(other.button.visible, false);
  host.update({ kind: 'remove', agentId: 'a1' });
  assert.equal(pill.removed, true);
  await stop();
  assert.deepEqual([other.removed, host.released], [true, true]);

  // The menu keeps eight tasks, what waits for the user first; epics and closed tasks stay on the board.
  assert.deepEqual(menuTasks(tasks).map(entry => entry.task.id), ['t-0001', 't-0002', 't-0003', 't-0004', 't-0004.1']);
  const many = Array.from({ length: 11 }, (_, index) => row(`t-${100 + index}`, `Task ${index}`, { ready: true }));
  const full = taskButton({ projectRoot: '/w', tasks: many }, () => {});
  assert.deepEqual([full.label, full.behavior.items.length, full.behavior.items.at(-1).title], ['Tasks · 11', 10, 'All tasks (3 more)']);
  const unread = taskButton(null, () => {});
  assert.deepEqual([unread.label, unread.visible, unread.behavior.items.map(item => item.title)], ['Tasks', true, ['All tasks']]);

  // The tasks the agent's session worked on come first, done ones too, and the label counts them.
  const sessions = { 'provider-s1': ['t-0006', 't-0003', 't-gone'] };
  const mine = taskButton({ projectRoot: '/w', tasks, sessions }, () => {}, ['provider-s1', 'a1']);
  assert.deepEqual([mine.label, mine.title], ['Tasks · 1/2', 'ALP tasks: 1 of 2 done in this session, 5 open']);
  assert.deepEqual(mine.behavior.items.map(item => item.kind === 'item' ? item.title : '---'), [
    'Done · Old', 'In progress · Normalize', '---', 'Approve · Ship the release', 'Review · Add --json', 'Ready · Fix colors', 'Blocked · Docs', '---', 'All tasks',
  ]);
  assert.equal(taskButton({ projectRoot: '/w', tasks, sessions }, () => {}, ['other']).label, 'Tasks · 5');
});

test('a pill finds its session by the agent\'s persistence handle', async () => {
  const { code } = await compileClient('client/task-pills.ts');
  const { addTaskPills } = load(code);
  const tasks = [row('t-0001', 'Ship', { status: 'in_progress' }), row('t-0002', 'Docs', { ready: true })];
  const { client, host } = fakeClient({ '/w/ws1': { projectRoot: '/w', tasks, unreadable: [], sessions: { 'p-1': ['t-0001'] } } });
  const stop = addTaskPills(client);
  await settle();
  host.snapshot([{ id: 'a1', provider: 'alp', workspaceId: 'ws1', cwd: '/w', persistence: { provider: 'alp', sessionId: 'p-1' } }]);
  await settle();
  assert.equal(host.pills[0].button.label, 'Tasks · 0/1');
  await stop();
});

test('the Tasks screen shows the board of the directory it was opened with', async () => {
  const { code } = await compileClient('client/tasks-panel.tsx');
  const { TasksScreen } = load(code);
  const render = params => renderToStaticMarkup(createElement(TasksScreen, { theme, layout: { compact: true, platform: 'ios' }, host: { id: 'h', label: 'h' }, params }));
  assert.match(render({ workspaceId: 'ws1', directory: '/w/ws1', taskId: 't-0003' }), /Loading tasks…/);
  assert.match(render({ workspaceId: 'ws1' }), /needs a workspace/);
});

test('the panel lists tasks the way beads views them: grouped list, detail, board and epics', async () => {
  const { code } = await compileClient('client/tasks-panel.tsx');
  const { TaskBoard, filterTasks, age } = load(code);
  const tasks = [
    row('t-0001', 'Ship the release', { approvals: [{ gate: 'g1', note: 'Approve the changelog?' }], waits: ['g1 human: Approve the changelog?'] }),
    row('t-0002', 'Add --json', { status: 'review', assignee: 'peer', parent: 't-0007', handoff: { outcome: 'complete', summary: 'Added it; npm test passed', agent: 'peer' } }),
    row('t-0003', 'Normalize', { status: 'in_progress', assignee: 'lead', priority: 1 }),
    row('t-0004', 'Fix colors', { ready: true, priority: 3, labels: ['ui'] }),
    row('t-0005', 'Docs', { blockedBy: ['t-0002'], parent: 't-0007' }),
    row('t-0006', 'Old', { status: 'closed', closed: { reason: 'done', summary: 'Merged', at: '2026-10-08T00:00:00Z' } }),
    row('t-0007', 'CLI polish', { type: 'epic', progress: { done: 0, total: 2 } }),
  ];
  const props = { theme, compact: false, directory: '/p', projectRoot: '/p', tasks, unreadable: 1, error: null, onAdd: async () => true, onAction() {}, onRefresh() {} };
  const render = initial => renderToStaticMarkup(createElement(TaskBoard, { ...props, initial }));

  // The list groups what waits for the user first; Open hides closed tasks.
  const html = render({ filter: 'all' });
  const order = ['Waiting for your approval', 'In review', 'In progress', 'Ready', 'Blocked or waiting', 'Epics', 'Closed'].map(title => html.indexOf(`data-label="Hide ${title}"`));
  assert.ok(order.every(position => position >= 0), html);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(html, /Approve the changelog\?<\/text><button[^>]*><text>Approve</);
  assert.match(html, /after t-0002 · in t-0007/);
  assert.match(html, /#ui/);
  assert.match(html, /1 unreadable task file in \/p\/\.alp\/tasks/);
  assert.match(html, /<text>Open <text>6<\/text><\/text>/);
  assert.doesNotMatch(render({}), /Open t-0006/);
  assert.deepEqual(filterTasks(tasks, 'ready', '').map(task => task.id), ['t-0004']);
  assert.deepEqual(filterTasks(tasks, 'all', 'peer json').map(task => task.id), ['t-0002']);
  assert.equal(age('2026-10-07T00:00:00Z', Date.parse('2026-10-09T00:00:00Z')), '2d');

  // A task's detail: its fields, handoff and the action its state allows.
  const detail = render({ selected: 't-0002' });
  assert.match(detail, /Handoff · complete from peer/);
  assert.match(detail, /Added it; npm test passed/);
  assert.match(detail, /Accept and close/);
  assert.match(detail, /data-label="Open t-0005"/, 'Blocks lists the task waiting on it');
  assert.doesNotMatch(detail, /Waiting for your approval/, 'a narrow panel shows the detail alone');
  assert.match(render({ selected: 't-0002', width: 1000 }), /Waiting for your approval[\s\S]*Accept and close/, 'a wide panel shows list and detail side by side');
  assert.match(render({ selected: 't-0006', filter: 'all' }), /Reopen/);

  // The board has a column per state; the epics view shows progress and children.
  const board = render({ view: 'board' });
  for (const title of ['Needs approval', 'Blocked', 'Ready', 'In progress', 'In review']) assert.match(board, new RegExp(`<text>${title}</text>`));
  assert.doesNotMatch(board, /Open t-0007/, 'epics stay off the board');
  const epics = render({ view: 'epics' });
  assert.match(epics, /CLI polish[\s\S]*0\/2[\s\S]*2 tasks[\s\S]*Open t-0002/);

  const empty = renderToStaticMarkup(createElement(TaskBoard, { ...props, compact: true, directory: '/q', projectRoot: null, tasks: [] }));
  assert.match(empty, /\/q is not an ALP project\. Run alp init to start one\./);
  assert.match(renderToStaticMarkup(createElement(TaskBoard, { ...props, directory: null, projectRoot: null, tasks: null })), /needs a workspace/);
});

test('the plugin server lists, adds, closes, reopens and approves tasks as the user', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-panel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  await mkdir(path.join(root, '.alp'), { recursive: true });
  await mkdir(path.join(root, 'src', 'deep'), { recursive: true });
  const handlers = new Map();
  // Only the task handlers matter here: the plugin must not start or watch an alpd.
  const supervise = process.env.ALP_SUPERVISE;
  process.env.ALP_SUPERVISE = '0';
  const dispose = contribute({ registerProvider() {}, handle: (contract, handler) => handlers.set(contract.name, { contract, handler }) });
  if (supervise === undefined) delete process.env.ALP_SUPERVISE; else process.env.ALP_SUPERVISE = supervise;
  t.after(() => dispose());
  assert.deepEqual([...handlers.keys()].sort(), ['alp.library.delete', 'alp.library.duplicate', 'alp.library.get', 'alp.library.list', 'alp.library.rename', 'alp.library.save', 'alp.library.skills', 'alp.library.test', 'alp.settings.language.get', 'alp.settings.language.set', 'alp.tasks.add', 'alp.tasks.change', 'alp.tasks.list']);
  // Like the SDK's callPluginRpc: input and output are checked against the shared contract.
  const call = async (name, input) => {
    const { contract, handler } = handlers.get(name);
    return contract.output.parseAsync(await handler(await contract.input.parseAsync(input), {}));
  };

  const gated = await createTask(root, { title: 'Ship' }, 'user');
  await addGate(root, gated.id, { kind: 'human', note: 'Approve the release?' }, 'main');
  const reviewed = await createTask(root, { title: 'Add --json' }, 'user');
  await startTask(root, reviewed.id, { agent: 'peer', assignment: 'a1' }, 'main');
  await submitTask(root, reviewed.id, { assignment: 'a1', handoff: { outcome: 'complete', summary: 'Done' }, agent: 'peer' }, 'peer');

  // A directory inside the project finds it.
  const listed = await call('alp.tasks.list', { directory: path.join(root, 'src', 'deep') });
  assert.equal(listed.projectRoot, root);
  const byId = new Map(listed.tasks.map(task => [task.id, task]));
  assert.deepEqual(byId.get(gated.id).approvals, [{ gate: 'g1', note: 'Approve the release?' }]);
  assert.equal(byId.get(gated.id).ready, false);
  assert.deepEqual(byId.get(reviewed.id).handoff, { outcome: 'complete', summary: 'Done', agent: 'peer' });

  const { id } = await call('alp.tasks.add', { directory: root, title: 'From the panel', priority: 1 });
  assert.deepEqual([(await getTask(root, id)).createdBy, (await getTask(root, id)).priority], ['user', 1]);
  await assert.rejects(call('alp.tasks.add', { directory: root, title: '  ' }));

  assert.equal((await call('alp.tasks.change', { directory: root, id: gated.id, action: 'approve', gate: 'g1' })).status, 'open');
  assert.equal((await getTask(root, gated.id)).gates[0].resolved.by, 'user');
  assert.equal((await call('alp.tasks.list', { directory: root })).tasks.find(task => task.id === gated.id).ready, true);
  assert.equal((await call('alp.tasks.change', { directory: root, id: reviewed.id, action: 'close', note: 'Looks good' })).status, 'closed');
  assert.equal((await getTask(root, reviewed.id)).closed.summary, 'Looks good');
  assert.equal((await call('alp.tasks.change', { directory: root, id: reviewed.id, action: 'reopen' })).status, 'open');
  await assert.rejects(call('alp.tasks.change', { directory: root, id: 't-ffff', action: 'close' }), /No task t-ffff/);
  // Closing an epic shows the first line of its report.
  const epic = await createTask(root, { title: 'Release', type: 'epic' }, 'user');
  const step = await createTask(root, { title: 'Tag', parent: epic.id }, 'user');
  assert.equal((await call('alp.tasks.change', { directory: root, id: step.id, action: 'close' })).landed, undefined);
  assert.equal((await call('alp.tasks.change', { directory: root, id: epic.id, action: 'close' })).landed, `Landed epic ${epic.id} "Release": 1/1 tasks closed, took 1m.`);

  const outside = await call('alp.tasks.list', { directory });
  assert.deepEqual(outside, { projectRoot: null, tasks: [], unreadable: [] });
  await closeTask(root, id, {}, 'user');
});
