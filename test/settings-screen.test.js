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
    '@getpaseo/plugin/client/react-native': { ScrollView: tag('scroll'), Icon: tag('icon'), TextInput: tag('input'), useToast: () => ({ show() {}, error() {} }) },
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
const actions = { select() {}, duplicate: async () => true, override: async () => true, useLibrary: async () => true, save: async () => true, remove: async () => true, test: async () => null };
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

/** The markup of one settings section, by its title. */
const section = (html, title) => {
  const start = html.indexOf(`<section data-title="${title}">`);
  assert.ok(start >= 0, `no section ${title}`);
  return html.slice(start, html.indexOf('</section>', start));
};
const where = { projectRoot: null, library: '/home/u/.alp' };

test('the settings screen has an aside of kinds and entries, and lists a kind with where entries come from and who uses them', async () => {
  const { code } = await compileClient('client/library.tsx');
  const { LibraryWorkspace, navGroups } = load(code);
  assert.deepEqual(navGroups('library', lists).map(group => [group.label, group.items.map(item => `${item.label} ${item.count}`)]), [
    ['Organisation', ['Teams 3', 'Agents 4']], ['Capabilities', ['Skills 1', 'MCP servers 0', 'Hooks 1']], ['Runtimes', ['Providers 1']],
  ]);
  // Providers live in the library only.
  assert.ok(!navGroups('project', lists).some(group => group.items.some(item => item.key === 'providers')));
  const render = (kind, extra = {}) => renderToStaticMarkup(createElement(LibraryWorkspace, { theme, compact: false, scope: 'library', where, lists, error: null, selection: { kind }, entry: null, actions, ...extra }));
  const html = render('agents');
  const order = ['Teams', 'Agents', 'Skills', 'MCP servers', 'Hooks', 'Providers'].map(title => html.indexOf(`data-label="${title}"`));
  assert.ok(order.every(position => position >= 0), html);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(html, /ALP library/);
  assert.match(html, /data-label="Agents main"/, 'the aside lists the open kind\'s entries');
  assert.match(html, /<text>Library<\/text><text>\/<\/text><text>Agents<\/text>/);
  assert.match(html, /data-label="All"[\s\S]*data-label="Built-in"[\s\S]*data-label="Library"/);
  assert.match(html, /<text>main<\/text>[\s\S]{0,80}<text>library<\/text>[\s\S]{0,80}<text>overrides built-in<\/text>[\s\S]{0,40}<text>My main<\/text>/);
  assert.match(html, /data-label="New agent"/);
  assert.match(html, /data-label="Duplicate agent peer"/);
  // The library screen offers no project actions.
  assert.doesNotMatch(html, /Override in this project|Use library/);
  assert.match(render('skills'), /<text>Used by agent writer<\/text>/);
  assert.match(render('mcp'), /No mcp servers yet\./);
  assert.match(render('agents', { compact: true }), /data-label="Open navigation"/, 'a narrow screen opens the aside from a menu button');
});

test('the project panel overrides an entry here, or drops the override to use the library again', async () => {
  const { code } = await compileClient('client/library.tsx');
  const { LibraryWorkspace } = load(code);
  const project = { ...lists, agents: [{ name: 'main', source: 'project', overrides: 'builtin' }, { name: 'peer', source: 'builtin' }, { name: 'scout', source: 'project' }] };
  const html = renderToStaticMarkup(createElement(LibraryWorkspace, { theme, compact: true, scope: 'project', where: { projectRoot: '/p', library: '/home/u/.alp' }, lists: project, error: null, selection: { kind: 'agents' }, entry: null, actions }));
  assert.match(html, /What this project overrides/);
  assert.match(html, /<text>Project<\/text><text>\/<\/text><text>Agents<\/text>/);
  assert.doesNotMatch(html, /data-label="Providers"/);
  const rowOf = name => html.slice(html.indexOf(`data-label="Open agent ${name}"`), html.indexOf(`data-label="Duplicate agent ${name}"`));
  assert.match(rowOf('main'), /<text>project<\/text>[\s\S]*<text>overrides built-in<\/text>[\s\S]*<text>Use library<\/text>/);
  assert.match(rowOf('peer'), /<text>built-in<\/text>[\s\S]*<text>Override in this project<\/text>/);
  // A project-only agent has nothing below it to return to.
  assert.doesNotMatch(rowOf('scout'), /Use library/);
  const outside = renderToStaticMarkup(createElement(LibraryWorkspace, { theme, compact: true, scope: 'project', where: { projectRoot: null, library: '/home/u/.alp' }, lists: {}, error: null, selection: { kind: 'teams' }, entry: null, actions }));
  assert.match(outside, /not an ALP project\. Run alp init/);
});

test('editors: an agent picks skills, MCP servers and hooks; a team its members, graph, supervisor and house rules; a tab at a time', async () => {
  const { code } = await compileClient('client/library.tsx');
  const { EntryEditor, LibraryWorkspace, delegationCycle, blank, entryTabs } = load(code);
  const layout = { title: 'ALP library', groups: [], onSelect() {} };
  const editor = (kind, entry, tab, scope = 'library') => renderToStaticMarkup(createElement(EntryEditor, { theme, compact: false, scope, kind, entry, lists, actions, layout, initialTab: tab }));
  const main = { kind: 'agents', name: 'main', source: 'builtin', content: { instructions: '# Main\n', config: { skills: ['style'] } }, revision: null, usedBy: ['team pho'] };
  const general = editor('agents', main);
  assert.match(general, /Built into ALP\. Saving makes your library&#x27;s own main, which overrides it\./);
  assert.match(general, /Used by team pho\./);
  assert.match(general, /<text>Agents<\/text><text>\/<\/text><text>main<\/text>/);
  assert.match(general, /<option value="gemini">gemini \(ACP\)<\/option>/);
  assert.match(general, /<text>Save as my own<\/text>/);
  assert.match(general, /No changes/);
  assert.doesNotMatch(general, />Remove</);
  assert.doesNotMatch(general, /AGENT\.md/, 'one tab at a time');
  assert.match(editor('agents', main, 'instructions'), /data-label="AGENT.md" data-value="# Main\n"/);
  const capabilities = editor('agents', main, 'capabilities');
  assert.match(capabilities, /<switch data-label="style" data-value="true">/);
  assert.match(capabilities, /<switch data-label="tests" data-value="false">/);
  assert.match(capabilities, /No mcp servers to choose from yet/);
  // The workspace opens the selected entry's editor.
  assert.match(renderToStaticMarkup(createElement(LibraryWorkspace, { theme, compact: false, scope: 'library', where, lists, error: null, selection: { kind: 'agents', name: 'main' }, entry: main, actions })), /Save as my own/);

  const team = { kind: 'teams', name: 'docs', source: 'library', overrides: undefined, revision: 'r1', usedBy: [], content: {
    team: { label: 'Docs', main: 'main', members: { main: { model: 'claude:claude-opus-5-5' }, writer: { role: 'peer' } }, delegation: { main: ['writer'] }, supervisor: { agent: 'supervisor', model: 'claude:claude-sonnet-4-6' } },
    houseRules: 'Review every page.\n',
  } };
  assert.deepEqual(entryTabs('teams', true).map(tab => tab.label), ['General', 'Members', 'Delegation', 'Supervisor', 'House rules']);
  assert.match(editor('teams', team), /<select data-label="Main" data-value="main">/);
  const members = editor('teams', team, 'members');
  assert.match(section(members, 'main · main'), /<field data-label="Model" data-value="claude:claude-opus-5-5">/);
  assert.match(section(members, 'writer'), /<switch data-label="In this team" data-value="true">[\s\S]*<select data-label="Role" data-value="peer">/);
  assert.match(section(members, 'peer'), /<switch data-label="In this team" data-value="false">/);
  assert.doesNotMatch(section(members, 'peer'), /Role/);
  const delegation = editor('teams', team, 'delegation');
  assert.match(section(delegation, 'main may delegate to'), /<switch data-label="writer" data-value="true">/);
  // Main is never assigned work.
  assert.doesNotMatch(section(delegation, 'writer may delegate to'), /data-label="main"/);
  assert.match(editor('teams', team, 'supervisor'), /<select data-label="Supervisor agent" data-value="supervisor">/);
  assert.match(editor('teams', team, 'rules'), /data-label="House rules" data-value="Review every page.\n"/);
  assert.match(editor('teams', team), />Remove</);
  assert.equal(delegationCycle({ main: ['lead'], lead: ['peer'], peer: ['lead'] }), 'lead');
  assert.equal(delegationCycle({ main: ['lead'], lead: ['peer'] }), null);

  const hookEntry = { kind: 'hooks', name: 'tests', source: 'library', content: { hook: { event: 'turn.end', command: 'npm test' } }, revision: 'r', usedBy: [] };
  const hook = editor('hooks', hookEntry, undefined, 'project');
  assert.match(hook, /From the library\. Saving makes this project&#x27;s own copy\./);
  assert.match(hook, /<select data-label="Event" data-value="turn.end">/);
  // Only events before an action can block it.
  assert.doesNotMatch(hook, /Block the action when it fails/);
  assert.match(editor('hooks', hookEntry, 'test', 'project'), /<action data-label="Run once with a sample event">Test<\/action>/);
  const providerEntry = { kind: 'providers', name: 'gemini', source: 'library', content: { provider: { kind: 'acp', command: 'gemini', args: ['--experimental-acp'], models: [{ id: 'gemini-2.5-pro' }] } }, revision: 'r', usedBy: ['agent scout'] };
  const provider = editor('providers', providerEntry);
  assert.match(provider, /<field data-label="Command" data-value="gemini">/);
  assert.match(provider, /<field data-label="Arguments" data-value="--experimental-acp">/);
  assert.match(provider, /<field data-label="Models" data-value="gemini-2.5-pro">/);
  assert.match(provider, /it cannot steer it mid-turn or sandbox its commands/);
  assert.match(editor('providers', providerEntry, 'test'), /<action data-label="Start the agent and ask what it supports">Test<\/action>/);
  const created = editor('mcp', null);
  assert.match(created, /New MCP server/);
  assert.match(created, /<field data-label="Name" data-value="">/);
  assert.match(created, /Name the entry first/);
  assert.match(created, /<select data-label="Transport" data-value="stdio">/);
  assert.doesNotMatch(created, /data-label="Test"/, 'a new entry has nothing saved to test');
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
