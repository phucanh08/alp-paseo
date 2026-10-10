import type { PaseoAgent, PaseoAgentListResult } from '@getpaseo/client';
import type { PluginButton, PluginButtonMenuEntry, PluginButtonRegistration, PluginClientContext, PluginOpenScreenInput } from '@getpaseo/plugin/client';
import { tasksList, type TaskRow } from '../shared/tasks';
import { stateOf } from './tasks-panel';

/**
 * The Tasks pill in the composer of each ALP agent. On a phone the workspace's "+" tab,
 * and with it the Tasks panel, is out of reach, but the composer is not. The pill shows
 * how many tasks are open; its menu lists them, what waits for the user first, and
 * opens the Tasks screen on one of them or on the whole board. When the agent's session
 * worked on tasks, the pill counts those done of them and lists them first: ALP keeps
 * them from Paseo's own todo pill, which opens nothing (ALPD §55).
 *
 * A composer pill belongs to one agent, so the plugin follows the host's agents
 * (agents.list with a subscription) and polls the tasks of each project with a pill.
 */

export const TASKS_SCREEN = 'alp-tasks';
/** Slower than an open board: the pills are there whether or not anyone looks. */
const POLL_MS = 20_000;
/** Tasks in the menu; the rest are under All tasks. */
const MENU_LIMIT = 8;
const PAGE = 200;

type Board = { projectRoot: string | null; tasks: TaskRow[]; sessions?: Record<string, string[]> };
/** sessions: the ids the provider may know the agent's session by. */
type Agent = { id: string; workspaceId: string; cwd: string; sessions: string[] };
type Pill = { agent: Agent; directory: string; registration: PluginButtonRegistration; signature: string };

/** Opens the Tasks screen: on the board of the project at directory, or on one task. */
export function tasksScreen(workspaceId: string, directory: string, taskId?: string): PluginOpenScreenInput {
  return { screenId: TASKS_SCREEN, params: { workspaceId, directory, ...(taskId ? { taskId } : {}) } };
}

const ORDER = ['approve', 'review', 'progress', 'ready', 'blocked'] as const;
type Shown = (typeof ORDER)[number];
const STATES: Record<Shown | 'closed', { label: string; icon: string }> = {
  approve: { label: 'Approve', icon: 'Hand' }, review: { label: 'Review', icon: 'Eye' }, progress: { label: 'In progress', icon: 'LoaderCircle' },
  ready: { label: 'Ready', icon: 'CircleCheck' }, blocked: { label: 'Blocked', icon: 'CircleSlash' }, closed: { label: 'Done', icon: 'CheckCheck' },
};

/** The tasks the agent's session worked on, in the order it took them up. */
export function sessionWork(board: Board | null, sessions: string[] = []) {
  const ids = sessions.map(id => board?.sessions?.[id]).find(Boolean) ?? [];
  const index = new Map((board?.tasks ?? []).map(task => [task.id, task]));
  return ids.flatMap(id => index.has(id) ? [{ task: index.get(id)!, state: stateOf(index.get(id)!) }] : []);
}

/** The open tasks of the menu, what waits for the user first; epics stay on the board. */
export function menuTasks(tasks: TaskRow[]) {
  return tasks.filter(task => task.status !== 'closed' && task.type !== 'epic')
    .map(task => ({ task, state: stateOf(task) as Shown }))
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.task.priority - b.task.priority || a.task.id.localeCompare(b.task.id));
}

/** The pill for a board not yet read (null), or read: hidden outside an ALP project. */
export function taskButton(board: Board | null, open: (taskId?: string) => void, sessions: string[] = []): PluginButton {
  const listed = board ? menuTasks(board.tasks) : [];
  const worked = sessionWork(board, sessions);
  const done = worked.filter(entry => entry.state === 'closed').length;
  const mine = new Set(worked.map(entry => entry.task.id));
  // This session's tasks first, then the project's other open tasks.
  const shown = [...worked, ...listed.filter(entry => !mine.has(entry.task.id))];
  // Menu ids are [a-z0-9-], which task ids such as t-0007.1 are not.
  const entry = ({ task, state }: { task: TaskRow; state: Shown | 'closed' }, index: number): PluginButtonMenuEntry => ({
    kind: 'item', id: `task-${index}`, title: `${STATES[state].label} · ${task.title}`, icon: STATES[state].icon,
    behavior: { kind: 'action', onPress: () => open(task.id) },
  });
  const items: PluginButtonMenuEntry[] = shown.slice(0, MENU_LIMIT).map(entry);
  if (worked.length && items.length > worked.length) items.splice(worked.length, 0, { kind: 'separator', id: 'session-end' });
  if (items.length) items.push({ kind: 'separator', id: 'tasks-end' });
  const more = shown.length - MENU_LIMIT;
  items.push({ kind: 'item', id: 'all-tasks', title: more > 0 ? `All tasks (${more} more)` : 'All tasks', icon: 'ListTodo', behavior: { kind: 'action', onPress: () => open() } });
  return {
    title: worked.length ? `ALP tasks: ${done} of ${worked.length} done in this session, ${listed.length} open` : listed.length ? `ALP tasks: ${listed.length} open` : 'ALP tasks',
    icon: 'ListTodo',
    label: worked.length ? `Tasks · ${done}/${worked.length}` : listed.length ? `Tasks · ${listed.length}` : 'Tasks',
    visible: board?.projectRoot !== null,
    behavior: { kind: 'menu', items },
  };
}

/** What the pill shows, to replace it only when that changes. */
function signature(board: Board | null, sessions: string[]) {
  return JSON.stringify(board && [board.projectRoot !== null, [...sessionWork(board, sessions), ...menuTasks(board.tasks)].map(({ task, state }) => [task.id, state, task.title])]);
}

/** Adds the Tasks pill to the composer of every ALP agent of this host, and keeps the pills current. */
export function addTaskPills(client: PluginClientContext) {
  const agents = new Map<string, Agent>();
  const directories = new Map<string, Promise<string>>();
  const boards = new Map<string, Board>();
  const pills = new Map<string, Pill>();
  let subscription: { release(): Promise<void> } | null = null;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let again = false;

  const opener = (agent: Agent, directory: string) => (taskId?: string) => client.openScreen(tasksScreen(agent.workspaceId, directory, taskId));

  // The workspace's directory, as the panel reads it; a worktree workspace has its own
  // .alp/tasks. The agent's cwd when the host cannot say.
  const directoryOf = (agent: Agent) => {
    let found = directories.get(agent.workspaceId);
    if (!found) {
      found = client.paseo.workspaces.ref(agent.workspaceId).refresh()
        .then(workspace => workspace?.workspaceDirectory || workspace?.projectRootPath || agent.cwd)
        .catch(() => { directories.delete(agent.workspaceId); return agent.cwd; });
      directories.set(agent.workspaceId, found);
    }
    return found;
  };

  const show = async (agent: Agent) => {
    const directory = await directoryOf(agent);
    if (stopped || pills.has(agent.id) || agents.get(agent.id) !== agent) return;
    const board = boards.get(directory) ?? null;
    try {
      const registration = client.addComposerPill({ id: 'alp-tasks', workspaceId: agent.workspaceId, agentId: agent.id, button: taskButton(board, opener(agent, directory), agent.sessions) });
      pills.set(agent.id, { agent, directory, registration, signature: signature(board, agent.sessions) });
    } catch {
      return;
    }
    if (!board) void poll();
  };

  const hide = (id: string) => {
    agents.delete(id);
    pills.get(id)?.registration.remove();
    pills.delete(id);
  };

  // ALP agents only: they run in an ALP project, which the provider creates.
  const accept = (snapshot: PaseoAgent) => {
    const known = agents.get(snapshot.id);
    if (snapshot.provider !== 'alp' || !snapshot.workspaceId || snapshot.archivedAt) {
      if (known) hide(snapshot.id);
      return;
    }
    // The provider knows a session by the id in its persistence handle, which is not the agent's id.
    const sessions = [snapshot.persistence?.sessionId, snapshot.id].filter((id): id is string => Boolean(id));
    if (known?.workspaceId === snapshot.workspaceId && known.sessions.join() === sessions.join()) return;
    if (known) hide(snapshot.id);
    const agent = { id: snapshot.id, workspaceId: snapshot.workspaceId, cwd: snapshot.cwd, sessions };
    agents.set(agent.id, agent);
    void show(agent);
  };

  // Every agent the host lists, page by page; agents it no longer lists lose their pill.
  const load = async (page: Pick<PaseoAgentListResult, 'entries' | 'pageInfo'>) => {
    const seen = new Set<string>();
    for (let current = page; ;) {
      for (const { agent } of current.entries) { seen.add(agent.id); accept(agent); }
      const cursor = current.pageInfo.nextCursor;
      if (!current.pageInfo.hasMore || !cursor || stopped) break;
      current = await client.paseo.agents.list({ scope: 'active', page: { limit: PAGE, cursor } });
    }
    for (const id of [...agents.keys()]) if (!seen.has(id)) hide(id);
  };

  const watch = async () => {
    try {
      const first = await client.paseo.agents.list({ scope: 'active', page: { limit: PAGE }, subscribe: {} });
      if (stopped) { void first.subscription.release().catch(() => {}); return; }
      subscription = first.subscription;
      // The snapshot comes at once, and again after each reconnect; updates in between.
      first.subscription.subscribe({
        snapshot: snapshot => { void load(snapshot).catch(() => {}); },
        update: message => {
          if (message.type !== 'agent_update') return;
          if (message.payload.kind === 'remove') hide(message.payload.agentId);
          else accept(message.payload.agent);
        },
      });
    } catch {
      if (!stopped) retry = setTimeout(() => void watch(), POLL_MS);
    }
  };

  // One read per project, however many agents' pills show it. A failed read keeps the last board.
  const poll = async () => {
    if (polling) { again = true; return; }
    polling = true;
    try {
      const shown = new Set([...pills.values()].map(pill => pill.directory));
      for (const directory of shown) {
        if (stopped) return;
        try { boards.set(directory, await client.rpc(tasksList, { directory })); }
        catch { continue; }
        for (const pill of pills.values()) if (pill.directory === directory) render(pill);
      }
      for (const directory of [...boards.keys()]) if (!shown.has(directory)) boards.delete(directory);
    } finally {
      polling = false;
      if (again && !stopped) { again = false; void poll(); }
    }
  };

  const render = (pill: Pill) => {
    const board = boards.get(pill.directory) ?? null;
    const next = signature(board, pill.agent.sessions);
    // A new behavior closes the menu if it is open, so an unchanged board leaves the pill alone.
    if (next === pill.signature) return;
    pill.signature = next;
    pill.registration.update(taskButton(board, opener(pill.agent, pill.directory), pill.agent.sessions));
  };

  const timer = setInterval(() => void poll(), POLL_MS);
  void watch();
  return () => {
    stopped = true;
    clearInterval(timer);
    if (retry !== undefined) clearTimeout(retry);
    for (const id of [...pills.keys()]) hide(id);
    void subscription?.release().catch(() => {});
  };
}
