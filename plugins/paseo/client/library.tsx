import type { PluginTheme } from '@getpaseo/plugin';
import { type PluginSurfaceProps, type PluginWorkspacePanelProps, useRpc, useWorkspace } from '@getpaseo/plugin/client';
import { useToast } from '@getpaseo/plugin/client/react-native';
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from '@getpaseo/plugin/client/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { libraryDelete, libraryDuplicate, libraryGet, libraryList, librarySave, librarySkills, libraryTest, type EntryRow } from '../shared/library';
import { Button, Pill, SideNavLayout, type NavGroup, type Tab } from './side-nav';

/**
 * The ALP settings screen and the "ALP project" panel (plans/reference/ALPD.md §44, §47).
 * The screen edits the user's library in ~/.alp; the panel shows what the workspace's
 * project overrides and edits those overrides. Built-ins are read-only: saving one
 * makes the library's (or the project's) entry of that name.
 *
 * Both are a two-column layout: the aside lists groups, kinds and their entries; the
 * working area shows a kind's entries, or one entry with a tab per part of it.
 */

export type Kind = 'teams' | 'agents' | 'skills' | 'mcp' | 'hooks' | 'providers';
export type Scope = 'library' | 'project';
export const KINDS: Array<{ kind: Kind; title: string; one: string; icon: string; group: string }> = [
  { kind: 'teams', title: 'Teams', one: 'team', icon: 'Users', group: 'Organisation' },
  { kind: 'agents', title: 'Agents', one: 'agent', icon: 'Bot', group: 'Organisation' },
  { kind: 'skills', title: 'Skills', one: 'skill', icon: 'BookOpen', group: 'Capabilities' },
  { kind: 'mcp', title: 'MCP servers', one: 'MCP server', icon: 'Plug', group: 'Capabilities' },
  { kind: 'hooks', title: 'Hooks', one: 'hook', icon: 'Webhook', group: 'Capabilities' },
  // ACP agents (ALPD §46): in the library only, so the project panel leaves them out.
  { kind: 'providers', title: 'Providers', one: 'provider', icon: 'Cpu', group: 'Runtimes' },
];
const shownIn = (scope: Scope) => KINDS.filter(item => scope === 'library' || item.kind !== 'providers');
const kindOf = (kind: Kind) => KINDS.find(item => item.kind === kind)!;
const HOOK_EVENTS = ['session.start', 'turn.end', 'assignment.start', 'assignment.end', 'handoff', 'task.close', 'merge'];
const BLOCKING_EVENTS = ['handoff', 'task.close', 'merge'];
const ROLES = ['lead', 'peer', 'advisor', 'reviewer'];
const MODES = ['', 'read-only', 'workspace-write', 'full-access'];
const NAME = /^[\w.-]+$/;
/** Entries are JSON data; React Native's engine may lack structuredClone. */
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const sourceLabel = (source: string) => source === 'builtin' ? 'built-in' : source;
const sourceTone = (source: string) => source === 'project' ? 'warning' as const : source === 'library' ? 'accent' as const : 'muted' as const;

type Lists = Partial<Record<Kind, EntryRow[]>>;
type Content = Record<string, any>;
/** What the working area shows: a kind's entries, one entry, or a new entry. */
export type Selection = { kind: Kind; name?: string; creating?: boolean };
/** librarySkills: for agents, the skills the library gives it by name (role-skills.json). */
type Entry = { kind: Kind; name: string; source: string; overrides?: string; content: Content; revision: string | null; usedBy: string[]; librarySkills?: string[] };
type Where = { projectRoot: string | null; library: string } | null;

/** The settings screen: the library, with the built-ins it starts from. */
export function LibrarySettings({ theme, layout }: PluginSurfaceProps) {
  return <LibraryManager theme={theme} compact={layout.compact} scope="library" />;
}

/** The workspace panel: the project's overrides of the library and built-ins. */
export function ProjectLibraryPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, workspace => workspace.directory || workspace.projectRootPath);
  if (!directory) return <View style={{ padding: 16 }}><Text style={{ color: theme.colors.foregroundMuted }}>This panel needs a workspace.</Text></View>;
  return <LibraryManager theme={theme} compact={layout.compact} scope="project" directory={directory} />;
}

function LibraryManager({ theme, compact, scope, directory }: { theme: PluginTheme; compact: boolean; scope: Scope; directory?: string }) {
  const list = useRpc(libraryList);
  const get = useRpc(libraryGet);
  const save = useRpc(librarySave);
  const remove = useRpc(libraryDelete);
  const duplicate = useRpc(libraryDuplicate);
  const probe = useRpc(libraryTest);
  const give = useRpc(librarySkills);
  const toast = useToast();
  const [lists, setLists] = useState<Lists>({});
  const [where, setWhere] = useState<Where>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: 'teams' });
  const [entry, setEntry] = useState<Entry | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(value => value + 1), []);
  const base = directory ? { directory } : {};

  useEffect(() => {
    let live = true;
    Promise.all(KINDS.map(({ kind }) => list({ ...base, kind }).then(result => [kind, result] as const)))
      .then(results => {
        if (!live) return;
        setLists(Object.fromEntries(results.map(([kind, result]) => [kind, result.entries])));
        setWhere({ projectRoot: results[0][1].projectRoot, library: results[0][1].library });
        setError(null);
      })
      .catch(cause => { if (live) setError(message(cause)); });
    return () => { live = false; };
  }, [list, directory, tick]);

  useEffect(() => {
    if (!selection.name || selection.creating) { setEntry(null); return; }
    let live = true;
    get({ ...base, kind: selection.kind, name: selection.name })
      .then(result => { if (live) setEntry(result as Entry); })
      .catch(cause => { if (live) { toast.error(message(cause)); setSelection({ kind: selection.kind }); } });
    return () => { live = false; };
    // After a save the entry is read again, so the next save carries its new revision.
  }, [selection, get, directory, tick]);

  const run = useCallback(async (work: () => Promise<unknown>, done: string) => {
    try { await work(); toast.show(done, { variant: 'success' }); refresh(); return true; }
    catch (cause) { toast.error(message(cause)); return false; }
  }, [toast, refresh]);

  const actions: Actions = {
    select: next => setSelection(next),
    duplicate: (kind, from, to) => run(() => duplicate({ ...base, kind, from, to, scope }), `Copied ${from} to ${to}`),
    // In the project panel: copy what applies into .alp/, or drop the project's copy.
    override: (kind, name) => run(() => duplicate({ ...base, kind, from: name, to: name, scope: 'project' }), `${name} is now overridden in this project`),
    useLibrary: (kind, name) => run(() => remove({ ...base, kind, name, scope: 'project' }), `${name} follows the library again`),
    save: async (kind, name, content, revision, creating) => {
      const saved = await run(() => save({ ...base, kind, name, scope, content, revision }), `Saved ${name}`);
      if (saved && creating) setSelection({ kind, name });
      return saved;
    },
    giveSkills: (agent, skills) => run(() => give({ agent, skills }), `Saved the skills of ${agent}`),
    remove: async (kind, name, revision) => {
      const removed = await run(() => remove({ ...base, kind, name, scope, ...(revision ? { revision } : {}) }), `Removed ${name}`);
      if (removed) setSelection({ kind });
      return removed;
    },
    test: async (kind, name) => {
      try { return await probe({ ...base, kind: kind as 'mcp' | 'hooks' | 'providers', name }); }
      catch (cause) { toast.error(message(cause)); return null; }
    },
  };
  // An entry is shown once it is read; until then the kind's list stays.
  const shown = selection.name && !selection.creating && entry?.name !== selection.name ? { kind: selection.kind } : selection;
  return <LibraryWorkspace theme={theme} compact={compact} scope={scope} where={where} lists={lists} error={error} selection={shown} entry={shown.name ? entry : null} actions={actions} />;
}

export type Actions = {
  select(selection: Selection): void;
  duplicate(kind: Kind, from: string, to: string): Promise<boolean>;
  override(kind: Kind, name: string): Promise<boolean>;
  useLibrary(kind: Kind, name: string): Promise<boolean>;
  save(kind: Kind, name: string, content: Content, revision: string | null, creating: boolean): Promise<boolean>;
  /** Sets the skills the library gives an agent by name. */
  giveSkills(agent: string, skills: string[]): Promise<boolean>;
  remove(kind: Kind, name: string, revision?: string | null): Promise<boolean>;
  test(kind: Kind, name: string): Promise<Record<string, any> | null>;
};

type WorkspaceProps = {
  theme: PluginTheme; compact: boolean; scope: Scope; where: Where; lists: Lists; error: string | null;
  selection: Selection; entry: Entry | null; actions: Actions; initialCollapsed?: boolean;
};

/** The aside's groups: Organisation, Capabilities and Runtimes, each kind with its entries. */
export function navGroups(scope: Scope, lists: Lists): NavGroup[] {
  const groups: NavGroup[] = [];
  for (const item of shownIn(scope)) {
    let group = groups.find(candidate => candidate.label === item.group);
    if (!group) groups.push(group = { key: item.group, label: item.group, items: [] });
    const rows = lists[item.kind];
    group.items.push({
      key: item.kind, label: item.title, icon: item.icon, ...(rows ? { count: rows.length } : {}),
      children: (rows ?? []).map(row => ({ key: row.name, label: row.name, tone: sourceTone(row.source) })),
    });
  }
  return groups;
}

/** The whole screen from data alone: aside, header with the secondary menu, and the working area. */
export function LibraryWorkspace({ theme, compact, scope, where, lists, error, selection, entry, actions, initialCollapsed }: WorkspaceProps) {
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const title = scope === 'library' ? 'ALP library' : 'ALP project';
  const subtitle = scope === 'library' ? where?.library : where?.projectRoot ?? undefined;
  const groups = navGroups(scope, lists);
  const onSelect = (kind: string, name?: string) => actions.select({ kind: kind as Kind, ...(name ? { name } : {}) });
  if (scope === 'project' && where && !where.projectRoot) {
    return <View style={styles.screen}><Text style={styles.muted}>This workspace is not an ALP project. Run alp init to start one.</Text></View>;
  }
  const kind = kindOf(selection.kind);
  if (selection.name || selection.creating) {
    return <EntryEditor key={`${selection.kind}/${selection.name ?? 'new'}/${entry?.revision ?? 'new'}/${(entry?.librarySkills ?? []).join(',')}`} theme={theme} compact={compact} scope={scope} kind={selection.kind} entry={selection.creating ? null : entry}
      lists={lists} actions={actions} layout={{ title, subtitle, groups, onSelect, initialCollapsed }} />;
  }
  return <KindOverview theme={theme} compact={compact} scope={scope} kind={kind.kind} rows={lists[kind.kind]} error={error} where={where} actions={actions} layout={{ title, subtitle, groups, onSelect, initialCollapsed }} styles={styles} />;
}

type Frame = { title: string; subtitle?: string; groups: NavGroup[]; onSelect(item: string, child?: string): void; initialCollapsed?: boolean };

const SOURCES = [{ key: 'all', label: 'All' }, { key: 'builtin', label: 'Built-in' }, { key: 'library', label: 'Library' }, { key: 'project', label: 'Project' }];

/** A kind's entries, filtered by where they come from, with New, Duplicate and the project's override actions. */
export function KindOverview({ theme, compact, scope, kind, rows, error, where, actions, layout, styles }: { theme: PluginTheme; compact: boolean; scope: Scope; kind: Kind; rows?: EntryRow[]; error: string | null; where: Where; actions: Actions; layout: Frame; styles: Styles }) {
  const { title, one } = kindOf(kind);
  const [filter, setFilter] = useState('all');
  const [copying, setCopying] = useState<string | null>(null);
  const [copyName, setCopyName] = useState('');
  const tabs: Tab[] = SOURCES.map(source => ({ ...source, count: (rows ?? []).filter(row => source.key === 'all' || row.source === source.key).length }))
    .filter(tab => tab.key === 'all' || tab.count);
  const shown = (rows ?? []).filter(row => filter === 'all' || row.source === filter);
  const intro = kind === 'providers' ? 'Agents that speak the Agent Client Protocol. They live in your library only.'
    : scope === 'library' ? 'Every project uses your library. Built-ins follow ALP updates; saving one makes your own copy of that name.'
    : 'What this project overrides. Override an entry to change it here only; Use library drops the project\'s copy.';
  return (
    <SideNavLayout theme={theme} compact={compact} title={layout.title} subtitle={layout.subtitle} groups={layout.groups} active={{ item: kind }} onSelect={layout.onSelect} initialCollapsed={layout.initialCollapsed}
      breadcrumb={[scope === 'library' ? 'Library' : 'Project', title]} tabs={tabs} tab={filter} onTab={setFilter}
      actions={<Button theme={theme} kind="primary" icon="Plus" label={`New ${one}`} onPress={() => actions.select({ kind, creating: true })} />}>
      <Text style={styles.muted}>{intro}</Text>
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      {!rows ? <Text style={styles.muted}>Loading…</Text> : null}
      {rows && !shown.length ? <View style={styles.empty}><Text style={styles.muted}>No {title.toLowerCase()} {filter === 'all' ? 'yet' : `from the ${sourceLabel(filter)}`}.</Text></View> : null}
      {shown.length ? (
        <View style={styles.table}>
          {shown.map((row, index) => (
            <View key={row.name} style={[styles.tableRow, index ? styles.tableRowRule : null]}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Open ${one} ${row.name}`} onPress={() => actions.select({ kind, name: row.name })} style={styles.rowMain}>
                <View style={styles.rowTitle}>
                  <Text style={styles.name}>{row.name}</Text>
                  <Pill theme={theme} label={sourceLabel(row.source)} tone={sourceTone(row.source)} />
                  {row.overrides ? <Pill theme={theme} label={`overrides ${sourceLabel(row.overrides)}`} /> : null}
                </View>
                {row.description ? <Text style={styles.muted} numberOfLines={2}>{row.description}</Text> : null}
                {row.usedBy?.length ? <Text style={styles.small} numberOfLines={1}>Used by {row.usedBy.join(', ')}</Text> : null}
              </Pressable>
              <View style={[styles.rowActions, compact ? styles.rowActionsCompact : null]}>
                {scope === 'project' && row.source === 'project' && row.overrides ? <Button theme={theme} label="Use library" onPress={() => actions.useLibrary(kind, row.name)} /> : null}
                {scope === 'project' && row.source !== 'project' ? <Button theme={theme} label="Override in this project" onPress={() => actions.override(kind, row.name)} /> : null}
                <Button theme={theme} icon="Copy" label="Duplicate" accessibilityLabel={`Duplicate ${one} ${row.name}`} onPress={() => { setCopying(row.name); setCopyName(`${row.name}-copy`); }} />
              </View>
              {copying === row.name ? (
                <View style={styles.copyRow}>
                  <TextInput style={styles.input} value={copyName} onChangeText={setCopyName} accessibilityLabel="Name of the copy" placeholder="Name of the copy" placeholderTextColor={theme.colors.foregroundMuted} />
                  <Button theme={theme} kind="primary" label="Copy" onPress={async () => { if (NAME.test(copyName) && await actions.duplicate(kind, row.name, copyName)) setCopying(null); }} />
                  <Button theme={theme} label="Cancel" onPress={() => setCopying(null)} />
                </View>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </SideNavLayout>
  );
}

/** A blank entry of a kind, as New starts it. */
export function blank(kind: Kind, name = 'new'): Content {
  if (kind === 'agents') return { instructions: `# ${name}\n\nDescribe what this agent does, and how.\n`, config: {} };
  if (kind === 'skills') return { body: `---\nname: ${name}\ndescription: When to use this skill.\n---\n\n# ${name}\n\nSteps and checks.\n` };
  if (kind === 'mcp') return { server: { command: '' } };
  if (kind === 'hooks') return { hook: { event: 'handoff', command: '', blocking: false } };
  if (kind === 'providers') return { provider: { kind: 'acp', label: name, command: '' } };
  return { team: { label: name, main: 'main', members: { main: {} }, delegation: {}, supervisor: false }, houseRules: '' };
}

/** The secondary menu of an entry: one tab per part of it. Test needs a saved entry. */
export function entryTabs(kind: Kind, saved: boolean): Tab[] {
  const tabs: Record<Kind, Array<[string, string]>> = {
    agents: [['general', 'General'], ['instructions', 'Instructions'], ['capabilities', 'Skills, MCP & hooks']],
    teams: [['general', 'General'], ['members', 'Members'], ['delegation', 'Delegation'], ['supervisor', 'Supervisor'], ['rules', 'House rules']],
    skills: [['body', 'SKILL.md']],
    mcp: [['server', 'Server'], ['test', 'Test']],
    hooks: [['hook', 'Hook'], ['test', 'Test']],
    providers: [['agent', 'ACP agent'], ['test', 'Test']],
  };
  return tabs[kind].filter(([key]) => key !== 'test' || saved).map(([key, label]) => ({ key, label }));
}

/** Edits one entry, a tab at a time; built-ins and entries of lower layers are saved as this scope's own. */
export function EntryEditor({ theme, compact, scope, kind, entry, lists, actions, layout, initialTab }: { theme: PluginTheme; compact: boolean; scope: Scope; kind: Kind; entry: Entry | null; lists: Lists; actions: Actions; layout: Frame; initialTab?: string }) {
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const { one, title } = kindOf(kind);
  const tabs = entryTabs(kind, !!entry);
  const [tab, setTab] = useState(initialTab && tabs.some(candidate => candidate.key === initialTab) ? initialTab : tabs[0].key);
  const [name, setName] = useState(entry?.name ?? '');
  const original = useMemo(() => clone(entry?.content ?? blank(kind)), [entry, kind]);
  const [content, setContent] = useState<Content>(() => clone(original));
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const own = entry?.source === scope;
  const update = (change: (draft: Content) => void) => setContent(current => { const draft = clone(current); change(draft); return draft; });
  const valid = NAME.test(name);
  const changed = !entry || JSON.stringify(content) !== JSON.stringify(original);
  // In the library, an agent's skills live in role-skills.json, so a built-in's change without a copy.
  const givenOriginal = useMemo(() => entry?.librarySkills ?? [], [entry]);
  const [given, setGiven] = useState<string[]>(givenOriginal);
  const givesSkills = kind === 'agents' && scope === 'library';
  const givenChanged = givesSkills && [...given].sort().join() !== [...givenOriginal].sort().join();
  const dirty = changed || givenChanged;
  const onSave = async () => {
    if (!valid) return;
    if (changed && !(await actions.save(kind, name, content, own ? entry!.revision : null, !entry))) return;
    if (givenChanged) await actions.giveSkills(name, given);
  };
  const note = entry
    ? entry.source === 'builtin' ? `Built into ALP. Saving makes ${scope === 'library' ? 'your library\'s' : 'this project\'s'} own ${entry.name}, which overrides it.`
      : own ? `In ${scope === 'library' ? 'your library' : 'this project'}${entry.overrides ? `; overrides the ${sourceLabel(entry.overrides)} one` : ''}.`
      : `From the ${sourceLabel(entry.source)}. Saving makes this project's own copy.`
    : null;
  const form: FormProps = { content, update, lists, styles, theme };
  return (
    <SideNavLayout theme={theme} compact={compact} title={layout.title} subtitle={layout.subtitle} groups={layout.groups} active={{ item: kind, ...(entry ? { child: entry.name } : {}) }} onSelect={layout.onSelect} initialCollapsed={layout.initialCollapsed}
      breadcrumb={[title, entry ? entry.name : `New ${one}`]}
      badges={entry ? <><Pill theme={theme} label={sourceLabel(entry.source)} tone={sourceTone(entry.source)} />{entry.overrides ? <Pill theme={theme} label={`overrides ${sourceLabel(entry.overrides)}`} /> : null}</> : null}
      actions={<Button theme={theme} icon="ArrowLeft" label={`All ${title.toLowerCase()}`} onPress={() => actions.select({ kind })} />}
      tabs={tabs} tab={tab} onTab={setTab}
      footer={(
        <>
          <Button theme={theme} kind="primary" label={entry && entry.source === 'builtin' && (changed || !givenChanged) ? 'Save as my own' : 'Save'} disabled={!valid || !dirty} onPress={() => { void onSave(); }} />
          <Text style={styles.small}>{!valid ? 'Name the entry first' : dirty ? 'Unsaved changes' : own ? 'Saved' : 'No changes'}</Text>
          <View style={{ flex: 1 }} />
          {entry && own ? <Button theme={theme} kind="danger" label={entry.overrides ? `Remove (the ${sourceLabel(entry.overrides)} one applies again)` : 'Remove'} onPress={() => actions.remove(kind, entry.name, entry.revision)} /> : null}
        </>
      )}>
      {note || entry?.usedBy.length ? (
        <View style={styles.banner}>
          {note ? <Text style={styles.bannerText}>{note}</Text> : null}
          {entry?.usedBy.length ? <Text style={styles.small}>Used by {entry.usedBy.join(', ')}.</Text> : null}
        </View>
      ) : null}
      {!entry && tab === tabs[0].key ? <SettingsSection title="Name"><SettingsInput label="Name" hint="Letters, digits, '.', '_' or '-'" error={name && !valid ? 'Not a valid name' : null} initialValue={name} onChangeText={setName} /></SettingsSection> : null}
      {kind === 'agents' ? <AgentForm {...form} tab={tab} given={entry?.librarySkills ?? []} {...(givesSkills ? { draftGiven: given, setGiven } : {})} /> : null}
      {kind === 'teams' ? <TeamForm {...form} tab={tab} /> : null}
      {kind === 'skills' ? <Multiline value={content.body ?? ''} onChange={text => update(draft => { draft.body = text; })} styles={styles} theme={theme} label="SKILL.md" tall /> : null}
      {kind === 'mcp' && tab === 'server' ? <McpForm content={content} update={update} /> : null}
      {kind === 'hooks' && tab === 'hook' ? <HookForm content={content} update={update} lists={lists} /> : null}
      {kind === 'providers' && tab === 'agent' ? <ProviderForm content={content} update={update} /> : null}
      {tab === 'test' && entry ? (
        <SettingsSection title="Test">
          <SettingsAction label={kind === 'mcp' ? 'Start the server and list its tools' : kind === 'providers' ? 'Start the agent and ask what it supports' : 'Run once with a sample event'} hint="The test runs what is saved." actionLabel="Test" onPress={async () => setResult(await actions.test(kind, entry.name))} />
          {result ? <TestResult kind={kind} result={result} styles={styles} /> : null}
        </SettingsSection>
      ) : null}
    </SideNavLayout>
  );
}

type FormProps = { content: Content; update(change: (draft: Content) => void): void; lists: Lists; styles?: Styles; theme?: PluginTheme; tab?: string };
const names = (lists: Lists, kind: Kind) => (lists[kind] ?? []).map(row => row.name);
const toggle = (list: string[] | undefined, name: string, on: boolean) => { const set = new Set(list ?? []); if (on) set.add(name); else set.delete(name); return [...set]; };
const setOrDelete = (target: Content, key: string, value: unknown) => { if (value === '' || value === undefined || (Array.isArray(value) && !value.length)) delete target[key]; else target[key] = value; };

/** An agent, by tab: what it runs on, its instructions, and the skills, MCP servers and hooks it uses. Without a tab, all of it. */
/**
 * given: the skills the library gives the agent by name. With setGiven (the library scope) the
 * skill switches edit that list; without (a project), those skills show on and locked.
 */
export function AgentForm({ content, update, lists, styles, theme, tab, given = [], draftGiven, setGiven }: FormProps & { given?: string[]; draftGiven?: string[]; setGiven?(skills: string[]): void }) {
  const config: Content = content.config ?? {};
  const field = (key: string) => (text: string) => update(draft => { draft.config ??= {}; setOrDelete(draft.config, key, text.trim()); });
  const show = (key: string) => !tab || tab === key;
  return (
    <>
      {show('general') ? (
        <SettingsSection title="Agent">
          <SettingsInput label="Description" initialValue={config.description ?? ''} onChangeText={field('description')} />
          <SettingsSelect label="Provider" hint="The team or project settings may choose another" value={config.provider ?? ''} options={[{ label: 'Default', value: '' }, { label: 'Codex', value: 'codex' }, { label: 'Claude Code', value: 'claude' }, ...names(lists, 'providers').map(provider => ({ label: `${provider} (ACP)`, value: provider }))]} onValueChange={field('provider')} />
          <SettingsInput label="Model" hint="Such as claude:claude-sonnet-5-5, codex:gpt-6-sol or acp:gemini" initialValue={config.model ?? ''} onChangeText={field('model')} />
          <SettingsInput label="Thinking" hint="Effort, such as low, medium or high" initialValue={config.thinking ?? ''} onChangeText={field('thinking')} />
          <SettingsSelect label="Default mode" value={config.mode ?? ''} options={MODES.map(mode => ({ label: mode || 'As its requester chooses', value: mode }))} onValueChange={field('mode')} />
        </SettingsSection>
      ) : null}
      {show('instructions') ? (
        <Multiline value={content.instructions ?? ''} onChange={text => update(draft => { draft.instructions = text; })} styles={styles!} theme={theme!} label="AGENT.md" tall />
      ) : null}
      {show('capabilities') ? (['skills', 'mcp', 'hooks'] as const).map(kind => (
        <SettingsSection key={kind} title={kindOf(kind).title}>
          {!names(lists, kind).length ? <SettingsRow label={`No ${kindOf(kind).title.toLowerCase()} to choose from yet`} /> : null}
          {names(lists, kind).map(name => {
            const own = (config[kind] ?? []).includes(name);
            const configToggle = (on: boolean) => update(draft => { draft.config ??= {}; setOrDelete(draft.config, kind, toggle(draft.config[kind], name, on)); });
            if (kind !== 'skills') return <SettingsSwitch key={name} label={name} value={own} onValueChange={configToggle} />;
            if (setGiven) {
              // The library's list: on adds it there; off takes it from the list and from agent.json.
              const library = (draftGiven ?? given).includes(name);
              return <SettingsSwitch key={name} label={name} hint={given.includes(name) ? 'Default for this agent' : undefined} value={library || own}
                onValueChange={on => { setGiven(toggle(draftGiven ?? given, name, on)); if (!on && own) configToggle(false); }} />;
            }
            if (given.includes(name)) return <SettingsSwitch key={name} label={name} hint="Given by your library; change it in Settings → ALP" value disabled onValueChange={() => {}} />;
            return <SettingsSwitch key={name} label={name} value={own} onValueChange={configToggle} />;
          })}
        </SettingsSection>
      )) : null}
    </>
  );
}

/** A team with another main: the old main leaves, and the new one takes over its place in the graph. */
export function withMain(team: Content, main: string): Content {
  const next = clone(team);
  const previous = next.main;
  const graph: Record<string, string[]> = next.delegation ?? {};
  const inherited = previous && previous !== main ? graph[previous] ?? [] : [];
  if (previous && previous !== main) { delete next.members?.[previous]; delete graph[previous]; }
  const { role: _role, ...own } = next.members?.[main] ?? {};
  next.main = main;
  next.members = { [main]: own, ...Object.fromEntries(Object.entries(next.members ?? {}).filter(([name]) => name !== main)) };
  const targets = [...new Set([...(graph[main] ?? []), ...inherited])].filter(target => target !== main && target !== previous);
  for (const owner of Object.keys(graph)) graph[owner] = graph[owner].filter(target => target !== main && target !== previous);
  if (targets.length) graph[main] = targets; else delete graph[main];
  for (const owner of Object.keys(graph)) if (!graph[owner].length) delete graph[owner];
  next.delegation = graph;
  return next;
}

/** A team with an agent added as a peer, or removed with its place in the graph. */
export function withMember(team: Content, agent: string, on: boolean): Content {
  const next = clone(team);
  next.members ??= {};
  next.delegation ??= {};
  if (on) { next.members[agent] = { role: 'peer' }; return next; }
  delete next.members[agent];
  delete next.delegation[agent];
  for (const owner of Object.keys(next.delegation)) {
    next.delegation[owner] = next.delegation[owner].filter((target: string) => target !== agent);
    if (!next.delegation[owner].length) delete next.delegation[owner];
  }
  return next;
}

/** A team where `owner` may, or may no longer, delegate to `target`. */
export function withDelegation(team: Content, owner: string, target: string, on: boolean): Content {
  const next = clone(team);
  next.delegation ??= {};
  const targets = toggle(next.delegation[owner], target, on);
  if (targets.length) next.delegation[owner] = targets; else delete next.delegation[owner];
  return next;
}

/** A team, by tab: members and roles, who may delegate to whom, the supervisor and the house rules. Without a tab, all of it. */
export function TeamForm({ content, update, lists, styles, theme, tab }: FormProps) {
  const show = (key: string) => !tab || tab === key;
  const team: Content = content.team ?? {};
  const agents = names(lists, 'agents');
  const members = Object.keys(team.members ?? {});
  const others = members.filter(member => member !== team.main);
  const cycle = delegationCycle(team.delegation ?? {});
  const text = (key: string) => (value: string) => update(draft => { setOrDelete(draft.team, key, value.trim()); });
  return (
    <>
      {show('general') ? <SettingsSection title="Team">
        <SettingsInput label="Label" hint="Shown in Paseo's model picker" initialValue={team.label ?? ''} onChangeText={text('label')} />
        <SettingsInput label="Description" initialValue={team.description ?? ''} onChangeText={text('description')} />
        <SettingsSelect label="Main" hint="The agent the user talks with" value={team.main ?? ''} options={agents.filter(agent => agent !== team.supervisor?.agent).map(agent => ({ label: agent, value: agent }))} onValueChange={main => update(draft => { draft.team = withMain(draft.team, main); })} />
        <SettingsInput label="Most peers at once" initialValue={team.maxPeers === undefined ? '' : String(team.maxPeers)} onChangeText={value => update(draft => { setOrDelete(draft.team, 'maxPeers', value.trim() ? Number(value) : ''); })} />
      </SettingsSection> : null}
      {show('members') ? (
        <>
          {[team.main, ...agents.filter(agent => agent !== team.main && agent !== team.supervisor?.agent)].filter(Boolean).map((agent: string) => {
            const member = team.members?.[agent];
            const main = agent === team.main;
            return (
              <SettingsSection key={agent} title={main ? `${agent} · main` : agent} info={main ? <Text style={styles!.small}>The agent the user talks with; change it under General.</Text> : undefined}>
                {!main ? <SettingsSwitch label="In this team" value={!!member} onValueChange={on => update(draft => { draft.team = withMember(draft.team, agent, on); })} /> : null}
                {member && !main ? <SettingsSelect label="Role" value={member.role ?? 'peer'} options={ROLES.map(role => ({ label: role, value: role }))} onValueChange={role => update(draft => { draft.team.members[agent].role = role; })} /> : null}
                {member ? <SettingsInput label="Model" hint="Empty: the agent's own" initialValue={member.model ?? ''} onChangeText={value => update(draft => { setOrDelete(draft.team.members[agent], 'model', value.trim()); })} /> : null}
                {member ? <SettingsInput label="Thinking" hint="Empty: the agent's own" initialValue={member.thinking ?? ''} onChangeText={value => update(draft => { setOrDelete(draft.team.members[agent], 'thinking', value.trim()); })} /> : null}
              </SettingsSection>
            );
          })}
        </>
      ) : null}
      {show('delegation') ? (
        <>
          {cycle ? <Text style={styles!.danger}>Cycle at {cycle}: ALP refuses it</Text> : null}
          {members.map(owner => (
            <SettingsSection key={owner} title={`${owner} may delegate to`} info={<Text style={styles!.small}>{(team.delegation?.[owner] ?? []).join(', ') || 'no one'}</Text>}>
              {others.filter(target => target !== owner).map(target => (
                <SettingsSwitch key={`${owner}-${target}`} label={target} value={(team.delegation?.[owner] ?? []).includes(target)} onValueChange={on => update(draft => { draft.team = withDelegation(draft.team, owner, target, on); })} />
              ))}
              {!others.filter(target => target !== owner).length ? <SettingsRow label="No other members" /> : null}
            </SettingsSection>
          ))}
        </>
      ) : null}
      {show('supervisor') ? <SettingsSection title="Supervisor">
        <SettingsSwitch label="Review main's process after each turn" value={!!team.supervisor} onValueChange={on => update(draft => { draft.team.supervisor = on ? { agent: 'supervisor' } : false; })} />
        {team.supervisor ? (
          <>
            <SettingsSelect label="Supervisor agent" value={team.supervisor.agent} options={agents.filter(agent => !members.includes(agent)).map(agent => ({ label: agent, value: agent }))} onValueChange={agent => update(draft => { draft.team.supervisor.agent = agent; })} />
            <SettingsInput label="Supervisor's model" initialValue={team.supervisor.model ?? ''} onChangeText={value => update(draft => { setOrDelete(draft.team.supervisor, 'model', value.trim()); })} />
            <SettingsInput label="Supervisor's thinking" initialValue={team.supervisor.thinking ?? ''} onChangeText={value => update(draft => { setOrDelete(draft.team.supervisor, 'thinking', value.trim()); })} />
          </>
        ) : null}
      </SettingsSection> : null}
      {show('rules') ? <Multiline value={content.houseRules ?? ''} onChange={value => update(draft => { draft.houseRules = value; })} styles={styles!} theme={theme!} label="House rules" placeholder="The team's rules and process, which every member reads (HOUSE_RULES.md)" tall /> : null}
    </>
  );
}

/** The first agent in a delegation cycle, if there is one. */
export function delegationCycle(graph: Record<string, string[]>): string | null {
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (owner: string): string | null => {
    if (visiting.has(owner)) return owner;
    if (done.has(owner)) return null;
    visiting.add(owner);
    for (const target of graph[owner] ?? []) { const found = visit(target); if (found) return found; }
    visiting.delete(owner);
    done.add(owner);
    return null;
  };
  for (const owner of Object.keys(graph)) { const found = visit(owner); if (found) return found; }
  return null;
}

const lines = (text: string) => text.split('\n').map(line => line.trim()).filter(Boolean);
const pairs = (text: string) => Object.fromEntries(lines(text).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const unpairs = (map?: Record<string, string>) => Object.entries(map ?? {}).map(([key, value]) => `${key}=${value}`).join('\n');

export function McpForm({ content, update }: Omit<FormProps, 'lists'>) {
  const server: Content = content.server ?? {};
  const http = server.url !== undefined;
  const set = (key: string, value: unknown) => update(draft => { setOrDelete(draft.server, key, value); });
  return (
    <SettingsSection title="Server">
      <SettingsSelect label="Transport" value={http ? 'http' : 'stdio'} options={[{ label: 'Command (stdio)', value: 'stdio' }, { label: 'URL (HTTP)', value: 'http' }]} onValueChange={kind => update(draft => { draft.server = kind === 'http' ? { url: '' } : { command: '' }; })} />
      {http ? (
        <>
          <SettingsInput label="URL" initialValue={server.url ?? ''} onChangeText={value => update(draft => { draft.server.url = value.trim(); })} />
          <SettingsInput label="Headers" hint="Name=value, separated by ';'" initialValue={unpairs(server.headers).replaceAll('\n', '; ')} onChangeText={value => set('headers', Object.keys(pairs(value.replaceAll(';', '\n'))).length ? pairs(value.replaceAll(';', '\n')) : undefined)} />
        </>
      ) : (
        <>
          <SettingsInput label="Command" initialValue={server.command ?? ''} onChangeText={value => update(draft => { draft.server.command = value.trim(); })} />
          <SettingsInput label="Arguments" hint="Separated by spaces" initialValue={(server.args ?? []).join(' ')} onChangeText={value => set('args', value.split(/\s+/).filter(Boolean))} />
          <SettingsInput label="Environment" hint="NAME=value, separated by ';'" initialValue={unpairs(server.env).replaceAll('\n', '; ')} onChangeText={value => set('env', Object.keys(pairs(value.replaceAll(';', '\n'))).length ? pairs(value.replaceAll(';', '\n')) : undefined)} />
          <SettingsInput label="Working directory" hint="Relative to the mcp directory" initialValue={server.cwd ?? ''} onChangeText={value => set('cwd', value.trim())} />
        </>
      )}
    </SettingsSection>
  );
}

export function ProviderForm({ content, update }: Omit<FormProps, 'lists'>) {
  const provider: Content = content.provider ?? {};
  const set = (key: string, value: unknown) => update(draft => { draft.provider ??= { kind: 'acp' }; setOrDelete(draft.provider, key, value); });
  return (
    <SettingsSection title="ACP agent" info={<Text>Any agent that speaks the Agent Client Protocol on stdio. ALP answers its permission requests by the session's mode; it cannot steer it mid-turn or sandbox its commands.</Text>}>
      <SettingsInput label="Label" initialValue={provider.label ?? ''} onChangeText={value => set('label', value.trim())} />
      <SettingsInput label="Description" initialValue={provider.description ?? ''} onChangeText={value => set('description', value.trim())} />
      <SettingsInput label="Command" hint="Such as gemini, or an absolute path" initialValue={provider.command ?? ''} onChangeText={value => update(draft => { draft.provider.command = value.trim(); })} />
      <SettingsInput label="Arguments" hint="Separated by spaces, such as --experimental-acp" initialValue={(provider.args ?? []).join(' ')} onChangeText={value => set('args', value.split(/\s+/).filter(Boolean))} />
      <SettingsInput label="Environment" hint="NAME=value, separated by ';'" initialValue={unpairs(provider.env).replaceAll('\n', '; ')} onChangeText={value => set('env', Object.keys(pairs(value.replaceAll(';', '\n'))).length ? pairs(value.replaceAll(';', '\n')) : undefined)} />
      <SettingsInput label="Models" hint="Ids the agent offers, separated by ','; empty lets any through" initialValue={(provider.models ?? []).map((model: { id: string }) => model.id).join(', ')} onChangeText={value => set('models', value.split(',').map(id => id.trim()).filter(Boolean).map(id => (provider.models ?? []).find((model: { id: string }) => model.id === id) ?? { id }))} />
    </SettingsSection>
  );
}

export function HookForm({ content, update, lists }: FormProps) {
  const hook: Content = content.hook ?? {};
  const set = (key: string, value: unknown) => update(draft => { setOrDelete(draft.hook, key, value); });
  const blocking = BLOCKING_EVENTS.includes(hook.event);
  return (
    <SettingsSection title="Hook">
      <SettingsSelect label="Event" value={hook.event ?? 'handoff'} options={HOOK_EVENTS.map(event => ({ label: event, value: event }))} onValueChange={event => update(draft => { draft.hook.event = event; if (!BLOCKING_EVENTS.includes(event)) delete draft.hook.blocking; })} />
      <SettingsInput label="Command" hint="Runs in the session's directory; the event arrives as JSON on stdin" initialValue={hook.command ?? ''} onChangeText={value => update(draft => { draft.hook.command = value; })} />
      {blocking ? <SettingsSwitch label="Block the action when it fails" hint="Its stderr becomes the reason the agent reads" value={!!hook.blocking} onValueChange={on => set('blocking', on || undefined)} /> : null}
      <SettingsInput label="Timeout (seconds)" initialValue={hook.timeoutSec === undefined ? '' : String(hook.timeoutSec)} onChangeText={value => set('timeoutSec', value.trim() ? Number(value) : '')} />
      <SettingsSelect label="Only for agent" value={hook.match?.agent ?? ''} options={[{ label: 'Every agent', value: '' }, ...names(lists, 'agents').map(agent => ({ label: agent, value: agent }))]} onValueChange={agent => update(draft => { draft.hook.match ??= {}; setOrDelete(draft.hook.match, 'agent', agent); if (!Object.keys(draft.hook.match).length) delete draft.hook.match; })} />
      <SettingsInput label="Only for tasks labeled" initialValue={hook.match?.label ?? ''} onChangeText={label => update(draft => { draft.hook.match ??= {}; setOrDelete(draft.hook.match, 'label', label.trim()); if (!Object.keys(draft.hook.match).length) delete draft.hook.match; })} />
    </SettingsSection>
  );
}

function TestResult({ kind, result, styles }: { kind: Kind; result: Record<string, any>; styles: Styles }) {
  if (kind === 'providers') {
    return (
      <View>
        <Text style={styles.success}>{result.agent?.title ?? result.agent?.name ?? 'The agent'}{result.agent?.version ? ` ${result.agent.version}` : ''} speaks ACP {result.protocolVersion}</Text>
        <Text style={styles.muted}>{result.loadSession ? 'Resumes sessions' : 'Cannot resume sessions'}{result.mcpHttp ? '; takes HTTP MCP servers' : '; takes stdio MCP servers only'}{result.authMethods?.length ? `; signs in with ${result.authMethods.join(', ')}` : ''}</Text>
      </View>
    );
  }
  if (kind === 'mcp') {
    return (
      <View>
        <Text style={styles.success}>{result.server?.name ?? 'The server'}{result.server?.version ? ` ${result.server.version}` : ''} offers {result.tools?.length ?? 0} tools</Text>
        {(result.tools ?? []).map((tool: { name: string; description?: string }) => <Text key={tool.name} style={styles.muted}>{tool.name}{tool.description ? ` — ${tool.description.split('\n')[0]}` : ''}</Text>)}
      </View>
    );
  }
  return (
    <View>
      <Text style={result.ok ? styles.success : styles.danger}>{result.timedOut ? 'Timed out' : `Exit ${result.exitCode ?? result.signal}`} in {result.durationMs} ms{result.wouldBlock ? '; as a blocking hook it would refuse the action' : ''}</Text>
      {result.stdout ? <Text style={styles.code}>{result.stdout}</Text> : null}
      {result.stderr ? <Text style={styles.code}>{result.stderr}</Text> : null}
    </View>
  );
}

/** A file's text: AGENT.md, SKILL.md, HOUSE_RULES.md. Tall ones fill the working area. */
function Multiline({ value, onChange, styles, theme, label, placeholder, tall }: { value: string; onChange(text: string): void; styles: Styles; theme: PluginTheme; label: string; placeholder?: string; tall?: boolean }) {
  return <TextInput style={[styles.multiline, tall ? styles.tall : null]} value={value} onChangeText={onChange} multiline accessibilityLabel={label} placeholder={placeholder ?? label} placeholderTextColor={theme.colors.foregroundMuted} />;
}

type Styles = ReturnType<typeof makeStyles>;
function makeStyles(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  return {
    screen: { flex: 1, backgroundColor: colors.surface0, padding: compact ? 12 : 20 },
    muted: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
    small: { color: colors.foregroundMuted, fontSize: 12 },
    danger: { color: colors.statusDanger, fontSize: 13 },
    success: { color: colors.statusSuccess, fontSize: 13 },
    name: { color: colors.foreground, fontSize: 14, fontWeight: '600' as const },
    empty: { borderWidth: 1, borderStyle: 'dashed' as const, borderColor: colors.border, borderRadius: 10, padding: 24, alignItems: 'center' as const },
    table: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface1, overflow: 'hidden' as const },
    tableRow: { flexDirection: compact ? 'column' as const : 'row' as const, flexWrap: 'wrap' as const, alignItems: compact ? 'stretch' as const : 'center' as const, gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
    tableRowRule: { borderTopWidth: 1, borderTopColor: colors.border },
    rowMain: { flex: 1, minWidth: 0, gap: 3 },
    rowTitle: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8, flexWrap: 'wrap' as const },
    rowActions: { flexDirection: 'row' as const, gap: 8, alignItems: 'center' as const },
    rowActionsCompact: { flexWrap: 'wrap' as const },
    copyRow: { flexBasis: '100%' as const, flexDirection: 'row' as const, gap: 8, alignItems: 'center' as const },
    input: { flex: 1, color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: colors.surface0 },
    banner: { borderRadius: 10, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 10, gap: 4 },
    bannerText: { color: colors.foreground, fontSize: 13 },
    multiline: { minHeight: 160, color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, fontFamily: 'monospace', fontSize: 13, lineHeight: 19, backgroundColor: colors.surface1, textAlignVertical: 'top' as const },
    tall: { minHeight: 420 },
    code: { color: colors.foreground, fontFamily: 'monospace', fontSize: 12 },
  };
}
