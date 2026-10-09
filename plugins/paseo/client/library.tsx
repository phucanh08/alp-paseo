import type { PluginTheme } from '@getpaseo/plugin';
import { type PluginSurfaceProps, type PluginWorkspacePanelProps, useRpc, useWorkspace } from '@getpaseo/plugin/client';
import { ScrollView, useToast } from '@getpaseo/plugin/client/react-native';
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from '@getpaseo/plugin/client/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { libraryDelete, libraryDuplicate, libraryGet, libraryList, librarySave, libraryTest, type EntryRow } from '../shared/library';

/**
 * The ALP settings screen and the "ALP project" panel (plans/reference/ALPD.md §44).
 * The screen edits the user's library in ~/.alp; the panel shows what the workspace's
 * project overrides and edits those overrides. Built-ins are read-only: saving one
 * makes the library's (or the project's) entry of that name.
 */

export type Kind = 'teams' | 'agents' | 'skills' | 'mcp' | 'hooks';
export type Scope = 'library' | 'project';
export const KINDS: Array<{ kind: Kind; title: string; one: string }> = [
  { kind: 'teams', title: 'Teams', one: 'team' },
  { kind: 'agents', title: 'Agents', one: 'agent' },
  { kind: 'skills', title: 'Skills', one: 'skill' },
  { kind: 'mcp', title: 'MCP servers', one: 'MCP server' },
  { kind: 'hooks', title: 'Hooks', one: 'hook' },
];
const HOOK_EVENTS = ['session.start', 'turn.end', 'assignment.start', 'assignment.end', 'handoff', 'task.close', 'merge'];
const BLOCKING_EVENTS = ['handoff', 'task.close', 'merge'];
const ROLES = ['lead', 'peer', 'advisor', 'reviewer'];
const MODES = ['', 'read-only', 'workspace-write', 'full-access'];
const NAME = /^[\w.-]+$/;
/** Entries are JSON data; React Native's engine may lack structuredClone. */
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const sourceLabel = (source: string) => source === 'builtin' ? 'built-in' : source;

type Lists = Partial<Record<Kind, EntryRow[]>>;
type Content = Record<string, any>;
type Opened = { kind: Kind; name: string; creating?: boolean };
type Entry = { kind: Kind; name: string; source: string; overrides?: string; content: Content; revision: string | null; usedBy: string[] };

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
  const toast = useToast();
  const [lists, setLists] = useState<Lists>({});
  const [where, setWhere] = useState<{ projectRoot: string | null; library: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
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
    if (!opened || opened.creating) { setEntry(null); return; }
    let live = true;
    get({ ...base, kind: opened.kind, name: opened.name })
      .then(result => { if (live) setEntry(result as Entry); })
      .catch(cause => { if (live) { toast.error(message(cause)); setOpened(null); } });
    return () => { live = false; };
    // After a save the entry is read again, so the next save carries its new revision.
  }, [opened, get, directory, tick]);

  const run = useCallback(async (work: () => Promise<unknown>, done: string) => {
    try { await work(); toast.show(done, { variant: 'success' }); refresh(); return true; }
    catch (cause) { toast.error(message(cause)); return false; }
  }, [toast, refresh]);

  const actions: Actions = {
    open: (kind, name) => setOpened({ kind, name }),
    create: kind => setOpened({ kind, name: '', creating: true }),
    close: () => { setOpened(null); refresh(); },
    duplicate: (kind, from, to) => run(() => duplicate({ ...base, kind, from, to, scope }), `Copied ${from} to ${to}`),
    // In the project panel: copy what applies into .alp/, or drop the project's copy.
    override: (kind, name) => run(() => duplicate({ ...base, kind, from: name, to: name, scope: 'project' }), `${name} is now overridden in this project`),
    useLibrary: (kind, name) => run(() => remove({ ...base, kind, name, scope: 'project' }), `${name} follows the library again`),
    save: async (kind, name, content, revision) => run(() => save({ ...base, kind, name, scope, content, revision }), `Saved ${name}`),
    remove: async (kind, name, revision) => {
      const removed = await run(() => remove({ ...base, kind, name, scope, ...(revision ? { revision } : {}) }), `Removed ${name}`);
      if (removed) setOpened(null);
      return removed;
    },
    test: async (kind, name) => {
      try { return await probe({ ...base, kind: kind as 'mcp' | 'hooks', name }); }
      catch (cause) { toast.error(message(cause)); return null; }
    },
  };

  if (opened && (opened.creating || entry)) {
    return <EntryEditor key={`${opened.kind}/${opened.name}/${entry?.revision ?? 'new'}`} theme={theme} compact={compact} scope={scope} kind={opened.kind} entry={opened.creating ? null : entry} lists={lists} actions={actions} />;
  }
  return <LibraryLists theme={theme} compact={compact} scope={scope} where={where} lists={lists} error={error} actions={actions} />;
}

export type Actions = {
  open(kind: Kind, name: string): void;
  create(kind: Kind): void;
  close(): void;
  duplicate(kind: Kind, from: string, to: string): Promise<boolean>;
  override(kind: Kind, name: string): Promise<boolean>;
  useLibrary(kind: Kind, name: string): Promise<boolean>;
  save(kind: Kind, name: string, content: Content, revision: string | null): Promise<boolean>;
  remove(kind: Kind, name: string, revision?: string | null): Promise<boolean>;
  test(kind: Kind, name: string): Promise<Record<string, any> | null>;
};

/** Every kind's entries with their sources; kept free of RPC so it renders from data alone. */
export function LibraryLists({ theme, compact, scope, where, lists, error, actions }: { theme: PluginTheme; compact: boolean; scope: Scope; where: { projectRoot: string | null; library: string } | null; lists: Lists; error: string | null; actions: Actions }) {
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const [copying, setCopying] = useState<{ kind: Kind; from: string } | null>(null);
  const [copyName, setCopyName] = useState('');
  if (scope === 'project' && where && !where.projectRoot) {
    return <View style={styles.screen}><Text style={styles.muted}>This workspace is not an ALP project. Run alp init to start one.</Text></View>;
  }
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.muted}>
        {scope === 'library'
          ? `Your library${where ? ` in ${where.library}` : ''}: every project uses it. Built-ins follow ALP updates; saving one makes your own copy of that name.`
          : `What ${where?.projectRoot ?? 'this project'} overrides. Override an entry to change it here only; Use library drops the project's copy.`}
      </Text>
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      {KINDS.map(({ kind, title, one }) => {
        const rows = lists[kind];
        return (
          <SettingsSection key={kind} title={title} trailing={<Pressable accessibilityRole="button" accessibilityLabel={`New ${one}`} onPress={() => actions.create(kind)}><Text style={styles.link}>New</Text></Pressable>}>
            {!rows ? <Text style={styles.muted}>Loading…</Text> : null}
            {rows && !rows.length ? <Text style={styles.muted}>No {title.toLowerCase()} yet.</Text> : null}
            {(rows ?? []).map(row => (
              <View key={row.name} style={styles.row}>
                <Pressable accessibilityRole="button" accessibilityLabel={`Open ${one} ${row.name}`} onPress={() => actions.open(kind, row.name)} style={styles.rowMain}>
                  <Text style={styles.name}>{row.name}</Text>
                  <Text style={styles.badge}>{sourceLabel(row.source)}{row.overrides ? ` · overrides ${sourceLabel(row.overrides)}` : ''}</Text>
                  {row.description ? <Text style={styles.muted}>{row.description}</Text> : null}
                  {row.usedBy?.length ? <Text style={styles.muted}>Used by {row.usedBy.join(', ')}</Text> : null}
                </Pressable>
                <View style={styles.rowActions}>
                  {scope === 'project' && row.source === 'project' && row.overrides ? <Pressable accessibilityRole="button" onPress={() => actions.useLibrary(kind, row.name)}><Text style={styles.link}>Use library</Text></Pressable> : null}
                  {scope === 'project' && row.source !== 'project' ? <Pressable accessibilityRole="button" onPress={() => actions.override(kind, row.name)}><Text style={styles.link}>Override in this project</Text></Pressable> : null}
                  <Pressable accessibilityRole="button" accessibilityLabel={`Duplicate ${one} ${row.name}`} onPress={() => { setCopying({ kind, from: row.name }); setCopyName(`${row.name}-copy`); }}><Text style={styles.link}>Duplicate</Text></Pressable>
                </View>
                {copying?.kind === kind && copying.from === row.name ? (
                  <View style={styles.copyRow}>
                    <TextInput style={styles.input} value={copyName} onChangeText={setCopyName} accessibilityLabel="Name of the copy" placeholder="Name of the copy" placeholderTextColor={theme.colors.foregroundMuted} />
                    <Pressable accessibilityRole="button" onPress={async () => { if (NAME.test(copyName) && await actions.duplicate(kind, row.name, copyName)) setCopying(null); }} style={styles.button}><Text style={styles.buttonText}>Copy</Text></Pressable>
                    <Pressable accessibilityRole="button" onPress={() => setCopying(null)}><Text style={styles.link}>Cancel</Text></Pressable>
                  </View>
                ) : null}
              </View>
            ))}
          </SettingsSection>
        );
      })}
    </ScrollView>
  );
}

/** A blank entry of a kind, as New starts it. */
export function blank(kind: Kind, name = 'new'): Content {
  if (kind === 'agents') return { instructions: `# ${name}\n\nDescribe what this agent does, and how.\n`, config: {} };
  if (kind === 'skills') return { body: `---\nname: ${name}\ndescription: When to use this skill.\n---\n\n# ${name}\n\nSteps and checks.\n` };
  if (kind === 'mcp') return { server: { command: '' } };
  if (kind === 'hooks') return { hook: { event: 'handoff', command: '', blocking: false } };
  return { team: { label: name, main: 'main', members: { main: {} }, delegation: {}, supervisor: false }, houseRules: '' };
}

/** Edits one entry; built-ins and entries of lower layers are saved as this scope's own. */
export function EntryEditor({ theme, compact, scope, kind, entry, lists, actions }: { theme: PluginTheme; compact: boolean; scope: Scope; kind: Kind; entry: Entry | null; lists: Lists; actions: Actions }) {
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const one = KINDS.find(item => item.kind === kind)!.one;
  const [name, setName] = useState(entry?.name ?? '');
  const [content, setContent] = useState<Content>(() => clone(entry?.content ?? blank(kind)));
  const [result, setResult] = useState<Record<string, any> | null>(null);
  const own = entry?.source === scope;
  const update = (change: (draft: Content) => void) => setContent(current => { const draft = clone(current); change(draft); return draft; });
  const valid = NAME.test(name);
  const onSave = async () => { if (valid && await actions.save(kind, name, content, own ? entry!.revision : null) && !entry) actions.close(); };
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={actions.close}><Text style={styles.link}>‹ Back</Text></Pressable>
        <Text style={styles.title}>{entry ? `${one} ${entry.name}` : `New ${one}`}</Text>
      </View>
      {entry ? (
        <Text style={styles.muted}>
          {entry.source === 'builtin' ? `Built into ALP. Saving makes ${scope === 'library' ? 'your library\'s' : 'this project\'s'} own ${entry.name}, which overrides it.`
            : own ? `In ${scope === 'library' ? 'your library' : 'this project'}${entry.overrides ? `; overrides the ${sourceLabel(entry.overrides)} one` : ''}.`
            : `From the ${sourceLabel(entry.source)}. Saving makes this project's own copy.`}
          {entry.usedBy.length ? ` Used by ${entry.usedBy.join(', ')}.` : ''}
        </Text>
      ) : null}
      {!entry ? <SettingsSection title="Name"><SettingsInput label="Name" hint="Letters, digits, '.', '_' or '-'" error={name && !valid ? 'Not a valid name' : null} initialValue={name} onChangeText={setName} /></SettingsSection> : null}
      {kind === 'agents' ? <AgentForm content={content} update={update} lists={lists} styles={styles} theme={theme} /> : null}
      {kind === 'teams' ? <TeamForm content={content} update={update} lists={lists} styles={styles} theme={theme} /> : null}
      {kind === 'skills' ? <SettingsSection title="SKILL.md"><Multiline value={content.body ?? ''} onChange={text => update(draft => { draft.body = text; })} styles={styles} theme={theme} label="SKILL.md" /></SettingsSection> : null}
      {kind === 'mcp' ? <McpForm content={content} update={update} /> : null}
      {kind === 'hooks' ? <HookForm content={content} update={update} lists={lists} /> : null}
      {(kind === 'mcp' || kind === 'hooks') && entry ? (
        <SettingsSection title="Test">
          <SettingsAction label={kind === 'mcp' ? 'Start the server and list its tools' : 'Run once with a sample event'} hint="Save first: the test runs what is saved." actionLabel="Test" onPress={async () => setResult(await actions.test(kind, entry.name))} />
          {result ? <TestResult kind={kind} result={result} styles={styles} /> : null}
        </SettingsSection>
      ) : null}
      <View style={styles.footer}>
        <Pressable accessibilityRole="button" onPress={onSave} style={[styles.button, valid ? null : styles.disabled]}><Text style={styles.buttonText}>{entry && entry.source === 'builtin' ? 'Save as my own' : 'Save'}</Text></Pressable>
        {entry && own ? <Pressable accessibilityRole="button" onPress={() => actions.remove(kind, entry.name, entry.revision)}><Text style={styles.danger}>{entry.overrides ? `Remove (the ${sourceLabel(entry.overrides)} one applies again)` : 'Remove'}</Text></Pressable> : null}
      </View>
    </ScrollView>
  );
}

type FormProps = { content: Content; update(change: (draft: Content) => void): void; lists: Lists; styles?: Styles; theme?: PluginTheme };
const names = (lists: Lists, kind: Kind) => (lists[kind] ?? []).map(row => row.name);
const toggle = (list: string[] | undefined, name: string, on: boolean) => { const set = new Set(list ?? []); if (on) set.add(name); else set.delete(name); return [...set]; };
const setOrDelete = (target: Content, key: string, value: unknown) => { if (value === '' || value === undefined || (Array.isArray(value) && !value.length)) delete target[key]; else target[key] = value; };

export function AgentForm({ content, update, lists, styles, theme }: FormProps) {
  const config: Content = content.config ?? {};
  const field = (key: string) => (text: string) => update(draft => { draft.config ??= {}; setOrDelete(draft.config, key, text.trim()); });
  return (
    <>
      <SettingsSection title="Agent">
        <SettingsInput label="Description" initialValue={config.description ?? ''} onChangeText={field('description')} />
        <SettingsSelect label="Provider" hint="The team or project settings may choose another" value={config.provider ?? ''} options={[{ label: 'Default', value: '' }, { label: 'Codex', value: 'codex' }, { label: 'Claude Code', value: 'claude' }]} onValueChange={field('provider')} />
        <SettingsInput label="Model" hint="Such as claude:claude-sonnet-5-5 or codex:gpt-6-sol" initialValue={config.model ?? ''} onChangeText={field('model')} />
        <SettingsInput label="Thinking" hint="Effort, such as low, medium or high" initialValue={config.thinking ?? ''} onChangeText={field('thinking')} />
        <SettingsSelect label="Default mode" value={config.mode ?? ''} options={MODES.map(mode => ({ label: mode || 'As its requester chooses', value: mode }))} onValueChange={field('mode')} />
      </SettingsSection>
      <SettingsSection title="Instructions (AGENT.md)">
        <Multiline value={content.instructions ?? ''} onChange={text => update(draft => { draft.instructions = text; })} styles={styles!} theme={theme!} label="AGENT.md" />
      </SettingsSection>
      {(['skills', 'mcp', 'hooks'] as const).map(kind => (
        <SettingsSection key={kind} title={KINDS.find(item => item.kind === kind)!.title}>
          {!names(lists, kind).length ? <SettingsRow label={`No ${KINDS.find(item => item.kind === kind)!.title.toLowerCase()} to choose from yet`} /> : null}
          {names(lists, kind).map(name => (
            <SettingsSwitch key={name} label={name} value={(config[kind] ?? []).includes(name)} onValueChange={on => update(draft => { draft.config ??= {}; setOrDelete(draft.config, kind, toggle(draft.config[kind], name, on)); })} />
          ))}
        </SettingsSection>
      ))}
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

/** A team: members and roles, who may delegate to whom, the supervisor and the house rules. */
export function TeamForm({ content, update, lists, styles, theme }: FormProps) {
  const team: Content = content.team ?? {};
  const agents = names(lists, 'agents');
  const members = Object.keys(team.members ?? {});
  const others = members.filter(member => member !== team.main);
  const cycle = delegationCycle(team.delegation ?? {});
  const text = (key: string) => (value: string) => update(draft => { setOrDelete(draft.team, key, value.trim()); });
  return (
    <>
      <SettingsSection title="Team">
        <SettingsInput label="Label" hint="Shown in Paseo's model picker" initialValue={team.label ?? ''} onChangeText={text('label')} />
        <SettingsInput label="Description" initialValue={team.description ?? ''} onChangeText={text('description')} />
        <SettingsSelect label="Main" hint="The agent the user talks with" value={team.main ?? ''} options={agents.filter(agent => agent !== team.supervisor?.agent).map(agent => ({ label: agent, value: agent }))} onValueChange={main => update(draft => { draft.team = withMain(draft.team, main); })} />
        <SettingsInput label="Most peers at once" initialValue={team.maxPeers === undefined ? '' : String(team.maxPeers)} onChangeText={value => update(draft => { setOrDelete(draft.team, 'maxPeers', value.trim() ? Number(value) : ''); })} />
      </SettingsSection>
      <SettingsSection title="Members">
        {agents.filter(agent => agent !== team.main && agent !== team.supervisor?.agent).map(agent => {
          const member = team.members?.[agent];
          return (
            <View key={agent}>
              <SettingsSwitch label={agent} value={!!member} onValueChange={on => update(draft => { draft.team = withMember(draft.team, agent, on); })} />
              {member ? <SettingsSelect label={`${agent}'s role`} value={member.role ?? 'peer'} options={ROLES.map(role => ({ label: role, value: role }))} onValueChange={role => update(draft => { draft.team.members[agent].role = role; })} /> : null}
            </View>
          );
        })}
        {members.map(member => (
          <View key={`${member}-model`}>
            <SettingsInput label={`${member}'s model`} hint="Empty: the agent's own" initialValue={team.members[member]?.model ?? ''} onChangeText={value => update(draft => { setOrDelete(draft.team.members[member], 'model', value.trim()); })} />
            <SettingsInput label={`${member}'s thinking`} initialValue={team.members[member]?.thinking ?? ''} onChangeText={value => update(draft => { setOrDelete(draft.team.members[member], 'thinking', value.trim()); })} />
          </View>
        ))}
      </SettingsSection>
      <SettingsSection title="Who may delegate to whom" info={cycle ? <Text style={styles!.danger}>Cycle at {cycle}: ALP refuses it</Text> : undefined}>
        {members.map(owner => (
          <View key={owner}>
            <SettingsRow label={`${owner} →`} hint={(team.delegation?.[owner] ?? []).join(', ') || 'no one'} />
            {others.filter(target => target !== owner).map(target => (
              <SettingsSwitch key={`${owner}-${target}`} label={`${owner} → ${target}`} value={(team.delegation?.[owner] ?? []).includes(target)} onValueChange={on => update(draft => { draft.team = withDelegation(draft.team, owner, target, on); })} />
            ))}
          </View>
        ))}
      </SettingsSection>
      <SettingsSection title="Supervisor">
        <SettingsSwitch label="Review main's process after each turn" value={!!team.supervisor} onValueChange={on => update(draft => { draft.team.supervisor = on ? { agent: 'supervisor' } : false; })} />
        {team.supervisor ? (
          <>
            <SettingsSelect label="Supervisor agent" value={team.supervisor.agent} options={agents.filter(agent => !members.includes(agent)).map(agent => ({ label: agent, value: agent }))} onValueChange={agent => update(draft => { draft.team.supervisor.agent = agent; })} />
            <SettingsInput label="Supervisor's model" initialValue={team.supervisor.model ?? ''} onChangeText={value => update(draft => { setOrDelete(draft.team.supervisor, 'model', value.trim()); })} />
            <SettingsInput label="Supervisor's thinking" initialValue={team.supervisor.thinking ?? ''} onChangeText={value => update(draft => { setOrDelete(draft.team.supervisor, 'thinking', value.trim()); })} />
          </>
        ) : null}
      </SettingsSection>
      <SettingsSection title="House rules (HOUSE_RULES.md)">
        <Multiline value={content.houseRules ?? ''} onChange={value => update(draft => { draft.houseRules = value; })} styles={styles!} theme={theme!} label="House rules" placeholder="The team's rules and process, which every member reads" />
      </SettingsSection>
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

function Multiline({ value, onChange, styles, theme, label, placeholder }: { value: string; onChange(text: string): void; styles: Styles; theme: PluginTheme; label: string; placeholder?: string }) {
  return <TextInput style={styles.multiline} value={value} onChangeText={onChange} multiline accessibilityLabel={label} placeholder={placeholder ?? label} placeholderTextColor={theme.colors.foregroundMuted} />;
}

type Styles = ReturnType<typeof makeStyles>;
function makeStyles(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  return {
    screen: { flex: 1, backgroundColor: colors.surface0 },
    content: { padding: compact ? 12 : 20, gap: 16 },
    header: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12 },
    title: { color: colors.foreground, fontSize: 18, fontWeight: '600' as const },
    muted: { color: colors.foregroundMuted, fontSize: 13 },
    danger: { color: colors.statusDanger, fontSize: 13 },
    success: { color: colors.statusSuccess, fontSize: 13 },
    link: { color: colors.accent, fontSize: 13 },
    name: { color: colors.foreground, fontSize: 14, fontWeight: '500' as const },
    badge: { color: colors.foregroundMuted, fontSize: 12 },
    row: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border, gap: 4 },
    rowMain: { gap: 2 },
    rowActions: { flexDirection: 'row' as const, gap: 16, flexWrap: 'wrap' as const },
    copyRow: { flexDirection: 'row' as const, gap: 8, alignItems: 'center' as const },
    input: { flex: 1, color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6 },
    multiline: { minHeight: 160, color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: 6, padding: 8, fontFamily: 'monospace', textAlignVertical: 'top' as const },
    code: { color: colors.foreground, fontFamily: 'monospace', fontSize: 12 },
    footer: { flexDirection: 'row' as const, gap: 16, alignItems: 'center' as const },
    button: { backgroundColor: colors.accent, borderRadius: 6, paddingHorizontal: 14, paddingVertical: 8 },
    buttonText: { color: colors.accentForeground, fontWeight: '600' as const },
    disabled: { opacity: 0.5 },
  };
}
