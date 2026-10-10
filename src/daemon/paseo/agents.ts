import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { AgentPermissionRequest, AgentPermissionResponse } from '@getpaseo/protocol/agent-types';
import type { AgentSnapshotPayload, SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import { modes } from '../../runtime/index.js';
import type { Envelope, UserQuestion } from '../../runtime/index.js';
import type { DaemonServer, SessionSummary } from '../server.js';
import { connectInProcess, type AlpClient } from './alp-client.js';
import type { ClientContext, Handler } from './gateway.js';
import { TimelineDeltas } from './timeline-items.js';
import { InMemoryAgentTimelineStore } from './timeline-store.js';

/**
 * ALP's roots as Paseo's agents (D31 step 3, ALPD §62). Each root session is one agent of the
 * provider "alp"; its team is the agent's model and its permission mode the agent's mode. The
 * timeline is the root's own events, kept in Paseo's timeline store; live changes go to every
 * client as agent_update and agent_stream, as a Paseo daemon does for clients without owned
 * subscriptions. What ALP asks the user (alp_ask, a permission, a trust or approval prompt) is
 * a question card on the root it belongs to (step 4).
 */

export const PROVIDER = 'alp';
const POLL_MS = 2_000;

type Inbound<T extends SessionInboundMessage['type']> = Extract<SessionInboundMessage, { type: T }>;
type Outbound = SessionOutboundMessage;
type Placement = Extract<Outbound, { type: 'fetch_agents_response' }>['payload']['entries'][number]['project'];

const capabilities = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};
const availableModes = modes.map(mode => ({ id: mode.id, label: mode.label }));

/** A team's id stands for the model Paseo shows; a custom root shows its own runtime and model. */
const modelOf = (session: SessionSummary) => session.workflow.mode === 'custom' ? `${session.runtime}:${session.model}` : session.workflow.mode;

export function createAgents({ daemon, broadcast, log = () => {} }: {
  daemon: DaemonServer;
  broadcast(message: Outbound): void;
  log?: (message: string) => void;
}) {
  let alp: AlpClient | undefined;
  let timer: NodeJS.Timeout | undefined;
  const roots = new Map<string, SessionSummary>();
  const timelines = new InMemoryAgentTimelineStore();
  const deltas = new Map<string, TimelineDeltas>();
  /** Roots whose history is being replayed into their timeline; nothing of it is broadcast. */
  const replaying = new Set<string>();
  const attaching = new Map<string, Promise<void>>();
  const turns = new Map<string, string>();
  /** Paseo's attention: a finished turn the user has not looked at yet. */
  const attention = new Map<string, { reason: 'finished' | 'error' | 'permission'; at: string }>();
  /** Questions waiting for the user, and the answers the app gave, until alpd says they are resolved. */
  const questions = new Map<string, UserQuestion>();
  const answered = new Map<string, AgentPermissionResponse>();
  let started: Promise<void> | undefined;

  function agentOf(session: SessionSummary): AgentSnapshotPayload {
    const status = session.status === 'running' || (session.status === 'idle' && session.busy) ? 'running'
      : session.status === 'idle' ? 'idle'
      : session.status === 'initializing' ? 'initializing'
      : session.status === 'error' ? 'error'
      // A closed root that kept its thread opens again on the next message.
      : session.persistent ? 'idle' : 'closed';
    const seen = attention.get(session.id);
    const updatedAt = session.updatedAt ?? new Date().toISOString();
    return {
      id: session.id,
      provider: PROVIDER,
      cwd: session.projectRoot,
      model: modelOf(session),
      createdAt: session.createdAt ?? updatedAt,
      updatedAt,
      lastUserMessageAt: null,
      status,
      activeTurn: session.activeTurnId ? { turnId: session.activeTurnId, startedAt: null } : null,
      capabilities,
      currentModeId: session.mode,
      availableModes,
      pendingPermissions: [...questions.values()].filter(question => question.rootId === session.id).map(permissionOf),
      persistence: session.persistent ? { provider: PROVIDER, sessionId: session.id } : null,
      runtimeInfo: { provider: PROVIDER, sessionId: session.id, model: `${session.runtime}:${session.model}`, modeId: session.mode },
      ...(session.lastError ? { lastError: session.lastError.message } : {}),
      title: session.title ?? null,
      labels: {},
      requiresAttention: !!seen,
      attentionReason: seen?.reason ?? null,
      attentionTimestamp: seen?.at ?? null,
      archivedAt: session.archived ? updatedAt : null,
    };
  }

  function placement(session: SessionSummary): Placement {
    return {
      projectKey: session.projectRoot,
      projectName: path.basename(session.projectRoot) || session.projectRoot,
      checkout: { cwd: session.projectRoot, worktreeRoot: null, isGit: false, currentBranch: null, remoteUrl: null, isPaseoOwnedWorktree: false, mainRepoRoot: null },
    };
  }

  /**
   * An ALP question as Paseo's question card: its text, its choices, and a field for any other
   * answer, headed by the agent that asks. ALP takes the answer as text (the choice's label).
   */
  function permissionOf(question: UserQuestion): AgentPermissionRequest {
    return {
      id: question.id,
      provider: PROVIDER,
      name: 'alp_ask',
      kind: 'question',
      title: question.agent,
      input: { questions: [{ question: question.body, header: question.agent, options: (question.options ?? []).map(label => ({ label })), multiSelect: false, allowOther: true }] },
      metadata: { sessionId: question.sessionId, askedAt: question.askedAt },
    };
  }

  function asked(question: UserQuestion) {
    if (questions.has(question.id)) return;
    questions.set(question.id, question);
    broadcast({ type: 'agent_permission_request', payload: { agentId: question.rootId, request: permissionOf(question) } });
    attention.set(question.rootId, { reason: 'permission', at: question.askedAt });
    stream(question.rootId, { type: 'attention_required', provider: PROVIDER, reason: 'permission', timestamp: question.askedAt, shouldNotify: true }, question.askedAt);
    const root = roots.get(question.rootId);
    if (root) upsert(root);
  }

  function resolved(questionId: string, resolution: AgentPermissionResponse) {
    const question = questions.get(questionId);
    if (!question) return;
    questions.delete(questionId);
    answered.delete(questionId);
    broadcast({ type: 'agent_permission_resolved', payload: { agentId: question.rootId, requestId: questionId, resolution } });
    const waiting = [...questions.values()].some(other => other.rootId === question.rootId);
    if (!waiting && attention.get(question.rootId)?.reason === 'permission') attention.delete(question.rootId);
    const root = roots.get(question.rootId);
    if (root) upsert(root);
  }

  /** What the app shows for a question resolved in alpd: the app's own answer, or why it ended. */
  function resolutionOf(questionId: string, outcome: 'answered' | 'dismissed' | 'timeout' | 'canceled'): AgentPermissionResponse {
    if (outcome === 'answered') return answered.get(questionId) ?? { behavior: 'allow' };
    return answered.get(questionId) ?? { behavior: 'deny', message: outcome === 'dismissed' ? 'Dismissed' : outcome === 'timeout' ? 'No answer in time' : 'Canceled' };
  }

  const upsert = (session: SessionSummary) => broadcast({ type: 'agent_update', payload: { kind: 'upsert', agent: agentOf(session), project: placement(session) } });

  /** Reads alpd's roots again and tells clients what changed. */
  async function refresh() {
    if (!alp) return;
    const { sessions } = await alp.request<{ sessions: SessionSummary[] }>('session.list', { rootsOnly: true, includeClosed: true, includeArchived: true });
    const seen = new Set<string>();
    for (const session of sessions) {
      seen.add(session.id);
      const before = roots.get(session.id);
      roots.set(session.id, session);
      if (!before || JSON.stringify(before) !== JSON.stringify(session)) upsert(session);
      // A live root's events come to the bridge, so its timeline stays current.
      if ((session.status === 'idle' || session.status === 'running') && !timelines.has(session.id)) void ensureTimeline(session.id).catch(() => {});
    }
    for (const id of [...roots.keys()]) if (!seen.has(id)) { roots.delete(id); broadcast({ type: 'agent_update', payload: { kind: 'remove', agentId: id } }); }
    // Questions come as events from attached trees; the list catches any other and any missed end.
    const { questions: waiting } = await alp.request<{ questions: UserQuestion[] }>('question.list', {});
    for (const question of waiting) asked(question);
    const open = new Set(waiting.map(question => question.id));
    for (const id of [...questions.keys()]) if (!open.has(id)) resolved(id, resolutionOf(id, 'canceled'));
  }

  function append(root: string, item: ReturnType<TimelineDeltas['next']>, timestamp: string) {
    if (!item || !timelines.has(root)) return;
    const turnId = turns.get(root);
    const row = timelines.append(root, item, { timestamp, ...(turnId ? { turnId } : {}) });
    if (replaying.has(root)) return;
    broadcast({ type: 'agent_stream', payload: { agentId: root, event: { type: 'timeline', provider: PROVIDER, item: row.item, ...(turnId ? { turnId } : {}) }, timestamp: row.timestamp, seq: row.seq, epoch: timelines.getEpoch(root) } });
  }

  function stream(root: string, event: Extract<Outbound, { type: 'agent_stream' }>['payload']['event'], timestamp: string) {
    if (replaying.has(root)) return;
    broadcast({ type: 'agent_stream', payload: { agentId: root, event, timestamp } });
  }

  function onEvent(envelope: Envelope) {
    // A question may come from any session of a tree; it belongs to the tree's root.
    if (envelope.event.type === 'question') { asked(envelope.event.question); return; }
    if (envelope.event.type === 'question.resolved') { resolved(envelope.event.questionId, resolutionOf(envelope.event.questionId, envelope.event.outcome)); return; }
    const root = envelope.sessionId;
    // Team members' events reach the app with the subagents (step 7); here only roots.
    const session = roots.get(root);
    if (!session && !replaying.has(root) && !timelines.has(root)) { if (envelope.event.type === 'session.opened' && !envelope.event.session.parentId) void refresh().catch(() => {}); return; }
    const { event } = envelope;
    switch (event.type) {
      case 'item': {
        let maker = deltas.get(root);
        if (!maker) deltas.set(root, maker = new TimelineDeltas());
        append(root, maker.next(event.item), envelope.ts);
        return;
      }
      case 'turn.started':
        turns.set(root, event.turnId);
        attention.delete(root);
        stream(root, { type: 'turn_started', provider: PROVIDER, turnId: event.turnId }, envelope.ts);
        break;
      case 'turn.ended': {
        turns.delete(root);
        if (event.state === 'completed') stream(root, { type: 'turn_completed', provider: PROVIDER, turnId: event.turnId }, envelope.ts);
        else if (event.state === 'canceled') stream(root, { type: 'turn_canceled', provider: PROVIDER, turnId: event.turnId, reason: event.error?.message ?? 'Stopped' }, envelope.ts);
        else stream(root, { type: 'turn_failed', provider: PROVIDER, turnId: event.turnId, error: event.error?.message ?? 'The turn failed' }, envelope.ts);
        if (!replaying.has(root) && event.state !== 'canceled') {
          const reason = event.state === 'completed' ? 'finished' as const : 'error' as const;
          attention.set(root, { reason, at: envelope.ts });
          stream(root, { type: 'attention_required', provider: PROVIDER, reason, timestamp: envelope.ts, shouldNotify: true }, envelope.ts);
        }
        break;
      }
      case 'session.opened': case 'session.updated': case 'session.closed': case 'session.failed':
        break;
      default:
        return;
    }
    if (!replaying.has(root)) void refresh().catch(() => {});
  }

  /** The root's timeline, from its history in alpd the first time; afterwards alpd sends its events here. */
  function ensureTimeline(root: string) {
    if (timelines.has(root)) return Promise.resolve();
    let pending = attaching.get(root);
    if (!pending) {
      pending = (async () => {
        timelines.initialize(root);
        deltas.set(root, new TimelineDeltas());
        replaying.add(root);
        try { await alp!.request('session.attach', { sessionId: root, replay: true }); }
        catch (error) { timelines.delete(root); throw error; }
        finally { replaying.delete(root); attaching.delete(root); }
      })();
      attaching.set(root, pending);
    }
    return pending;
  }

  function known(agentId: string) {
    const session = roots.get(agentId);
    if (!session) throw Object.assign(new Error(`No agent ${agentId}`), { code: 'agent_not_found' });
    return session;
  }

  /** A root that closed opens again, as ALP does for any viewer's message. */
  async function open(session: SessionSummary) {
    if (session.status === 'idle' || session.status === 'running' || session.status === 'initializing') return;
    await alp!.request('session.create', { sessionId: session.id, spec: { cwd: session.projectRoot }, resume: true });
  }

  async function teams(cwd?: string) {
    const { preview } = await alp!.request<{ preview: { teams: Array<{ id: string; label: string; description?: string }>; team: string; mode: string } }>('session.preview', { spec: { cwd: cwd ?? os.homedir() } });
    return preview;
  }

  const handlers: Record<string, Handler> = {
    async fetch_agents_request(message: Inbound<'fetch_agents_request'>) {
      await started;
      const sessions = [...roots.values()].filter(session => !session.archived)
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      const offset = Number(message.page?.cursor ?? 0) || 0;
      const limit = message.page?.limit ?? sessions.length;
      const page = sessions.slice(offset, offset + limit);
      const more = offset + limit < sessions.length;
      return {
        type: 'fetch_agents_response',
        payload: {
          requestId: message.requestId,
          subscriptionId: message.subscribe?.subscriptionId ?? null,
          entries: page.map(session => ({ agent: agentOf(session), project: placement(session) })),
          pageInfo: { nextCursor: more ? String(offset + limit) : null, prevCursor: offset ? String(Math.max(0, offset - limit)) : null, hasMore: more },
        },
      } satisfies Outbound;
    },

    async fetch_agent_request(message: Inbound<'fetch_agent_request'>) {
      await started;
      const session = roots.get(message.agentId);
      return { type: 'fetch_agent_response', payload: { requestId: message.requestId, agent: session ? agentOf(session) : null, project: session ? placement(session) : null, error: null } } satisfies Outbound;
    },

    async fetch_agent_timeline_request(message: Inbound<'fetch_agent_timeline_request'>) {
      await started;
      const direction = message.direction ?? (message.cursor ? 'after' : 'tail');
      const empty = { requestId: message.requestId, agentId: message.agentId, direction, projection: 'projected' as const, reset: false, staleCursor: false, gap: false, hasOlder: false, hasNewer: false, ...(message.mergeWindow ? { mergeWindow: true } : {}) };
      try {
        const session = known(message.agentId);
        await ensureTimeline(session.id);
        const page = timelines.fetch(session.id, { direction, ...(message.cursor ? { cursor: message.cursor } : {}), limit: message.limit ?? (direction === 'after' ? 0 : 200) });
        return {
          type: 'fetch_agent_timeline_response',
          payload: {
            ...empty,
            agent: agentOf(session),
            epoch: page.epoch,
            reset: page.reset,
            staleCursor: page.staleCursor,
            gap: page.gap,
            window: page.window,
            startCursor: page.startSeq !== null ? { epoch: page.epoch, seq: page.startSeq } : null,
            endCursor: page.endSeq !== null ? { epoch: page.epoch, seq: page.endSeq } : null,
            hasOlder: page.hasOlder,
            hasNewer: page.hasNewer,
            entries: page.rows.map(row => ({ provider: PROVIDER, item: row.item, ...(row.turnId ? { turnId: row.turnId } : {}), timestamp: row.timestamp, seqStart: row.seqStart, seqEnd: row.seqEnd, sourceSeqRanges: row.sourceSeqRanges, collapsed: row.collapsed })),
            error: null,
          },
        } satisfies Outbound;
      } catch (error: any) {
        return { type: 'fetch_agent_timeline_response', payload: { ...empty, agent: null, epoch: '', window: { minSeq: 0, maxSeq: 0, nextSeq: 0 }, startCursor: null, endCursor: null, entries: [], error: error?.message ?? String(error) } } satisfies Outbound;
      }
    },

    async get_providers_snapshot_request(message: Inbound<'get_providers_snapshot_request'>) {
      const preview = await teams(message.cwd);
      return {
        type: 'get_providers_snapshot_response',
        payload: {
          requestId: message.requestId,
          generatedAt: new Date().toISOString(),
          entries: [{
            provider: PROVIDER,
            status: 'ready',
            enabled: true,
            label: 'ALP',
            description: 'Teams of Codex and Claude Code agents',
            models: preview.teams.map(team => ({ provider: PROVIDER, id: team.id, label: team.label, ...(team.description ? { description: team.description } : {}), isDefault: team.id === preview.team })),
            modes: availableModes,
            defaultModeId: preview.mode,
          }],
        },
      } satisfies Outbound;
    },

    async create_agent_request(message: Inbound<'create_agent_request'>, client: ClientContext) {
      const { config } = message;
      const fail = (error: unknown): Outbound => ({ type: 'status', payload: { status: 'agent_create_failed', requestId: message.requestId, error: error instanceof Error ? error.message : String(error) } });
      if (config.provider !== PROVIDER) return fail(`ALP runs its own teams; ${config.provider} is not one of them`);
      try {
        const sessionId = `web-${randomUUID()}`;
        await alp!.request('session.create', { sessionId, spec: { cwd: config.cwd, persist: true, ...(config.model ? { workflow: config.model } : {}), ...(config.modeId ? { mode: config.modeId } : {}) } });
        if (config.title) await alp!.request('session.rename', { sessionId, title: config.title });
        await refresh();
        await ensureTimeline(sessionId);
        const prompt = message.initialPrompt?.trim();
        if (prompt) await alp!.request('session.prompt', { sessionId, clientMessageId: message.clientMessageId ?? randomUUID(), content: [{ type: 'text', text: prompt }] });
        client.emit({ type: 'status', payload: { status: 'agent_created', requestId: message.requestId, agentId: sessionId, agent: agentOf(known(sessionId)) } });
      } catch (error) {
        return fail(error);
      }
    },

    async send_agent_message_request(message: Inbound<'send_agent_message_request'>) {
      const reply = (error: string | null): Outbound => ({ type: 'send_agent_message_response', payload: { requestId: message.requestId, agentId: message.agentId, accepted: !error, error } });
      try {
        const session = known(message.agentId);
        await open(session);
        await ensureTimeline(session.id);
        const running = session.status === 'running' || session.busy;
        // Paseo's interrupt stops the turn and starts a new one; its steer (the default) goes into the turn.
        if (running && message.activeTurnBehavior === 'interrupt') await alp!.request('session.interrupt', { sessionId: session.id });
        await alp!.request('session.prompt', {
          sessionId: session.id,
          clientMessageId: message.messageId ?? randomUUID(),
          delivery: running && message.activeTurnBehavior !== 'interrupt' ? 'steer' : 'auto',
          content: [{ type: 'text', text: message.text }],
        });
        attention.delete(session.id);
        return reply(null);
      } catch (error: any) {
        return reply(error?.message ?? String(error));
      }
    },

    async cancel_agent_request(message: Inbound<'cancel_agent_request'>) {
      const session = known(message.agentId);
      const failed = await alp!.request('session.interrupt', { sessionId: session.id }).then(() => null, (error: Error) => error.message);
      if (!message.requestId) return;
      return { type: 'cancel_agent_response', payload: { requestId: message.requestId, agentId: session.id, agent: agentOf(roots.get(session.id) ?? session), error: failed } } satisfies Outbound;
    },

    async archive_agent_request(message: Inbound<'archive_agent_request'>) {
      const session = known(message.agentId);
      await alp!.request('session.archive', { sessionId: session.id });
      await refresh();
      const archived = roots.get(session.id) ?? session;
      return { type: 'agent_archived', payload: { agentId: session.id, archivedAt: agentOf(archived).archivedAt ?? new Date().toISOString(), requestId: message.requestId } } satisfies Outbound;
    },

    async update_agent_request(message: Inbound<'update_agent_request'>) {
      const reply = (error: string | null): Outbound => ({ type: 'update_agent_response', payload: { requestId: message.requestId, agentId: message.agentId, accepted: !error, error } });
      try {
        const session = known(message.agentId);
        if (typeof message.name === 'string' && message.name.trim()) await alp!.request('session.rename', { sessionId: session.id, title: message.name });
        await refresh();
        return reply(null);
      } catch (error: any) {
        return reply(error?.message ?? String(error));
      }
    },

    async set_agent_mode_request(message: Inbound<'set_agent_mode_request'>) {
      const reply = (error: string | null): Outbound => ({ type: 'set_agent_mode_response', payload: { requestId: message.requestId, agentId: message.agentId, accepted: !error, error } });
      try {
        const session = known(message.agentId);
        await open(session);
        await alp!.request('session.configure', { sessionId: session.id, mode: message.modeId });
        await refresh();
        return reply(null);
      } catch (error: any) {
        return reply(error?.message ?? String(error));
      }
    },

    /** The user's answer on a question card: a choice or other text, or dismissing it. */
    async agent_permission_response(message: Inbound<'agent_permission_response'>) {
      const question = questions.get(message.requestId);
      // Answered elsewhere already: its resolution has gone to every client.
      if (!question) return;
      const { response } = message;
      const answers = response.behavior === 'allow' ? response.updatedInput?.answers : undefined;
      const text = answers && typeof answers === 'object'
        ? Object.values(answers as Record<string, unknown>).find((value): value is string => typeof value === 'string' && !!value.trim())?.trim()
        : undefined;
      answered.set(question.id, response);
      try {
        await alp!.request('question.answer', text
          ? { questionId: question.id, text }
          : { questionId: question.id, dismiss: true, ...(response.behavior === 'deny' && response.message ? { reason: response.message } : {}) });
      } catch (error: any) {
        log(`paseo answer to ${question.id} failed: ${error?.message ?? error}`);
        answered.delete(question.id);
        resolved(question.id, { behavior: 'deny', message: error?.message ?? String(error) });
      }
    },

    clear_agent_attention(message: Inbound<'clear_agent_attention'>) {
      const ids = Array.isArray(message.agentId) ? message.agentId : [message.agentId];
      for (const id of ids) if (attention.delete(id)) { const session = roots.get(id); if (session) upsert(session); }
      if (!message.requestId) return;
      const agents = ids.map(id => roots.get(id)).filter((session): session is SessionSummary => !!session).map(agentOf);
      return { type: 'clear_agent_attention_response', payload: { requestId: message.requestId, agentId: message.agentId, agents } } satisfies Outbound;
    },
  };

  return {
    handlers,
    features: { providersSnapshot: true },
    start() {
      started ??= (async () => {
        alp = await connectInProcess(daemon, onEvent);
        await refresh();
        timer = setInterval(() => void refresh().catch(error => log(`agents refresh failed: ${error?.message ?? error}`)), POLL_MS);
        timer.unref();
      })();
      return started;
    },
    close() {
      if (timer) clearInterval(timer);
      alp?.close();
    },
  };
}
