import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deriveAgentStateBucket, getWorkspaceStateBucketPriority } from '@getpaseo/protocol/agent-state-bucket';
import { normalizeWorkspaceLabelName, workspaceLabelKey, type WorkspaceLabelDefinition } from '@getpaseo/protocol/workspace-labels';
import type { AgentSnapshotPayload, SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import type { SessionSummary } from '../server.js';
import type { Handler } from './gateway.js';
import { checkoutCache, type CheckoutFacts } from './git.js';

/**
 * Paseo's projects and workspaces, kept by alpd (D31 step 6, ALPD §62). A project is a directory
 * the user opened; a workspace is a place in it where agents run, with the title, pin, labels and
 * archive the user gives it. ALP's sessions know only their directory, so the bridge keeps which
 * workspace each root belongs to, and puts a root it has not seen in the oldest open workspace of
 * its directory (making one if there is none). The ids are Paseo's (`prj_`, `wks_` and 16 hex),
 * stable across restarts in `<ALP home>/state/web-workspaces.json`.
 */

type Inbound<T extends SessionInboundMessage['type']> = Extract<SessionInboundMessage, { type: T }>;
type Outbound = SessionOutboundMessage;
type WorkspaceDescriptor = Extract<Outbound, { type: 'workspace_update' }>['payload'] extends infer P ? P extends { kind: 'upsert'; workspace: infer W } ? W : never : never;
type ProjectDescriptor = Extract<Outbound, { type: 'project.list.response' }>['payload']['projects'][number];
export type Placement = Extract<Outbound, { type: 'fetch_agents_response' }>['payload']['entries'][number]['project'];

type ProjectRecord = { id: string; root: string; customName?: string | null; addedAt: string; removedAt?: string | null };
type WorkspaceRecord = { id: string; projectId: string; directory: string; title?: string | null; pinnedAt?: string | null; labels: string[]; createdAt: string; archivedAt?: string | null; idempotencyKey?: string };
type Registry = {
  projects: ProjectRecord[];
  workspaces: WorkspaceRecord[];
  /** Root session id → workspace id. */
  sessions: Record<string, string>;
  labels: { generation: string; seq: number; catalog: WorkspaceLabelDefinition[] };
};

/** What the workspaces need of the agents (agents.ts). */
export type AgentsView = {
  roots(): SessionSummary[];
  snapshot(session: SessionSummary): AgentSnapshotPayload;
  archive(sessionId: string): Promise<void>;
  markUnread(sessionId: string): void;
  clearAttention(sessionIds: string[]): string[];
  create(input: CreateAgentInput): Promise<AgentSnapshotPayload>;
};
export type CreateAgentInput = { config: { provider: string; cwd: string; model?: string | null; modeId?: string | null; title?: string | null }; workspaceId: string; initialPrompt?: string; clientMessageId?: string };

const hex = () => randomBytes(8).toString('hex');
const now = () => new Date().toISOString();
const GIT_POLL_MS = 10_000;

class RequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

async function isDirectory(directory: string) {
  return (await stat(directory).catch(() => undefined))?.isDirectory() ?? false;
}

export function createWorkspaces({ home, broadcast, agents, inDevelopment, log = () => {} }: {
  home?: string;
  broadcast(message: Outbound): void;
  agents: () => AgentsView;
  inDevelopment: () => Promise<string>;
  log?: (message: string) => void;
}) {
  const file = home ? path.join(home, 'state', 'web-workspaces.json') : undefined;
  let registry: Registry = { projects: [], workspaces: [], sessions: {}, labels: { generation: hex(), seq: 0, catalog: [] } };
  const git = checkoutCache();
  /** What each client last heard, so only changes are sent. */
  const sentWorkspaces = new Map<string, string>();
  const sentProjects = new Map<string, string>();
  let loaded: Promise<void> | undefined;
  let saving: Promise<void> = Promise.resolve();
  let syncQueued = false;
  let gitTimer: NodeJS.Timeout | undefined;

  function load() {
    loaded ??= (async () => {
      if (!file) return;
      const text = await readFile(file, 'utf8').catch(() => undefined);
      if (!text) return;
      try {
        const stored = JSON.parse(text) as Partial<Registry>;
        registry = {
          projects: stored.projects ?? [],
          workspaces: (stored.workspaces ?? []).map(workspace => ({ ...workspace, labels: workspace.labels ?? [] })),
          sessions: stored.sessions ?? {},
          labels: stored.labels ?? registry.labels,
        };
      } catch (error: any) {
        log(`web workspaces unreadable, starting afresh: ${error?.message ?? error}`);
      }
    })();
    return loaded;
  }

  function save() {
    if (!file) return saving;
    const text = `${JSON.stringify(registry, null, 2)}\n`;
    saving = saving.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, text);
      await rename(temporary, file);
    }).catch(error => log(`web workspaces not saved: ${error?.message ?? error}`));
    return saving;
  }

  const project = (id: string) => registry.projects.find(entry => entry.id === id);
  const workspace = (id: string) => registry.workspaces.find(entry => entry.id === id);
  const active = (entry: WorkspaceRecord) => !entry.archivedAt && !project(entry.projectId)?.removedAt;

  function projectFor(root: string) {
    const directory = path.resolve(root);
    let entry = registry.projects.find(candidate => candidate.root === directory && !candidate.removedAt);
    if (!entry) {
      entry = { id: `prj_${hex()}`, root: directory, addedAt: now() };
      registry.projects.push(entry);
      void save();
    }
    return entry;
  }

  function newWorkspace(directory: string, projectId: string, fields: Partial<WorkspaceRecord> = {}) {
    const entry: WorkspaceRecord = { id: `wks_${hex()}`, projectId, directory: path.resolve(directory), labels: [], createdAt: now(), ...fields };
    registry.workspaces.push(entry);
    void save();
    return entry;
  }

  /** The workspace a root belongs to; a root not seen before goes to its directory's oldest open one. */
  function workspaceIdFor(session: SessionSummary) {
    const mapped = registry.sessions[session.id] ? workspace(registry.sessions[session.id]) : undefined;
    if (mapped) {
      // A root someone works in again brings its workspace back.
      if (mapped.archivedAt && !session.archived) { mapped.archivedAt = null; void save(); queueSync(); }
      return mapped.id;
    }
    const directory = path.resolve(session.projectRoot);
    const here = registry.workspaces.filter(entry => entry.directory === directory).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const chosen = here.find(active) ?? (session.archived ? here.at(-1) : undefined)
      ?? newWorkspace(directory, projectFor(directory).id, session.archived ? { archivedAt: session.updatedAt ?? now() } : {});
    registry.sessions[session.id] = chosen.id;
    void save();
    return chosen.id;
  }

  function assign(sessionId: string, workspaceId: string) {
    if (registry.sessions[sessionId] === workspaceId) return;
    registry.sessions[sessionId] = workspaceId;
    void save();
  }

  function checkoutOf(directory: string): Placement['checkout'] {
    const facts = git.peek(directory);
    return facts?.isGit
      ? { cwd: directory, worktreeRoot: facts.repoRoot, isGit: true, currentBranch: facts.currentBranch, remoteUrl: facts.remoteUrl, isPaseoOwnedWorktree: false, mainRepoRoot: null }
      : { cwd: directory, worktreeRoot: null, isGit: false, currentBranch: null, remoteUrl: null, isPaseoOwnedWorktree: false, mainRepoRoot: null };
  }

  const projectName = (entry: ProjectRecord) => entry.customName || path.basename(entry.root) || entry.root;
  const projectKind = (entry: ProjectRecord) => git.peek(entry.root)?.isGit ? 'git' as const : 'non_git' as const;

  /** An agent's place, keyed by its project's id as Paseo's daemon does. */
  function placement(session: SessionSummary): Placement {
    const entry = workspace(workspaceIdFor(session))!;
    const owner = project(entry.projectId)!;
    return { projectKey: owner.id, projectName: projectName(owner), workspaceName: nameOf(entry), checkout: checkoutOf(entry.directory) };
  }

  function projectDescriptor(entry: ProjectRecord): ProjectDescriptor {
    return { projectId: entry.id, projectKey: entry.id, projectDisplayName: projectName(entry), projectCustomName: entry.customName ?? null, projectRootPath: entry.root, projectKind: projectKind(entry) };
  }

  function nameOf(entry: WorkspaceRecord) {
    const facts = git.peek(entry.directory);
    return entry.title || (facts?.isGit ? facts.currentBranch : null) || path.basename(entry.directory) || entry.directory;
  }

  function rootsIn(id: string) {
    return agents().roots().filter(session => registry.sessions[session.id] === id && !session.archived);
  }

  function descriptor(entry: WorkspaceRecord): WorkspaceDescriptor {
    const owner = project(entry.projectId)!;
    const facts: CheckoutFacts | undefined = git.peek(entry.directory);
    const snapshots = rootsIn(entry.id).map(session => agents().snapshot(session));
    let status: WorkspaceDescriptor['status'] = 'done';
    for (const agent of snapshots) {
      const bucket = deriveAgentStateBucket({ status: agent.status, requiresAttention: agent.requiresAttention, attentionReason: agent.attentionReason, pendingPermissionCount: agent.pendingPermissions.length });
      if (getWorkspaceStateBucketPriority(bucket) < getWorkspaceStateBucketPriority(status)) status = bucket;
    }
    const activityAt = snapshots.map(agent => agent.updatedAt).sort().at(-1) ?? null;
    return {
      id: entry.id,
      projectId: owner.id,
      projectDisplayName: projectName(owner),
      projectCustomName: owner.customName ?? null,
      projectRootPath: owner.root,
      workspaceDirectory: entry.directory,
      projectKind: projectKind(owner),
      workspaceKind: facts?.isGit ? 'local_checkout' : 'directory',
      name: nameOf(entry),
      title: entry.title ?? null,
      pinnedAt: entry.pinnedAt ?? null,
      labels: entry.labels,
      archivingAt: null,
      status,
      statusEnteredAt: null,
      activityAt: activityAt ?? entry.createdAt,
      scripts: [],
      gitRuntime: facts?.isGit ? { currentBranch: facts.currentBranch, remoteUrl: facts.remoteUrl, isPaseoOwnedWorktree: false, isDirty: facts.isDirty, aheadBehind: null, aheadOfOrigin: null, behindOfOrigin: null } : null,
      githubRuntime: null,
      project: { projectKey: owner.id, projectName: projectName(owner), workspaceName: nameOf(entry), checkout: checkoutOf(entry.directory) },
    };
  }

  /** Tells every client what changed in the workspaces and projects since it last heard. */
  function sync() {
    syncQueued = false;
    const open = registry.workspaces.filter(active);
    const openIds = new Set(open.map(entry => entry.id));
    for (const entry of open) {
      const value = descriptor(entry);
      const text = JSON.stringify(value);
      if (sentWorkspaces.get(entry.id) === text) continue;
      sentWorkspaces.set(entry.id, text);
      broadcast({ type: 'workspace_update', payload: { kind: 'upsert', workspace: value } });
    }
    for (const id of [...sentWorkspaces.keys()]) {
      if (openIds.has(id)) continue;
      sentWorkspaces.delete(id);
      const owner = project(workspace(id)?.projectId ?? '');
      const empty = owner && !owner.removedAt && !open.some(entry => entry.projectId === owner.id);
      broadcast({ type: 'workspace_update', payload: { kind: 'remove', id, ...(empty ? { emptyProject: projectDescriptor(owner) } : {}), ...(owner?.removedAt ? { removedProjectId: owner.id } : {}) } });
    }
    const projects = registry.projects.filter(entry => !entry.removedAt);
    const projectIds = new Set(projects.map(entry => entry.id));
    for (const entry of projects) {
      const value = projectDescriptor(entry);
      const text = JSON.stringify(value);
      if (sentProjects.get(entry.id) === text) continue;
      sentProjects.set(entry.id, text);
      broadcast({ type: 'project.update', payload: { kind: 'upsert', project: value } });
    }
    for (const id of [...sentProjects.keys()]) {
      if (projectIds.has(id)) continue;
      sentProjects.delete(id);
      broadcast({ type: 'project.update', payload: { kind: 'remove', projectId: id } });
    }
  }

  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    setImmediate(sync);
  }

  /** Reads the checkouts again and tells clients when a branch or dirtiness changed. */
  async function readCheckouts(force = false) {
    const directories = new Set<string>();
    for (const entry of registry.workspaces.filter(active)) { directories.add(entry.directory); directories.add(project(entry.projectId)!.root); }
    for (const entry of registry.projects.filter(candidate => !candidate.removedAt)) directories.add(entry.root);
    await Promise.all([...directories].map(directory => git.read(directory, force)));
    queueSync();
  }

  /** Every open workspace as the app lists them, with the projects that have none. */
  function listing(message: Inbound<'fetch_workspaces_request'>) {
    const query = message.filter?.query?.trim().toLowerCase();
    let rows = registry.workspaces.filter(active)
      .filter(entry => !message.filter?.projectId || entry.projectId === message.filter.projectId)
      .map(descriptor)
      .filter(entry => !query || [entry.name, entry.projectDisplayName, entry.workspaceDirectory ?? ''].some(text => text.toLowerCase().includes(query)));
    const sort = message.sort?.length ? message.sort : [{ key: 'activity_at' as const, direction: 'desc' as const }];
    rows = rows.sort((a, b) => {
      for (const { key, direction } of sort) {
        const order = key === 'status_priority' ? getWorkspaceStateBucketPriority(a.status) - getWorkspaceStateBucketPriority(b.status)
          : key === 'name' ? a.name.localeCompare(b.name)
          : key === 'project_id' ? a.projectId.localeCompare(b.projectId)
          : (a.activityAt ?? '').localeCompare(b.activityAt ?? '');
        if (order) return direction === 'asc' ? order : -order;
      }
      return 0;
    });
    const offset = Number(message.page?.cursor ?? 0) || 0;
    const limit = message.page?.limit ?? rows.length;
    const more = offset + limit < rows.length;
    const withWorkspaces = new Set(registry.workspaces.filter(active).map(entry => entry.projectId));
    return {
      entries: rows.slice(offset, offset + limit),
      emptyProjects: offset ? [] : registry.projects.filter(entry => !entry.removedAt && !withWorkspaces.has(entry.id)).map(projectDescriptor),
      pageInfo: { nextCursor: more ? String(offset + limit) : null, prevCursor: offset ? String(Math.max(0, offset - limit)) : null, hasMore: more },
    };
  }

  async function addProject(cwd: string) {
    const directory = path.resolve(cwd);
    if (!path.isAbsolute(cwd) || !await isDirectory(directory)) throw new RequestError(`${cwd} is not a directory`, 'directory_not_found');
    await git.read(directory, true);
    const entry = projectFor(directory);
    queueSync();
    return entry;
  }

  /** Archives a workspace: its roots are archived (and stop), and it leaves the sidebar. */
  async function archiveWorkspace(entry: WorkspaceRecord) {
    for (const session of rootsIn(entry.id)) await agents().archive(session.id);
    entry.archivedAt = now();
    entry.pinnedAt = null;
    await save();
    queueSync();
    return entry.archivedAt;
  }

  // Labels: one catalog, each change a new seq in the same generation, as Paseo's daemon keeps them.
  function labelUpdate(payload: { kind: 'upsert'; label: WorkspaceLabelDefinition; previousName?: string } | { kind: 'remove'; name: string }) {
    registry.labels.seq += 1;
    void save();
    broadcast({ type: 'workspace.label.update', payload: { ...payload, generation: registry.labels.generation, seq: registry.labels.seq } } as Outbound);
  }
  const catalogEntry = (name: string) => registry.labels.catalog.find(label => workspaceLabelKey(label.name) === workspaceLabelKey(name));

  function known(workspaceId: string) {
    const entry = workspace(workspaceId);
    if (!entry || !active(entry)) throw new RequestError(`No workspace ${workspaceId}`, 'workspace_not_found');
    return entry;
  }

  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  const code = (error: unknown) => error instanceof RequestError ? error.code : undefined;

  const handlers: Record<string, Handler> = {
    async fetch_workspaces_request(request: Inbound<'fetch_workspaces_request'>) {
      await load();
      await readCheckouts();
      sync();
      return { type: 'fetch_workspaces_response', payload: { requestId: request.requestId, subscriptionId: request.subscribe?.subscriptionId ?? null, ...listing(request) } } satisfies Outbound;
    },

    async 'project.list.request'(request: Inbound<'project.list.request'>) {
      await load();
      return { type: 'project.list.response', payload: { requestId: request.requestId, projects: registry.projects.filter(entry => !entry.removedAt).map(projectDescriptor) } } satisfies Outbound;
    },

    async 'project.add.request'(request: Inbound<'project.add.request'>) {
      await load();
      try {
        const entry = await addProject(request.cwd);
        return { type: 'project.add.response', payload: { requestId: request.requestId, project: projectDescriptor(entry), error: null } } satisfies Outbound;
      } catch (error) {
        return { type: 'project.add.response', payload: { requestId: request.requestId, project: null, error: message(error), errorCode: code(error) === 'directory_not_found' ? 'directory_not_found' : null } } satisfies Outbound;
      }
    },

    async 'project.create_directory.request'(request: Inbound<'project.create_directory.request'>) {
      await load();
      const fail = (error: unknown) => ({ type: 'project.create_directory.response', payload: { requestId: request.requestId, directoryPath: null, project: null, error: message(error), errorCode: code(error) ?? null } }) satisfies Outbound;
      const name = request.name.trim();
      if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) return fail(new RequestError('The folder name must be one plain name', 'invalid_name'));
      if (!path.isAbsolute(request.parentPath) || !await isDirectory(request.parentPath)) return fail(new RequestError(`${request.parentPath} is not a directory`, 'directory_not_found'));
      const directory = path.join(path.resolve(request.parentPath), name);
      try {
        await mkdir(directory);
      } catch (error: any) {
        return fail(new RequestError(error?.code === 'EEXIST' ? `${directory} already exists` : message(error), error?.code === 'EEXIST' ? 'directory_exists' : undefined));
      }
      const entry = await addProject(directory);
      return { type: 'project.create_directory.response', payload: { requestId: request.requestId, directoryPath: directory, project: projectDescriptor(entry), error: null, errorCode: null } } satisfies Outbound;
    },

    async 'project.rename.request'(request: Inbound<'project.rename.request'>) {
      await load();
      const entry = project(request.projectId);
      if (!entry || entry.removedAt) return { type: 'project.rename.response', payload: { requestId: request.requestId, projectId: request.projectId, accepted: false, customName: null, error: `No project ${request.projectId}` } } satisfies Outbound;
      entry.customName = request.customName?.trim() || null;
      await save();
      queueSync();
      return { type: 'project.rename.response', payload: { requestId: request.requestId, projectId: entry.id, accepted: true, customName: entry.customName, error: null } } satisfies Outbound;
    },

    async 'project.remove.request'(request: Inbound<'project.remove.request'>) {
      await load();
      const entry = project(request.projectId);
      if (!entry || entry.removedAt) return { type: 'project.remove.response', payload: { requestId: request.requestId, projectId: request.projectId, accepted: false, removedWorkspaceIds: [], error: `No project ${request.projectId}` } } satisfies Outbound;
      const removed = registry.workspaces.filter(candidate => candidate.projectId === entry.id && active(candidate));
      for (const candidate of removed) await archiveWorkspace(candidate);
      entry.removedAt = now();
      await save();
      // A project without workspaces leaves by its own id, as Paseo's daemon sends it.
      if (!removed.length) broadcast({ type: 'workspace_update', payload: { kind: 'remove', id: entry.id, removedProjectId: entry.id } });
      sync();
      return { type: 'project.remove.response', payload: { requestId: request.requestId, projectId: entry.id, accepted: true, removedWorkspaceIds: removed.map(candidate => candidate.id), error: null } } satisfies Outbound;
    },

    async open_project_request(request: Inbound<'open_project_request'>) {
      await load();
      try {
        const owner = await addProject(request.cwd);
        const directory = path.resolve(request.cwd);
        const entry = registry.workspaces.filter(candidate => candidate.directory === directory && active(candidate)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
          ?? newWorkspace(directory, owner.id);
        await git.read(directory);
        sync();
        return { type: 'open_project_response', payload: { requestId: request.requestId, workspace: descriptor(entry), error: null } } satisfies Outbound;
      } catch (error) {
        return { type: 'open_project_response', payload: { requestId: request.requestId, workspace: null, error: message(error), errorCode: code(error) === 'directory_not_found' ? 'directory_not_found' : null } } satisfies Outbound;
      }
    },

    async 'workspace.create.request'(request: Inbound<'workspace.create.request'>) {
      await load();
      const reply = (fields: Partial<Extract<Outbound, { type: 'workspace.create.response' }>['payload']>): Outbound =>
        ({ type: 'workspace.create.response', payload: { requestId: request.requestId, workspace: null, setupTerminalId: null, error: null, ...fields } });
      // Worktrees ALP makes itself, for its writers; making one from the app is not in ALP yet.
      if (request.source.kind !== 'directory') return reply({ error: await inDevelopment(), errorCode: 'not_implemented' });
      const again = request.idempotencyKey ? registry.workspaces.find(entry => entry.idempotencyKey === request.idempotencyKey) : undefined;
      if (again) return reply({ workspace: descriptor(again) });
      try {
        const owner = request.source.projectId ? project(request.source.projectId) : await addProject(request.source.path);
        if (!owner || owner.removedAt) throw new RequestError(`No project ${request.source.projectId}`);
        const directory = path.resolve(request.source.path);
        if (!await isDirectory(directory)) throw new RequestError(`${request.source.path} is not a directory`, 'directory_not_found');
        await git.read(directory);
        const entry = newWorkspace(directory, owner.id, {
          ...(request.workspaceId && !workspace(request.workspaceId) ? { id: request.workspaceId } : {}),
          ...(request.title?.trim() ? { title: request.title.trim() } : {}),
          ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
        });
        let agent: AgentSnapshotPayload | undefined;
        if (request.agent) {
          const { config, initialPrompt, clientMessageId } = request.agent;
          agent = await agents().create({ config: { ...config, cwd: directory }, workspaceId: entry.id, ...(initialPrompt ? { initialPrompt } : {}), ...(clientMessageId ? { clientMessageId } : {}) });
        }
        sync();
        return reply({ workspace: descriptor(entry), ...(agent ? { agent } : {}) });
      } catch (error) {
        return reply({ error: message(error), ...(code(error) ? { errorCode: code(error) } : {}) });
      }
    },

    async 'workspace.title.set.request'(request: Inbound<'workspace.title.set.request'>) {
      await load();
      try {
        const entry = known(request.workspaceId);
        entry.title = request.title?.trim() || null;
        await save();
        sync();
        return { type: 'workspace.title.set.response', payload: { requestId: request.requestId, workspaceId: entry.id, accepted: true, title: entry.title, error: null } } satisfies Outbound;
      } catch (error) {
        return { type: 'workspace.title.set.response', payload: { requestId: request.requestId, workspaceId: request.workspaceId, accepted: false, title: null, error: message(error) } } satisfies Outbound;
      }
    },

    async 'workspace.pin.set.request'(request: Inbound<'workspace.pin.set.request'>) {
      await load();
      try {
        const entry = known(request.workspaceId);
        entry.pinnedAt = request.pinned ? entry.pinnedAt ?? now() : null;
        await save();
        sync();
        return { type: 'workspace.pin.set.response', payload: { requestId: request.requestId, workspaceId: entry.id, accepted: true, pinnedAt: entry.pinnedAt, error: null } } satisfies Outbound;
      } catch (error) {
        return { type: 'workspace.pin.set.response', payload: { requestId: request.requestId, workspaceId: request.workspaceId, accepted: false, pinnedAt: null, error: message(error) } } satisfies Outbound;
      }
    },

    async archive_workspace_request(request: Inbound<'archive_workspace_request'>) {
      await load();
      try {
        const archivedAt = await archiveWorkspace(known(request.workspaceId));
        return { type: 'archive_workspace_response', payload: { requestId: request.requestId, workspaceId: request.workspaceId, archivedAt, error: null } } satisfies Outbound;
      } catch (error) {
        return { type: 'archive_workspace_response', payload: { requestId: request.requestId, workspaceId: request.workspaceId, archivedAt: null, error: message(error) } } satisfies Outbound;
      }
    },

    /** Marks the newest finished root unread again, as Paseo's daemon does. */
    async 'workspace.mark_unread.request'(request: Inbound<'workspace.mark_unread.request'>) {
      await load();
      try {
        const entry = known(request.workspaceId);
        const candidate = rootsIn(entry.id).map(session => ({ session, agent: agents().snapshot(session) }))
          .filter(({ agent }) => agent.status !== 'running' && !agent.requiresAttention && !agent.pendingPermissions.length)
          .sort((a, b) => b.agent.updatedAt.localeCompare(a.agent.updatedAt))[0];
        if (candidate) agents().markUnread(candidate.session.id);
        sync();
        return { type: 'workspace.mark_unread.response', payload: { requestId: request.requestId, workspaceId: entry.id, markedAgentId: candidate?.session.id ?? null, success: !!candidate, error: candidate ? null : 'Nothing to mark unread' } } satisfies Outbound;
      } catch (error) {
        return { type: 'workspace.mark_unread.response', payload: { requestId: request.requestId, workspaceId: request.workspaceId, markedAgentId: null, success: false, error: message(error) } } satisfies Outbound;
      }
    },

    async 'workspace.clear_attention.request'(request: Inbound<'workspace.clear_attention.request'>) {
      await load();
      const ids = Array.isArray(request.workspaceId) ? request.workspaceId : [request.workspaceId];
      const results = ids.map(workspaceId => {
        try {
          const entry = known(workspaceId);
          return { workspaceId, clearedAgentIds: agents().clearAttention(rootsIn(entry.id).map(session => session.id)), success: true, error: null };
        } catch (error) {
          return { workspaceId, clearedAgentIds: [], success: false, error: message(error) };
        }
      });
      sync();
      const failed = results.find(result => !result.success);
      return { type: 'workspace.clear_attention.response', payload: { requestId: request.requestId, workspaceId: request.workspaceId, clearedAgentIds: results.flatMap(result => result.clearedAgentIds), results, success: !failed, error: failed?.error ?? null } } satisfies Outbound;
    },

    async 'workspace.label.list.request'(request: Inbound<'workspace.label.list.request'>) {
      await load();
      return {
        type: 'workspace.label.list.response',
        payload: {
          requestId: request.requestId,
          ...(request.subscribe?.subscriptionId ? { subscriptionId: request.subscribe.subscriptionId } : {}),
          labels: registry.labels.catalog,
          sync: { mode: 'snapshot', generation: registry.labels.generation, headSeq: registry.labels.seq, removals: [] },
        },
      } satisfies Outbound;
    },

    async 'workspace.label.assignment.set.request'(request: Inbound<'workspace.label.assignment.set.request'>) {
      await load();
      const entry = known(request.workspaceId);
      const name = normalizeWorkspaceLabelName(request.label.name);
      if (!name) throw new RequestError('A label needs a name', 'invalid_label');
      let label = catalogEntry(name);
      if (!label && request.assigned) {
        label = { name, color: request.label.color };
        registry.labels.catalog.push(label);
        labelUpdate({ kind: 'upsert', label });
      }
      const key = workspaceLabelKey(name);
      entry.labels = entry.labels.filter(existing => workspaceLabelKey(existing) !== key);
      if (request.assigned && label) entry.labels.push(label.name);
      await save();
      sync();
      return { type: 'workspace.label.assignment.set.response', payload: { requestId: request.requestId, label: label ?? { name, color: request.label.color }, workspaceLabels: entry.labels } } satisfies Outbound;
    },

    async 'workspace.label.update.request'(request: Inbound<'workspace.label.update.request'>) {
      await load();
      const label = catalogEntry(request.name);
      if (!label) throw new RequestError(`No label ${request.name}`, 'label_not_found');
      const previousName = label.name;
      const newName = request.newName !== undefined ? normalizeWorkspaceLabelName(request.newName) : previousName;
      if (!newName) throw new RequestError('A label needs a name', 'invalid_label');
      const taken = catalogEntry(newName);
      if (taken && taken !== label) throw new RequestError(`There is already a label ${taken.name}`, 'label_name_taken');
      label.name = newName;
      if (request.color) label.color = request.color;
      let affected = 0;
      for (const entry of registry.workspaces) {
        const index = entry.labels.findIndex(existing => workspaceLabelKey(existing) === workspaceLabelKey(previousName));
        if (index < 0) continue;
        entry.labels[index] = newName;
        affected += 1;
      }
      labelUpdate({ kind: 'upsert', label: { ...label }, ...(previousName !== newName ? { previousName } : {}) });
      await save();
      sync();
      return { type: 'workspace.label.update.response', payload: { requestId: request.requestId, label: { ...label }, affectedWorkspaceCount: affected } } satisfies Outbound;
    },

    async 'workspace.label.delete.inspect.request'(request: Inbound<'workspace.label.delete.inspect.request'>) {
      await load();
      const key = workspaceLabelKey(request.name);
      return { type: 'workspace.label.delete.inspect.response', payload: { requestId: request.requestId, affectedWorkspaceCount: registry.workspaces.filter(entry => active(entry) && entry.labels.some(existing => workspaceLabelKey(existing) === key)).length } } satisfies Outbound;
    },

    async 'workspace.label.delete.request'(request: Inbound<'workspace.label.delete.request'>) {
      await load();
      const label = catalogEntry(request.name);
      if (!label) throw new RequestError(`No label ${request.name}`, 'label_not_found');
      const key = workspaceLabelKey(label.name);
      registry.labels.catalog = registry.labels.catalog.filter(entry => entry !== label);
      let affected = 0;
      for (const entry of registry.workspaces) {
        const kept = entry.labels.filter(existing => workspaceLabelKey(existing) !== key);
        if (kept.length !== entry.labels.length) { entry.labels = kept; affected += 1; }
      }
      labelUpdate({ kind: 'remove', name: label.name });
      await save();
      sync();
      return { type: 'workspace.label.delete.response', payload: { requestId: request.requestId, affectedWorkspaceCount: affected } } satisfies Outbound;
    },
  };

  return {
    handlers,
    features: {
      workspaceMultiplicity: true, projectList: true, projectAdd: true, stableProjectIdentity: true, projectRemove: true, projectCreateDirectory: true,
      workspacePinning: true, workspaceMarkUnread: true, workspaceLabels: true,
    },
    load,
    workspaceIdFor,
    placement,
    assign,
    /** Something about the agents changed: workspaces' status and activity follow. */
    changed: queueSync,
    start() {
      gitTimer ??= setInterval(() => void readCheckouts(true).catch(error => log(`checkouts not read: ${error?.message ?? error}`)), GIT_POLL_MS);
      gitTimer.unref();
      return load().then(() => readCheckouts());
    },
    close() {
      if (gitTimer) clearInterval(gitTimer);
      return saving;
    },
  };
}
