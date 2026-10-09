import type { PluginTheme } from '@getpaseo/plugin';
import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from '@getpaseo/plugin/client';
import { Icon, ScrollView, useToast } from '@getpaseo/plugin/client/react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View, type PressableStateCallbackType } from 'react-native';
import { boardSections, tasksAdd, tasksChange, tasksList, type TaskRow } from '../shared/tasks';

/**
 * The Tasks panel (ALPD §22, §47), shaped after the beads viewers: a list grouped by
 * what the user acts on, a board by status, and epics with their progress. A row opens
 * the task's detail, beside the list when the panel is wide enough.
 */

/** Plugin RPC has no server push, so the panel asks again while it is open. */
const POLL_MS = 5000;
/** At this width the list and the selected task's detail sit side by side. */
const SPLIT_FROM = 820;

type Action = { id: string; action: 'close' | 'reopen' | 'approve'; gate?: string };
export type View_ = 'list' | 'board' | 'epics';
export type Filter = 'open' | 'ready' | 'closed' | 'all';

/** The Tasks panel: the ALP tasks of the workspace's project, polled through the plugin server. */
export function TasksPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  // Agents of a worktree workspace work in its directory, which has its own .alp/tasks.
  const directory = useWorkspace(workspaceId, workspace => workspace.directory || workspace.projectRootPath);
  const list = useRpc(tasksList);
  const add = useRpc(tasksAdd);
  const change = useRpc(tasksChange);
  const toast = useToast();
  const [data, setData] = useState<{ projectRoot: string | null; tasks: TaskRow[]; unreadable: Array<{ file: string }> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick(value => value + 1), []);

  useEffect(() => {
    if (!directory) return;
    let live = true;
    const load = () => list({ directory })
      .then(result => { if (live) { setData(result); setError(null); } })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [directory, list, tick]);

  const onAdd = useCallback(async (title: string, priority: number) => {
    if (!directory) return false;
    try {
      const { id } = await add({ directory, title, priority });
      toast.show(`Added ${id}`, { variant: 'success' });
      refresh();
      return true;
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }, [add, directory, refresh, toast]);

  const onAction = useCallback(async ({ id, action, gate }: Action) => {
    if (!directory) return;
    try {
      const { landed } = await change({ directory, id, action, ...(gate ? { gate } : {}) });
      toast.show(landed ?? (action === 'approve' ? `Approved ${id}` : action === 'close' ? `Closed ${id}` : `Reopened ${id}`), { variant: 'success' });
      refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  }, [change, directory, refresh, toast]);

  return (
    <TaskBoard theme={theme} compact={layout.compact} directory={directory} projectRoot={data?.projectRoot ?? null} tasks={data?.tasks ?? null}
      unreadable={data?.unreadable.length ?? 0} error={error} onAdd={onAdd} onAction={onAction} onRefresh={refresh} />
  );
}

type BoardProps = {
  theme: PluginTheme;
  compact: boolean;
  directory: string | null;
  projectRoot: string | null;
  tasks: TaskRow[] | null;
  unreadable: number;
  error: string | null;
  onAdd(title: string, priority: number): Promise<boolean>;
  onAction(action: Action): void;
  onRefresh(): void;
  /** Tests start on a view, a filter or a task. */
  initial?: { view?: View_; filter?: Filter; selected?: string; width?: number };
};

const PRIORITIES = [0, 1, 2, 3, 4];
const TYPE_ICONS: Record<string, string> = { bug: 'Bug', feature: 'Sparkles', task: 'SquareCheck', chore: 'Wrench', epic: 'Target' };
const hovered = (state: PressableStateCallbackType) => !!(state as { hovered?: boolean }).hovered;

/** How long ago, in the largest unit: 5m, 3h, 2d, 6w. */
export function age(iso: string | undefined, now = Date.now()) {
  if (!iso) return '';
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 60 * 24 * 14) return `${Math.floor(minutes / 1440)}d`;
  return `${Math.floor(minutes / 10080)}w`;
}

/** A task's state for its dot and board column: what the user acts on first. */
export function stateOf(task: TaskRow): 'approve' | 'review' | 'progress' | 'ready' | 'blocked' | 'closed' {
  if (task.status === 'closed') return 'closed';
  if (task.approvals?.length) return 'approve';
  if (task.status === 'review') return 'review';
  if (task.status === 'in_progress') return 'progress';
  // An epic waits on its own tasks, which is its work rather than a blocker.
  if (task.type === 'epic') return task.progress?.done ? 'progress' : 'ready';
  return task.ready ? 'ready' : 'blocked';
}
const STATE_LABELS = { approve: 'Needs approval', review: 'In review', progress: 'In progress', ready: 'Ready', blocked: 'Blocked', closed: 'Closed' };

/** Tasks a filter and a search keep: by state, then by id, title, type, assignee and labels. */
export function filterTasks(tasks: TaskRow[], filter: Filter, query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return tasks.filter(task => {
    if (filter === 'open' && task.status === 'closed') return false;
    if (filter === 'ready' && !(task.ready && task.status !== 'closed')) return false;
    if (filter === 'closed' && task.status !== 'closed') return false;
    const text = [task.id, task.title, task.type, task.assignee ?? '', ...(task.labels ?? [])].join(' ').toLowerCase();
    return words.every(word => text.includes(word));
  });
}

/** What the panel shows; kept free of RPC so it renders from data alone. */
export function TaskBoard({ theme, compact, directory, projectRoot, tasks, unreadable, error, onAdd, onAction, onRefresh, initial }: BoardProps) {
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const [view, setView] = useState<View_>(initial?.view ?? 'list');
  const [filter, setFilter] = useState<Filter>(initial?.filter ?? 'open');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(initial?.selected ?? null);
  const [composing, setComposing] = useState(false);
  const [width, setWidth] = useState(initial?.width ?? 0);
  const shown = useMemo(() => tasks ? filterTasks(tasks, filter, query) : [], [tasks, filter, query]);
  const task = selected ? tasks?.find(candidate => candidate.id === selected) ?? null : null;
  const split = !!task && width >= SPLIT_FROM;
  const counts = useMemo(() => ({
    open: (tasks ?? []).filter(entry => entry.status !== 'closed').length,
    ready: (tasks ?? []).filter(entry => entry.ready && entry.status !== 'closed').length,
    closed: (tasks ?? []).filter(entry => entry.status === 'closed').length,
    all: (tasks ?? []).length,
  }), [tasks]);

  if (!directory) return <View style={styles.screen}><Text style={styles.muted}>This panel needs a workspace.</Text></View>;
  const open = (id: string) => setSelected(id);
  const detail = task ? <TaskDetail theme={theme} styles={styles} task={task} tasks={tasks ?? []} onBack={() => setSelected(null)} onOpen={open} onAction={onAction} /> : null;
  return (
    <View style={styles.screen} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
      <View style={styles.toolbar}>
        <View style={styles.toolbarRow}>
          <Text style={styles.title}>Tasks</Text>
          {tasks ? <Text style={styles.count}>{counts.open} open</Text> : null}
          <View style={{ flex: 1 }} />
          <Segmented theme={theme} styles={styles} value={view} onChange={value => { setView(value as View_); setSelected(null); }}
            options={[{ key: 'list', label: 'List', icon: 'List' }, { key: 'board', label: 'Board', icon: 'Columns3' }, { key: 'epics', label: 'Epics', icon: 'Target' }]} />
          <IconButton theme={theme} icon="RefreshCw" label="Refresh" onPress={onRefresh} />
          {projectRoot ? <IconButton theme={theme} icon="Plus" label="New task" onPress={() => setComposing(!composing)} primary /> : null}
        </View>
        {projectRoot ? (
          <View style={styles.toolbarRow}>
            {(['open', 'ready', 'closed', 'all'] as const).map(key => (
              <Pressable key={key} accessibilityRole="button" accessibilityLabel={`Show ${key}`} accessibilityState={{ selected: filter === key }} onPress={() => setFilter(key)} style={[styles.filter, filter === key ? styles.filterOn : null]}>
                <Text style={filter === key ? styles.filterTextOn : styles.filterText}>{key[0].toUpperCase() + key.slice(1)} <Text style={styles.filterCount}>{counts[key]}</Text></Text>
              </Pressable>
            ))}
            <View style={styles.search}>
              <Icon name="Search" size={14} color={theme.colors.foregroundMuted} />
              <TextInput style={styles.searchInput} value={query} onChangeText={setQuery} placeholder="Filter by id, title, label, agent" placeholderTextColor={theme.colors.foregroundMuted} accessibilityLabel="Filter tasks" />
            </View>
          </View>
        ) : null}
        {composing && projectRoot ? <Composer theme={theme} styles={styles} onAdd={async (title, priority) => { const added = await onAdd(title, priority); if (added) setComposing(false); return added; }} /> : null}
      </View>
      {error ? <Text style={[styles.danger, styles.pad]}>{error}</Text> : null}
      {tasks === null && !error ? <Text style={[styles.muted, styles.pad]}>Loading tasks…</Text> : null}
      {tasks !== null && projectRoot === null ? <Text style={[styles.muted, styles.pad]}>{directory} is not an ALP project. Run alp init to start one.</Text> : null}
      {projectRoot && tasks ? (
        <View style={styles.body}>
          {!task || split ? (
            <View style={[styles.pane, split ? styles.paneList : null]}>
              {unreadable ? <Text style={[styles.warning, styles.pad]}>{unreadable} unreadable task {unreadable === 1 ? 'file' : 'files'} in {projectRoot}/.alp/tasks</Text> : null}
              {!tasks.length ? <Empty styles={styles} text="No tasks yet. Add one here, with alp task add, or ask main to plan the work." /> : null}
              {tasks.length && !shown.length ? <Empty styles={styles} text="No tasks match." /> : null}
              {shown.length && view === 'list' ? <ListView theme={theme} styles={styles} tasks={shown} selected={selected} onOpen={open} onAction={onAction} /> : null}
              {shown.length && view === 'board' ? <BoardView theme={theme} styles={styles} tasks={shown} onOpen={open} /> : null}
              {view === 'epics' && tasks.length ? <EpicsView theme={theme} styles={styles} tasks={tasks} shown={shown} onOpen={open} /> : null}
            </View>
          ) : null}
          {detail ? <View style={[styles.pane, split ? styles.paneDetail : null]}>{detail}</View> : null}
        </View>
      ) : null}
    </View>
  );
}

function Segmented({ theme, styles, value, options, onChange }: { theme: PluginTheme; styles: Styles; value: string; options: Array<{ key: string; label: string; icon: string }>; onChange(key: string): void }) {
  return (
    <View style={styles.segmented}>
      {options.map(option => {
        const on = option.key === value;
        return (
          <Pressable key={option.key} accessibilityRole="tab" accessibilityLabel={option.label} accessibilityState={{ selected: on }} onPress={() => onChange(option.key)} style={[styles.segment, on ? styles.segmentOn : null]}>
            <Icon name={option.icon} size={13} color={on ? theme.colors.foreground : theme.colors.foregroundMuted} />
            <Text style={on ? styles.segmentTextOn : styles.segmentText}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function IconButton({ theme, icon, label, onPress, primary }: { theme: PluginTheme; icon: string; label: string; onPress(): void; primary?: boolean }) {
  const { colors } = theme;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
      style={state => ({ padding: 7, borderRadius: 8, backgroundColor: primary ? colors.accent : hovered(state) ? colors.surface2 : 'transparent' })}>
      <Icon name={icon} size={15} color={primary ? colors.accentForeground : colors.foregroundMuted} />
    </Pressable>
  );
}

function Composer({ theme, styles, onAdd }: { theme: PluginTheme; styles: Styles; onAdd(title: string, priority: number): Promise<boolean> }) {
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState(2);
  const submit = async () => { const text = title.trim(); if (text && await onAdd(text, priority)) setTitle(''); };
  return (
    <View style={styles.composer}>
      <TextInput style={styles.input} value={title} onChangeText={setTitle} onSubmitEditing={submit} placeholder="Add a task for main" placeholderTextColor={theme.colors.foregroundMuted} accessibilityLabel="New task title" autoFocus />
      <View style={styles.priorities}>
        {PRIORITIES.map(value => (
          <Pressable key={value} accessibilityRole="button" accessibilityLabel={`Priority ${value}`} onPress={() => setPriority(value)} style={[styles.chip, value === priority ? styles.chipOn : null]}>
            <Text style={value === priority ? styles.chipTextOn : styles.chipText}>P{value}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable accessibilityRole="button" onPress={submit} style={styles.button}><Text style={styles.buttonText}>Add</Text></Pressable>
    </View>
  );
}

function Empty({ styles, text }: { styles: Styles; text: string }) {
  return <View style={styles.empty}><Text style={styles.muted}>{text}</Text></View>;
}

/** A priority badge: P0 and P1 stand out. */
function Priority({ theme, value }: { theme: PluginTheme; value: number }) {
  const { colors } = theme;
  const color = value === 0 ? colors.statusDanger : value === 1 ? colors.statusWarning : colors.foregroundMuted;
  return <View style={{ alignSelf: 'flex-start', borderRadius: 4, borderWidth: 1, borderColor: value <= 1 ? color : colors.border, paddingHorizontal: 4 }}><Text style={{ color, fontSize: 10.5, fontWeight: '600', fontVariant: ['tabular-nums'] }}>P{value}</Text></View>;
}

function StateDot({ theme, task }: { theme: PluginTheme; task: TaskRow }) {
  const { colors } = theme;
  const state = stateOf(task);
  const color = state === 'approve' ? colors.statusWarning : state === 'review' ? colors.accent : state === 'progress' ? colors.statusWarning : state === 'ready' ? colors.statusSuccess : state === 'blocked' ? colors.statusDanger : colors.border;
  // In progress is a ring, like a half-done circle; closed is hollow.
  const ring = state === 'progress' || state === 'closed';
  return <View accessibilityLabel={STATE_LABELS[state]} style={{ width: 9, height: 9, borderRadius: 5, borderWidth: ring ? 2 : 0, borderColor: color, backgroundColor: ring ? 'transparent' : color }} />;
}

/** One line per task, as bv shows it: state, type, priority, id, title, then age and assignee. */
function TaskLine({ theme, styles, task, selected, onOpen }: { theme: PluginTheme; styles: Styles; task: TaskRow; selected: boolean; onOpen(id: string): void }) {
  const meta = [
    task.blockedBy?.length ? `after ${task.blockedBy.join(', ')}` : '',
    // Gates waiting for the user show with their Approve instead.
    task.waits?.length && !task.approvals?.length ? `waits on ${task.waits.join('; ')}` : '',
    task.parent ? `in ${task.parent}` : '',
  ].filter(Boolean).join(' · ');
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${task.id}`} onPress={() => onOpen(task.id)} style={state => [styles.line, selected ? styles.lineOn : hovered(state) ? styles.lineHover : null]}>
      <View style={styles.lineTop}>
        <StateDot theme={theme} task={task} />
        <Icon name={TYPE_ICONS[task.type] ?? 'SquareCheck'} size={13} color={theme.colors.foregroundMuted} />
        <Priority theme={theme} value={task.priority} />
        <Text style={styles.id}>{task.id}</Text>
        <Text style={styles.lineTitle} numberOfLines={1}>{task.title}</Text>
        {task.assignee ? <Text style={styles.assignee} numberOfLines={1}>@{task.assignee}</Text> : null}
        <Text style={styles.age}>{age(task.status === 'closed' ? task.closed?.at : task.updatedAt)}</Text>
      </View>
      {meta || task.labels?.length ? (
        <View style={styles.lineMeta}>
          {meta ? <Text style={styles.small} numberOfLines={1}>{meta}</Text> : null}
          {(task.labels ?? []).map(label => <Text key={label} style={styles.label}>#{label}</Text>)}
        </View>
      ) : null}
    </Pressable>
  );
}

const SECTION_ICONS: Record<string, string> = { approve: 'Hand', review: 'Eye', progress: 'LoaderCircle', ready: 'CircleCheck', waiting: 'CircleSlash', epics: 'Target', closed: 'CircleDashed' };

/** The list: grouped the way the user acts on tasks, each group collapsible. */
function ListView({ theme, styles, tasks, selected, onOpen, onAction }: { theme: PluginTheme; styles: Styles; tasks: TaskRow[]; selected: string | null; onOpen(id: string): void; onAction(action: Action): void }) {
  const sections = useMemo(() => boardSections(tasks), [tasks]);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  return (
    <ScrollView contentContainerStyle={styles.listContent}>
      {sections.map(section => {
        const collapsed = hidden[section.key] ?? false;
        return (
          <View key={section.key} style={styles.group}>
            <Pressable accessibilityRole="button" accessibilityLabel={`${collapsed ? 'Show' : 'Hide'} ${section.title}`} onPress={() => setHidden(current => ({ ...current, [section.key]: !collapsed }))} style={styles.groupHeader}>
              <Icon name={collapsed ? 'ChevronRight' : 'ChevronDown'} size={13} color={theme.colors.foregroundMuted} />
              <Icon name={SECTION_ICONS[section.key] ?? 'Circle'} size={13} color={theme.colors.foregroundMuted} />
              <Text style={styles.groupTitle}>{section.title}</Text>
              <Text style={styles.groupCount}>{section.tasks.length}</Text>
            </Pressable>
            {!collapsed ? section.tasks.map(task => (
              <View key={`${section.key}-${task.id}`}>
                <TaskLine theme={theme} styles={styles} task={task} selected={task.id === selected} onOpen={onOpen} />
                {section.key === 'approve' ? task.approvals!.map(approval => (
                  <View key={approval.gate} style={styles.inlineAction}>
                    <Text style={styles.small} numberOfLines={2}>{approval.note || 'Waiting for your approval'}</Text>
                    <SmallButton styles={styles} label="Approve" primary onPress={() => onAction({ id: task.id, action: 'approve', gate: approval.gate })} />
                  </View>
                )) : null}
              </View>
            )) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

const COLUMNS: Array<{ key: ReturnType<typeof stateOf>; title: string }> = [
  { key: 'approve', title: 'Needs approval' }, { key: 'blocked', title: 'Blocked' }, { key: 'ready', title: 'Ready' },
  { key: 'progress', title: 'In progress' }, { key: 'review', title: 'In review' }, { key: 'closed', title: 'Closed' },
];

/** The board: a column per state, as beads-ui shows it; epics stay in the Epics view. */
function BoardView({ theme, styles, tasks, onOpen }: { theme: PluginTheme; styles: Styles; tasks: TaskRow[]; onOpen(id: string): void }) {
  const columns = COLUMNS.map(column => ({ ...column, tasks: tasks.filter(task => task.type !== 'epic' && stateOf(task) === column.key) })).filter(column => column.tasks.length || ['blocked', 'ready', 'progress'].includes(column.key));
  return (
    <ScrollView horizontal contentContainerStyle={styles.board}>
      {columns.map(column => (
        <View key={column.key} style={styles.column}>
          <View style={styles.columnHeader}>
            <StateDot theme={theme} task={{ status: column.key === 'closed' ? 'closed' : column.key === 'review' ? 'review' : column.key === 'progress' ? 'in_progress' : 'open', ready: column.key === 'ready', approvals: column.key === 'approve' ? [{ gate: '', note: '' }] : undefined } as TaskRow} />
            <Text style={styles.columnTitle}>{column.title}</Text>
            <Text style={styles.groupCount}>{column.tasks.length}</Text>
          </View>
          <ScrollView contentContainerStyle={styles.columnBody}>
            {column.tasks.map(task => (
              <Pressable key={task.id} accessibilityRole="button" accessibilityLabel={`Open ${task.id}`} onPress={() => onOpen(task.id)} style={state => [styles.card, hovered(state) ? styles.cardHover : null, column.key === 'blocked' ? styles.cardBlocked : column.key === 'ready' ? styles.cardReady : null]}>
                <View style={styles.lineTop}>
                  <Icon name={TYPE_ICONS[task.type] ?? 'SquareCheck'} size={12} color={theme.colors.foregroundMuted} />
                  <Priority theme={theme} value={task.priority} />
                  <Text style={styles.id}>{task.id}</Text>
                  <View style={{ flex: 1 }} />
                  <Text style={styles.age}>{age(task.updatedAt)}</Text>
                </View>
                <Text style={styles.cardTitle} numberOfLines={3}>{task.title}</Text>
                {task.assignee ? <Text style={styles.assignee} numberOfLines={1}>@{task.assignee}</Text> : null}
                {task.blockedBy?.length ? <Text style={styles.blocked} numberOfLines={1}>after {task.blockedBy.join(', ')}</Text> : null}
                {task.labels?.length ? <View style={styles.cardLabels}>{task.labels.map(label => <Text key={label} style={styles.label}>#{label}</Text>)}</View> : null}
              </Pressable>
            ))}
            {!column.tasks.length ? <Text style={[styles.small, styles.pad]}>Nothing here</Text> : null}
          </ScrollView>
        </View>
      ))}
    </ScrollView>
  );
}

/** Epics with how far along they are, and their children as a tree. */
function EpicsView({ theme, styles, tasks, shown, onOpen }: { theme: PluginTheme; styles: Styles; tasks: TaskRow[]; shown: TaskRow[]; onOpen(id: string): void }) {
  const epics = shown.filter(task => task.type === 'epic' || task.progress);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  if (!epics.length) return <Empty styles={styles} text="No epics here. An epic is a task other tasks name as their parent." />;
  return (
    <ScrollView contentContainerStyle={styles.listContent}>
      {epics.map(epic => {
        const children = tasks.filter(task => task.parent === epic.id);
        const done = epic.progress?.done ?? 0;
        const total = epic.progress?.total ?? 0;
        const expanded = opened[epic.id] ?? epic.status !== 'closed';
        return (
          <View key={epic.id} style={styles.epic}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Open ${epic.id}`} onPress={() => onOpen(epic.id)} style={styles.lineTop}>
              <StateDot theme={theme} task={epic} />
              <Icon name="Target" size={13} color={theme.colors.foregroundMuted} />
              <Priority theme={theme} value={epic.priority} />
              <Text style={styles.id}>{epic.id}</Text>
              <Text style={styles.lineTitle} numberOfLines={1}>{epic.title}</Text>
              <Text style={styles.progressText}>{done}/{total}</Text>
            </Pressable>
            <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${total ? Math.round((done / total) * 100) : 0}%` }]} /></View>
            {children.length ? (
              <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? 'Hide' : 'Show'} the tasks of ${epic.id}`} onPress={() => setOpened(current => ({ ...current, [epic.id]: !expanded }))} style={styles.treeToggle}>
                <Icon name={expanded ? 'ChevronDown' : 'ChevronRight'} size={12} color={theme.colors.foregroundMuted} />
                <Text style={styles.small}>{children.length} {children.length === 1 ? 'task' : 'tasks'}</Text>
              </Pressable>
            ) : null}
            {expanded ? (
              <View style={styles.tree}>
                {children.map(child => <TaskLine key={child.id} theme={theme} styles={styles} task={child} selected={false} onOpen={onOpen} />)}
              </View>
            ) : null}
          </View>
        );
      })}
    </ScrollView>
  );
}

function SmallButton({ styles, label, onPress, primary, danger }: { styles: Styles; label: string; onPress(): void; primary?: boolean; danger?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={[styles.smallButton, primary ? styles.smallButtonPrimary : null, danger ? styles.smallButtonDanger : null]}>
      <Text style={primary ? styles.smallButtonTextPrimary : danger ? styles.smallButtonTextDanger : styles.smallButtonText}>{label}</Text>
    </Pressable>
  );
}

/** A task's detail, as bv's detail pane: its fields, description, links, handoff and actions. */
export function TaskDetail({ theme, styles, task, tasks, onBack, onOpen, onAction }: { theme: PluginTheme; styles: Styles; task: TaskRow; tasks: TaskRow[]; onBack(): void; onOpen(id: string): void; onAction(action: Action): void }) {
  const state = stateOf(task);
  const children = tasks.filter(entry => entry.parent === task.id);
  const blocks = tasks.filter(entry => entry.blockedBy?.includes(task.id) && entry.status !== 'closed');
  const field = (label: string, value: React.ReactNode) => (
    <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><View style={styles.fieldValue}>{typeof value === 'string' ? <Text style={styles.text}>{value}</Text> : value}</View></View>
  );
  const link = (id: string) => <Pressable key={id} accessibilityRole="link" accessibilityLabel={`Open ${id}`} onPress={() => onOpen(id)}><Text style={styles.link}>{id}</Text></Pressable>;
  return (
    <ScrollView contentContainerStyle={styles.detail}>
      <View style={styles.detailHeader}>
        <IconButton theme={theme} icon="ArrowLeft" label="Back to the list" onPress={onBack} />
        <Text style={styles.id}>{task.id}</Text>
        <View style={styles.statePill}><StateDot theme={theme} task={task} /><Text style={styles.small}>{STATE_LABELS[state]}</Text></View>
      </View>
      <Text style={styles.detailTitle}>{task.title}</Text>
      <View style={styles.fields}>
        {field('Type', <View style={styles.inline}><Icon name={TYPE_ICONS[task.type] ?? 'SquareCheck'} size={13} color={theme.colors.foregroundMuted} /><Text style={styles.text}>{task.type}</Text></View>)}
        {field('Priority', <Priority theme={theme} value={task.priority} />)}
        {task.assignee ? field('Assignee', `@${task.assignee}`) : null}
        {task.parent ? field('Parent', link(task.parent)) : null}
        {task.blockedBy?.length ? field('Blocked by', <View style={styles.inline}>{task.blockedBy.map(link)}</View>) : null}
        {blocks.length ? field('Blocks', <View style={styles.inline}>{blocks.map(entry => link(entry.id))}</View>) : null}
        {task.waits?.length ? field('Waits on', task.waits.join('; ')) : null}
        {task.labels?.length ? field('Labels', <View style={styles.inline}>{task.labels.map(label => <Text key={label} style={styles.label}>#{label}</Text>)}</View>) : null}
        {task.paths?.length ? field('Paths', task.paths.join(', ')) : null}
        {task.progress ? field('Progress', `${task.progress.done} of ${task.progress.total} closed`) : null}
        {task.createdAt ? field('Created', `${age(task.createdAt)} ago`) : null}
        {field('Updated', `${age(task.updatedAt)} ago`)}
      </View>
      {task.description ? <View style={styles.box}><Text style={styles.boxTitle}>Description</Text><Text style={styles.text}>{task.description}</Text></View> : null}
      {task.handoff ? <View style={styles.box}><Text style={styles.boxTitle}>Handoff · {task.handoff.outcome}{task.handoff.agent ? ` from ${task.handoff.agent}` : ''}</Text><Text style={styles.text}>{task.handoff.summary}</Text></View> : null}
      {task.closed ? <View style={styles.box}><Text style={styles.boxTitle}>Closed · {task.closed.reason}</Text>{task.closed.summary ? <Text style={styles.text}>{task.closed.summary}</Text> : null}</View> : null}
      {children.length ? (
        <View style={styles.box}>
          <Text style={styles.boxTitle}>Tasks · {children.filter(child => child.status === 'closed').length}/{children.length} closed</Text>
          {children.map(child => <TaskLine key={child.id} theme={theme} styles={styles} task={child} selected={false} onOpen={onOpen} />)}
        </View>
      ) : null}
      <View style={styles.detailActions}>
        {(task.approvals ?? []).map(approval => <SmallButton key={approval.gate} styles={styles} primary label={`Approve${approval.note ? `: ${approval.note.slice(0, 40)}` : ''}`} onPress={() => onAction({ id: task.id, action: 'approve', gate: approval.gate })} />)}
        {state === 'review' ? <SmallButton styles={styles} primary label="Accept and close" onPress={() => onAction({ id: task.id, action: 'close' })} /> : null}
        {task.status !== 'closed' && state !== 'review' && task.type !== 'epic' ? <SmallButton styles={styles} label="Close" onPress={() => onAction({ id: task.id, action: 'close' })} /> : null}
        {task.status === 'closed' ? <SmallButton styles={styles} label="Reopen" onPress={() => onAction({ id: task.id, action: 'reopen' })} /> : null}
      </View>
    </ScrollView>
  );
}

type Styles = ReturnType<typeof makeStyles>;
function makeStyles(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  const mono = { fontFamily: 'monospace', fontVariant: ['tabular-nums' as const] };
  return {
    screen: { flex: 1, backgroundColor: colors.surface0 },
    pad: { paddingHorizontal: compact ? 12 : 16, paddingVertical: 8 },
    toolbar: { paddingHorizontal: compact ? 12 : 16, paddingTop: 12, paddingBottom: 10, gap: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
    toolbarRow: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, flexWrap: 'wrap' as const },
    title: { color: colors.foreground, fontSize: 15, fontWeight: '600' as const },
    count: { color: colors.foregroundMuted, fontSize: 12, marginLeft: 4 },
    segmented: { flexDirection: 'row' as const, backgroundColor: colors.surface1, borderRadius: 8, borderWidth: 1, borderColor: colors.border, padding: 2 },
    segment: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 5, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
    segmentOn: { backgroundColor: colors.surface0, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 2 },
    segmentText: { color: colors.foregroundMuted, fontSize: 12 },
    segmentTextOn: { color: colors.foreground, fontSize: 12, fontWeight: '600' as const },
    filter: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
    filterOn: { backgroundColor: colors.foreground, borderColor: colors.foreground },
    filterText: { color: colors.foreground, fontSize: 12 },
    filterTextOn: { color: colors.surface0, fontSize: 12, fontWeight: '600' as const },
    filterCount: { opacity: 0.6, fontSize: 11 },
    search: { flex: 1, minWidth: 160, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 8, backgroundColor: colors.surface1 },
    searchInput: { flex: 1, minWidth: 0, color: colors.foreground, fontSize: 12.5, paddingVertical: 6 },
    composer: { flexDirection: compact ? 'column' as const : 'row' as const, gap: 8, alignItems: compact ? 'stretch' as const : 'center' as const },
    input: { flex: compact ? undefined : 1, minWidth: 0, color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: colors.surface1 },
    priorities: { flexDirection: 'row' as const, gap: 4 },
    chip: { paddingHorizontal: 7, paddingVertical: 5, borderRadius: 6, borderWidth: 1, borderColor: colors.border },
    chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    chipText: { color: colors.foregroundMuted, fontSize: 12 },
    chipTextOn: { color: colors.accentForeground, fontSize: 12 },
    button: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: colors.accent },
    buttonText: { color: colors.accentForeground, fontWeight: '600' as const },
    body: { flex: 1, flexDirection: 'row' as const },
    pane: { flex: 1, minWidth: 0 },
    paneList: { flex: 2, borderRightWidth: 1, borderRightColor: colors.border },
    paneDetail: { flex: 3 },
    empty: { margin: 16, borderWidth: 1, borderStyle: 'dashed' as const, borderColor: colors.border, borderRadius: 10, padding: 24, alignItems: 'center' as const },
    listContent: { paddingVertical: 6 },
    group: { marginBottom: 4 },
    groupHeader: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, paddingHorizontal: compact ? 10 : 14, paddingVertical: 7 },
    groupTitle: { color: colors.foregroundMuted, fontSize: 11.5, fontWeight: '600' as const, textTransform: 'uppercase' as const, letterSpacing: 0.4 },
    groupCount: { color: colors.foregroundMuted, fontSize: 11, opacity: 0.8 },
    line: { paddingHorizontal: compact ? 10 : 14, paddingVertical: 7, gap: 3, borderLeftWidth: 2, borderLeftColor: 'transparent' },
    lineOn: { backgroundColor: colors.surface2, borderLeftColor: colors.accent },
    lineHover: { backgroundColor: colors.surface1 },
    lineTop: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 7 },
    lineTitle: { flex: 1, minWidth: 0, color: colors.foreground, fontSize: 13 },
    lineMeta: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 6, paddingLeft: 16 },
    id: { color: colors.foregroundMuted, fontSize: 11.5, ...mono },
    age: { color: colors.foregroundMuted, fontSize: 11, ...mono },
    assignee: { color: colors.accent, fontSize: 11.5, maxWidth: 110 },
    label: { color: colors.foregroundMuted, fontSize: 11, backgroundColor: colors.surface2, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
    inlineAction: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 10, paddingLeft: compact ? 26 : 30, paddingRight: 14, paddingBottom: 8 },
    board: { padding: 12, gap: 10, alignItems: 'flex-start' as const },
    column: { width: 248, backgroundColor: colors.surface1, borderRadius: 10, borderWidth: 1, borderColor: colors.border, maxHeight: 640 },
    columnHeader: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 7, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
    columnTitle: { flex: 1, color: colors.foreground, fontSize: 12.5, fontWeight: '600' as const },
    columnBody: { padding: 8, gap: 8 },
    card: { backgroundColor: colors.surface0, borderRadius: 8, borderWidth: 1, borderColor: colors.border, borderLeftWidth: 3, padding: 10, gap: 5 },
    cardHover: { borderColor: colors.foregroundMuted },
    cardBlocked: { borderLeftColor: colors.statusDanger },
    cardReady: { borderLeftColor: colors.statusSuccess },
    cardLabels: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 6 },
    blocked: { color: colors.statusDanger, fontSize: 11.5 },
    cardTitle: { color: colors.foreground, fontSize: 13, lineHeight: 18 },
    epic: { marginHorizontal: compact ? 10 : 14, marginVertical: 6, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1, gap: 8 },
    progressTrack: { height: 6, borderRadius: 3, backgroundColor: colors.surface2, overflow: 'hidden' as const },
    progressFill: { height: 6, borderRadius: 3, backgroundColor: colors.statusSuccess },
    progressText: { color: colors.foregroundMuted, fontSize: 11.5, ...mono },
    treeToggle: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 4 },
    tree: { marginLeft: 6, borderLeftWidth: 1, borderLeftColor: colors.border, backgroundColor: colors.surface0, borderRadius: 6 },
    detail: { padding: compact ? 12 : 18, gap: 14 },
    detailHeader: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 },
    statePill: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
    detailTitle: { color: colors.foreground, fontSize: 17, fontWeight: '600' as const, lineHeight: 23 },
    fields: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, overflow: 'hidden' as const },
    field: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
    fieldLabel: { width: 84, color: colors.foregroundMuted, fontSize: 12 },
    fieldValue: { flex: 1, minWidth: 0 },
    inline: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, flexWrap: 'wrap' as const },
    box: { borderRadius: 10, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, padding: 12, gap: 6 },
    boxTitle: { color: colors.foregroundMuted, fontSize: 11.5, fontWeight: '600' as const, textTransform: 'uppercase' as const, letterSpacing: 0.4 },
    detailActions: { flexDirection: 'row' as const, gap: 8, flexWrap: 'wrap' as const },
    smallButton: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 7, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 },
    smallButtonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
    smallButtonDanger: { borderColor: colors.statusDanger },
    smallButtonText: { color: colors.foreground, fontSize: 12.5, fontWeight: '500' as const },
    smallButtonTextPrimary: { color: colors.accentForeground, fontSize: 12.5, fontWeight: '600' as const },
    smallButtonTextDanger: { color: colors.statusDanger, fontSize: 12.5 },
    text: { color: colors.foreground, fontSize: 13, lineHeight: 19 },
    small: { color: colors.foregroundMuted, fontSize: 12 },
    muted: { color: colors.foregroundMuted, fontSize: 13 },
    danger: { color: colors.statusDanger, fontSize: 13 },
    warning: { color: colors.statusWarning, fontSize: 12 },
    link: { color: colors.accent, fontSize: 13, ...mono },
  };
}
