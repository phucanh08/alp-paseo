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

test('the client entry bundles with only the modules Paseo supplies and registers the Tasks panel', async () => {
  const { code, externals, inputs } = await compileClient('index.client.tsx');
  assert.deepEqual(externals.filter(id => !HOST.includes(id)), []);
  // Paseo refuses client code outside client/, shared/ and the entry.
  assert.deepEqual(inputs.filter(input => !/^(index\.client\.tsx|client\/|shared\/)/.test(path.relative(plugin, path.resolve(input)).split(path.sep).join('/'))), []);
  const panels = [];
  const commands = [];
  const cleanup = load(code).default({ addWorkspacePanel: panel => { panels.push(panel); return () => {}; }, addCommandCenterItem: item => { commands.push(item); return () => {}; }, addSettingsScreen: () => () => {} });
  assert.equal(typeof cleanup, 'function');
  assert.deepEqual(panels.filter(panel => panel.id === 'alp-tasks').map(panel => [panel.id, panel.title, panel.icon, panel.context, typeof panel.Component]), [['alp-tasks', 'Tasks', 'ListTodo', 'workspace', 'function']]);
  const opened = [];
  commands[0].onSelect({ openPanel: id => opened.push(id) });
  assert.deepEqual([commands[0].context, opened], ['workspace', ['alp-tasks']]);
});

test('the panel lists tasks the way beads views them: grouped list, detail, board and epics', async () => {
  const { code } = await compileClient('client/tasks-panel.tsx');
  const { TaskBoard, filterTasks, age } = load(code);
  const row = (id, title, extra = {}) => ({ id, title, type: 'task', priority: 2, status: 'open', ready: false, updatedAt: '2026-10-09T00:00:00Z', ...extra });
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
  assert.deepEqual([...handlers.keys()].sort(), ['alp.library.delete', 'alp.library.duplicate', 'alp.library.get', 'alp.library.list', 'alp.library.rename', 'alp.library.save', 'alp.library.test', 'alp.tasks.add', 'alp.tasks.change', 'alp.tasks.list']);
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
