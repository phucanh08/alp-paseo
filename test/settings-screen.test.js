import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as sdk from '@getpaseo/plugin';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const plugin = fileURLToPath(new URL('../plugins/paseo/', import.meta.url));
// The modules Paseo 0.11.1 supplies to plugin client code; anything else fails to load.
const HOST = ['@getpaseo/plugin', '@getpaseo/plugin/client', '@getpaseo/plugin/client/react-native', '@getpaseo/plugin/client/ui', '@tanstack/react-query', 'react', 'react/jsx-runtime', 'react-native', 'zod'];

async function compileClient(entry) {
  const result = await build({
    entryPoints: [path.join(plugin, entry)], bundle: true, format: 'cjs', jsx: 'automatic', write: false, metafile: true,
    platform: 'neutral', target: 'es2020', mainFields: ['module', 'main'], supported: { 'async-await': false }, external: HOST, logLevel: 'silent',
  });
  const externals = new Set(Object.values(result.metafile.inputs).flatMap(input => input.imports.filter(entry => entry.external && !entry.path.startsWith('<')).map(entry => entry.path)));
  const inputs = Object.keys(result.metafile.inputs).filter(input => !input.startsWith('<'));
  return { code: result.outputFiles[0].text, externals: [...externals], inputs };
}

const tag = name => ({ children, accessibilityLabel, onPress: _onPress, style: _style, contentContainerStyle: _c, ...rest }) =>
  createElement(name, { 'data-label': accessibilityLabel, ...(rest.value !== undefined ? { 'data-value': rest.value } : {}), ...(rest.placeholder ? { 'data-placeholder': rest.placeholder } : {}) }, children);
// The settings kit, as plain elements carrying what each row shows.
const kit = {
  SettingsSection: ({ title, info, trailing, children }) => createElement('section', { 'data-title': title }, createElement('h2', null, title), info, trailing, children),
  SettingsRow: ({ label, hint }) => createElement('row', { 'data-label': label }, label, hint ? ` (${hint})` : ''),
  SettingsSwitch: ({ label, value }) => createElement('switch', { 'data-label': label, 'data-value': String(value) }, label),
  SettingsSelect: ({ label, value, options }) => createElement('select', { 'data-label': label, 'data-value': value }, options.map(option => createElement('option', { key: option.value, value: option.value }, option.label))),
  SettingsInput: ({ label, initialValue, error }) => createElement('field', { 'data-label': label, 'data-value': initialValue ?? '' }, label, error ? ` error: ${error}` : ''),
  SettingsAction: ({ label, actionLabel }) => createElement('action', { 'data-label': label }, actionLabel),
};

function load(code, overrides = {}) {
  const modules = {
    '@getpaseo/plugin': sdk, zod: require('zod'), react: require('react'), 'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { View: tag('view'), Text: tag('text'), Pressable: tag('button'), TextInput: tag('input') },
    '@getpaseo/plugin/client/react-native': { ScrollView: tag('scroll'), useToast: () => ({ show() {}, error() {} }) },
    '@getpaseo/plugin/client': { useRpc: () => async () => ({}), useWorkspace: () => null },
    '@getpaseo/plugin/client/ui': kit,
    ...overrides,
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(id => {
    if (!(id in modules)) throw new Error(`Module "${id}" is not available in plugin client code`);
    return modules[id];
  }, module, module.exports);
  return module.exports;
}

const theme = { colors: { surface0: '#fff', surface1: '#eee', surface2: '#ddd', border: '#ccc', foreground: '#000', foregroundMuted: '#666', accent: '#06c', accentForeground: '#fff', statusSuccess: '#0a0', statusWarning: '#a60', statusDanger: '#c00' } };
const actions = { open() {}, create() {}, close() {}, duplicate: async () => true, override: async () => true, useLibrary: async () => true, save: async () => true, remove: async () => true, test: async () => null };
const lists = {
  teams: [{ name: 'pho', source: 'builtin' }, { name: 'cafe', source: 'builtin' }, { name: 'docs', source: 'library', usedBy: ['project settings'] }],
  agents: [{ name: 'main', source: 'library', overrides: 'builtin', description: 'My main' }, { name: 'peer', source: 'builtin' }, { name: 'writer', source: 'library' }, { name: 'supervisor', source: 'builtin' }],
  skills: [{ name: 'style', source: 'library', usedBy: ['agent writer'] }],
  mcp: [],
  hooks: [{ name: 'tests', source: 'library' }],
  providers: [{ name: 'gemini', source: 'library', usedBy: ['scout'] }],
};

test('the client registers the ALP settings screen and the project panel, with only the modules Paseo supplies', async () => {
  const { code, externals, inputs } = await compileClient('index.client.tsx');
  assert.deepEqual(externals.filter(id => !HOST.includes(id)), []);
  assert.deepEqual(inputs.filter(input => !/^(index\.client\.tsx|client\/|shared\/)/.test(path.relative(plugin, path.resolve(input)).split(path.sep).join('/'))), []);
  const screens = [];
  const panels = [];
  const cleanup = load(code).default({
    addSettingsScreen: screen => { screens.push(screen); return () => {}; },
    addWorkspacePanel: panel => { panels.push(panel); return () => {}; },
    addCommandCenterItem: () => () => {},
  });
  assert.equal(typeof cleanup, 'function');
  assert.deepEqual(screens.map(screen => [screen.id, screen.title, screen.icon, typeof screen.Component]), [['alp-settings', 'ALP', 'Bot', 'function']]);
  assert.deepEqual(panels.map(panel => [panel.id, panel.title, panel.context]), [['alp-tasks', 'Tasks', 'workspace'], ['alp-project', 'ALP project', 'workspace']]);
});

test('the library lists each kind with where entries come from, what they override and who uses them', async () => {
  const { code } = await compileClient('client/library.tsx');
  const { LibraryLists } = load(code);
  const html = renderToStaticMarkup(createElement(LibraryLists, { theme, compact: false, scope: 'library', where: { projectRoot: null, library: '/home/u/.alp' }, lists, error: null, actions }));
  const order = ['Teams', 'Agents', 'Skills', 'MCP servers', 'Hooks', 'Providers'].map(title => html.indexOf(`<h2>${title}</h2>`));
  assert.ok(order.every(position => position >= 0), html);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(html, /Your library in \/home\/u\/\.alp: every project uses it/);
  assert.match(html, /<text>main<\/text><text>library · overrides built-in<\/text><text>My main<\/text>/);
  assert.match(html, /<text>style<\/text><text>library<\/text><text>Used by agent writer<\/text>/);
  assert.match(html, /No mcp servers yet\./);
  assert.match(html, /data-label="New team"/);
  assert.match(html, /data-label="Duplicate agent peer"/);
  // The library screen offers no project actions.
  assert.doesNotMatch(html, /Override in this project|Use library/);
});

test('the project panel overrides an entry here, or drops the override to use the library again', async () => {
  const { code } = await compileClient('client/library.tsx');
  const { LibraryLists } = load(code);
  const project = { ...lists, agents: [{ name: 'main', source: 'project', overrides: 'builtin' }, { name: 'peer', source: 'builtin' }, { name: 'scout', source: 'project' }] };
  const html = renderToStaticMarkup(createElement(LibraryLists, { theme, compact: true, scope: 'project', where: { projectRoot: '/p', library: '/home/u/.alp' }, lists: project, error: null, actions }));
  assert.match(html, /What \/p overrides/);
  // Providers live in the library only.
  assert.doesNotMatch(html, /<h2>Providers<\/h2>/);
  assert.match(html, /<text>main<\/text><text>project · overrides built-in<\/text>.*?<text>Use library<\/text>/);
  assert.match(html, /<text>peer<\/text><text>built-in<\/text>.*?<text>Override in this project<\/text>/);
  // A project-only agent has nothing below it to return to.
  assert.doesNotMatch(html.slice(html.indexOf('<text>scout</text>'), html.indexOf('<text>scout</text>') + 400), /Use library/);
  const outside = renderToStaticMarkup(createElement(LibraryLists, { theme, compact: true, scope: 'project', where: { projectRoot: null, library: '/home/u/.alp' }, lists: {}, error: null, actions }));
  assert.match(outside, /not an ALP project\. Run alp init/);
});

test('editors: an agent picks skills, MCP servers and hooks; a team its members, graph, supervisor and house rules', async () => {
  const { code } = await compileClient('client/library.tsx');
  const { EntryEditor, delegationCycle, blank } = load(code);
  const main = { kind: 'agents', name: 'main', source: 'builtin', content: { instructions: '# Main\n', config: { skills: ['style'] } }, revision: null, usedBy: ['team pho'] };
  const agent = renderToStaticMarkup(createElement(EntryEditor, { theme, compact: false, scope: 'library', kind: 'agents', entry: main, lists, actions }));
  assert.match(agent, /Built into ALP\. Saving makes your library&#x27;s own main, which overrides it\. Used by team pho\./);
  assert.match(agent, /<switch data-label="style" data-value="true">/);
  assert.match(agent, /<option value="gemini">gemini \(ACP\)<\/option>/);
  assert.match(agent, /<switch data-label="tests" data-value="false">/);
  assert.match(agent, /No mcp servers to choose from yet/);
  assert.match(agent, /data-label="AGENT.md" data-value="# Main\n"/);
  assert.match(agent, /<text>Save as my own<\/text>/);
  assert.doesNotMatch(agent, />Remove</);

  const team = { kind: 'teams', name: 'docs', source: 'library', overrides: undefined, revision: 'r1', usedBy: [], content: {
    team: { label: 'Docs', main: 'main', members: { main: { model: 'claude:claude-opus-5-5' }, writer: { role: 'peer' } }, delegation: { main: ['writer'] }, supervisor: { agent: 'supervisor', model: 'claude:claude-sonnet-4-6' } },
    houseRules: 'Review every page.\n',
  } };
  const html = renderToStaticMarkup(createElement(EntryEditor, { theme, compact: false, scope: 'library', kind: 'teams', entry: team, lists, actions }));
  assert.match(html, /<select data-label="Main" data-value="main">/);
  assert.match(html, /<switch data-label="writer" data-value="true">/);
  assert.match(html, /<select data-label="writer&#x27;s role" data-value="peer">/);
  assert.match(html, /<switch data-label="peer" data-value="false">/);
  assert.match(html, /<field data-label="main&#x27;s model" data-value="claude:claude-opus-5-5">/);
  assert.match(html, /<switch data-label="main → writer" data-value="true">/);
  // Main is never assigned work.
  assert.doesNotMatch(html, /data-label="writer → main"/);
  assert.match(html, /<select data-label="Supervisor agent" data-value="supervisor">/);
  assert.match(html, /data-label="House rules" data-value="Review every page.\n"/);
  assert.match(html, />Remove</);
  assert.equal(delegationCycle({ main: ['lead'], lead: ['peer'], peer: ['lead'] }), 'lead');
  assert.equal(delegationCycle({ main: ['lead'], lead: ['peer'] }), null);

  const hook = renderToStaticMarkup(createElement(EntryEditor, { theme, compact: false, scope: 'project', kind: 'hooks', entry: { kind: 'hooks', name: 'tests', source: 'library', content: { hook: { event: 'turn.end', command: 'npm test' } }, revision: 'r', usedBy: [] }, lists, actions }));
  assert.match(hook, /From the library\. Saving makes this project&#x27;s own copy\./);
  assert.match(hook, /<select data-label="Event" data-value="turn.end">/);
  // Only events before an action can block it.
  assert.doesNotMatch(hook, /Block the action when it fails/);
  assert.match(hook, /<action data-label="Run once with a sample event">Test<\/action>/);
  const provider = renderToStaticMarkup(createElement(EntryEditor, { theme, compact: false, scope: 'library', kind: 'providers', entry: { kind: 'providers', name: 'gemini', source: 'library', content: { provider: { kind: 'acp', command: 'gemini', args: ['--experimental-acp'], models: [{ id: 'gemini-2.5-pro' }] } }, revision: 'r', usedBy: ['agent scout'] }, lists, actions }));
  assert.match(provider, /<field data-label="Command" data-value="gemini">/);
  assert.match(provider, /<field data-label="Arguments" data-value="--experimental-acp">/);
  assert.match(provider, /<field data-label="Models" data-value="gemini-2.5-pro">/);
  assert.match(provider, /it cannot steer it mid-turn or sandbox its commands/);
  assert.match(provider, /<action data-label="Start the agent and ask what it supports">Test<\/action>/);
  const created = renderToStaticMarkup(createElement(EntryEditor, { theme, compact: false, scope: 'library', kind: 'mcp', entry: null, lists, actions }));
  assert.match(created, /New MCP server/);
  assert.match(created, /<select data-label="Transport" data-value="stdio">/);
  assert.doesNotMatch(created, /Test</);
  assert.deepEqual(blank('teams', 'x').team, { label: 'x', main: 'main', members: { main: {} }, delegation: {}, supervisor: false });
});

test('changing a team keeps it valid: a new main takes the old main\'s place, and removed members leave the graph', async () => {
  const { code } = await compileClient('client/library.tsx');
  const { withMain, withMember, withDelegation } = load(code);
  const team = { label: 'T', main: 'main', members: { main: { model: 'm' }, lead: { role: 'lead' }, peer: { role: 'peer' } }, delegation: { main: ['lead'], lead: ['peer'] }, supervisor: false };
  assert.deepEqual(withMain(team, 'lead'), { label: 'T', main: 'lead', members: { lead: {}, peer: { role: 'peer' } }, delegation: { lead: ['peer'] }, supervisor: false });
  assert.deepEqual(withMain(team, 'architect').members, { architect: {}, lead: { role: 'lead' }, peer: { role: 'peer' } });
  assert.deepEqual(withMain(team, 'architect').delegation, { lead: ['peer'], architect: ['lead'] });
  assert.deepEqual(withMember(team, 'lead', false), { ...team, members: { main: { model: 'm' }, peer: { role: 'peer' } }, delegation: {} });
  assert.deepEqual(withMember(team, 'scout', true).members.scout, { role: 'peer' });
  assert.deepEqual(withDelegation(team, 'main', 'peer', true).delegation, { main: ['lead', 'peer'], lead: ['peer'] });
  assert.deepEqual(withDelegation(team, 'lead', 'peer', false).delegation, { main: ['lead'] });
  // The input is never changed in place.
  assert.deepEqual(team.delegation, { main: ['lead'], lead: ['peer'] });
});
