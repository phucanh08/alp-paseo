import type { PluginTheme } from '@getpaseo/plugin';
import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from '@getpaseo/plugin/client';
import { ScrollView, useToast } from '@getpaseo/plugin/client/react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { boardSections, tasksAdd, tasksChange, tasksList, type TaskRow } from '../shared/tasks';

/** Plugin RPC has no server push, so the panel asks again while it is open. */
const POLL_MS = 5000;

type Action = { id: string; action: 'close' | 'reopen' | 'approve'; gate?: string };

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
    <TaskBoard
      theme={theme}
      compact={layout.compact}
      directory={directory}
      projectRoot={data?.projectRoot ?? null}
      tasks={data?.tasks ?? null}
      unreadable={data?.unreadable.length ?? 0}
      error={error}
      onAdd={onAdd}
      onAction={onAction}
      onRefresh={refresh}
    />
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
};

const PRIORITIES = [0, 1, 2, 3, 4];

/** What the panel shows; kept free of RPC so it renders from data alone. */
export function TaskBoard({ theme, compact, directory, projectRoot, tasks, unreadable, error, onAdd, onAction, onRefresh }: BoardProps) {
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState(2);
  const [showClosed, setShowClosed] = useState(false);
  const styles = useMemo(() => makeStyles(theme, compact), [theme, compact]);
  const sections = useMemo(() => tasks ? boardSections(tasks) : [], [tasks]);
  const submit = async () => {
    const text = title.trim();
    if (text && await onAdd(text, priority)) setTitle('');
  };

  if (!directory) return <View style={styles.screen}><Text style={styles.muted}>This panel needs a workspace.</Text></View>;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Tasks</Text>
        <Pressable accessibilityRole="button" onPress={onRefresh}><Text style={styles.link}>Refresh</Text></Pressable>
      </View>
      {error ? <Text style={styles.danger}>{error}</Text> : null}
      {tasks === null && !error ? <Text style={styles.muted}>Loading tasks…</Text> : null}
      {tasks !== null && projectRoot === null ? <Text style={styles.muted}>{directory} is not an ALP project. Run alp init to start one.</Text> : null}
      {projectRoot ? (
        <>
          <Text style={styles.muted}>{projectRoot}/.alp/tasks{unreadable ? ` · ${unreadable} unreadable ${unreadable === 1 ? 'file' : 'files'}` : ''}</Text>
          <View style={styles.addRow}>
            <TextInput
              style={styles.input}
              value={title}
              onChangeText={setTitle}
              onSubmitEditing={submit}
              placeholder="Add a task for main"
              placeholderTextColor={theme.colors.foregroundMuted}
              accessibilityLabel="New task title"
            />
            <View style={styles.priorities}>
              {PRIORITIES.map(value => (
                <Pressable key={value} accessibilityRole="button" accessibilityLabel={`Priority ${value}`} onPress={() => setPriority(value)} style={[styles.chip, value === priority ? styles.chipOn : null]}>
                  <Text style={value === priority ? styles.chipTextOn : styles.chipText}>P{value}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable accessibilityRole="button" onPress={submit} style={styles.button}><Text style={styles.buttonText}>Add</Text></Pressable>
          </View>
          {!sections.length ? <Text style={styles.muted}>No tasks yet. Add one here, with alp task add, or ask main to plan the work.</Text> : null}
          {sections.map(section => section.key === 'closed' && !showClosed ? (
            <Pressable key={section.key} accessibilityRole="button" onPress={() => setShowClosed(true)}>
              <Text style={styles.link}>Show {section.tasks.length} recently closed</Text>
            </Pressable>
          ) : (
            <View key={section.key} style={styles.section}>
              <Text style={styles.sectionTitle}>{section.title} · {section.tasks.length}</Text>
              {section.tasks.map(task => <TaskItem key={`${section.key}-${task.id}`} task={task} section={section.key} styles={styles} onAction={onAction} />)}
            </View>
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

function TaskItem({ task, section, styles, onAction }: { task: TaskRow; section: string; styles: ReturnType<typeof makeStyles>; onAction(action: Action): void }) {
  const meta = [
    `${task.type} · P${task.priority}`,
    task.assignee ? `with ${task.assignee}` : '',
    task.blockedBy?.length ? `after ${task.blockedBy.join(', ')}` : '',
    task.waits?.length && section !== 'approve' ? `waits on ${task.waits.join('; ')}` : '',
    task.parent ? `in ${task.parent}` : '',
  ].filter(Boolean).join(' · ');
  return (
    <View style={styles.row}>
      <Text style={styles.text}><Text style={styles.id}>{task.id}</Text>  {task.title}</Text>
      <Text style={styles.muted}>{meta}</Text>
      {section === 'review' && task.handoff ? <Text style={styles.text} numberOfLines={3}>Handoff {task.handoff.outcome}{task.handoff.agent ? ` from ${task.handoff.agent}` : ''}: {task.handoff.summary}</Text> : null}
      {section === 'closed' && task.closed ? <Text style={styles.muted} numberOfLines={2}>Closed {task.closed.reason}{task.closed.summary ? `: ${task.closed.summary}` : ''}</Text> : null}
      {section === 'approve' ? task.approvals!.map(approval => (
        <View key={approval.gate} style={styles.actions}>
          <Text style={styles.text}>{approval.note}</Text>
          <Pressable accessibilityRole="button" onPress={() => onAction({ id: task.id, action: 'approve', gate: approval.gate })} style={styles.button}><Text style={styles.buttonText}>Approve</Text></Pressable>
        </View>
      )) : null}
      {section === 'closed' ? (
        <View style={styles.actions}><Pressable accessibilityRole="button" onPress={() => onAction({ id: task.id, action: 'reopen' })}><Text style={styles.link}>Reopen</Text></Pressable></View>
      ) : section !== 'epics' && section !== 'approve' ? (
        <View style={styles.actions}><Pressable accessibilityRole="button" onPress={() => onAction({ id: task.id, action: 'close' })}><Text style={styles.link}>{section === 'review' ? 'Accept and close' : 'Close'}</Text></Pressable></View>
      ) : null}
    </View>
  );
}

function makeStyles(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  return {
    screen: { flex: 1, backgroundColor: colors.surface0 },
    content: { padding: compact ? 16 : 24, gap: 12 },
    header: { flexDirection: 'row' as const, justifyContent: 'space-between' as const, alignItems: 'center' as const },
    title: { color: colors.foreground, fontSize: 18, fontWeight: '600' as const },
    section: { gap: 8 },
    sectionTitle: { color: colors.foregroundMuted, fontSize: 12, fontWeight: '600' as const, textTransform: 'uppercase' as const, letterSpacing: 0.5 },
    row: { padding: 10, gap: 4, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 },
    id: { color: colors.foregroundMuted, fontVariant: ['tabular-nums' as const] },
    text: { color: colors.foreground },
    muted: { color: colors.foregroundMuted, fontSize: 12 },
    danger: { color: colors.statusDanger },
    link: { color: colors.accent, fontSize: 13 },
    actions: { flexDirection: 'row' as const, gap: 12, alignItems: 'center' as const, flexWrap: 'wrap' as const },
    addRow: { flexDirection: compact ? 'column' as const : 'row' as const, gap: 8, alignItems: compact ? 'stretch' as const : 'center' as const },
    input: { flex: compact ? undefined : 1, minWidth: 0, color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.surface1 },
    priorities: { flexDirection: 'row' as const, gap: 4 },
    chip: { paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6, borderWidth: 1, borderColor: colors.border },
    chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    chipText: { color: colors.foregroundMuted, fontSize: 12 },
    chipTextOn: { color: colors.accentForeground, fontSize: 12 },
    button: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: colors.accent },
    buttonText: { color: colors.accentForeground, fontWeight: '600' as const },
  };
}
