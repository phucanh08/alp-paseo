import {
  PROVIDER_PROTOCOL_VERSION,
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  ProviderInputSchema,
  ProviderEventSchema,
  type ProviderRegistration,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPersistence,
  type ProviderTimelineItem,
} from './compat.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAlpRuntime, type RuntimeOptions, type SessionSnapshot, type TimelineItem, type Envelope } from '../../../src/runtime/index.js';
import { createDaemonServer, type DaemonConnection } from '../../../src/daemon/server.js';
import { alpHome, connect, lockAlive, readLock } from '../../../src/client/index.js';
import { daemonHeld, startDaemon } from '../../../src/client/supervise.js';
import { alpdSessionOf, configModels, DEFAULT_PROFILE, handleFor, modes, profileFor, profileModels, templates, toSessionSpec } from './mapping.js';
import { profiles } from '../../../src/core/workflow.js';

/**
 * Paseo is a viewer of alpd: this provider translates Paseo inputs into daemon
 * calls and daemon events into Paseo events. Orchestration lives in src/runtime,
 * hosted by the daemon (plans/reference/ALPD.md §8).
 */

const supported = [
  'prompt.message',
  'prompt.steer',
  'session.persistence',
  'session.subsession',
  'session.configure',
  'session.list',
  'permission',
] as const;

/**
 * Runtime options run an embedded daemon in this process (tests, custom runtimes);
 * without them the provider connects to the user's alpd, starting it when needed.
 */
type Options = Omit<RuntimeOptions, 'templates'> & {
  /** Run the runtime in this process instead of alpd; implied by a custom transport. */
  embedded?: boolean;
  /** Directory holding alpd's lock and socket; defaults to ALP_HOME or ~/.alp. */
  home?: string;
  /** The daemon script to start; defaults to alpd.js next to this bundle. */
  daemonEntry?: string;
};

type Backend = {
  client: DaemonConnection;
  shutdown(client: DaemonConnection): Promise<void>;
  /**
   * A new connection to alpd after the last one closed (ALPD §40): it starts alpd unless
   * the user stopped it on purpose and nobody has asked for it since (`demand`).
   */
  relink?(demand: boolean): Promise<DaemonConnection>;
};

declare const __ALP_DAEMON_ENTRY__: string | undefined;

/**
 * Paseo recompiles and evaluates plugin code, so import.meta.url may not name this
 * bundle. Beyond these candidates (the build machine's path among them), ensureDaemon
 * looks where alpd last recorded itself and for the ALP CLI on PATH.
 */
export function daemonEntry(explicit?: string) {
  const beside = () => { try { return fileURLToPath(new URL('./alpd.js', import.meta.url)); } catch { return undefined; } };
  const candidates = [explicit, process.env.ALP_DAEMON_ENTRY, typeof __ALP_DAEMON_ENTRY__ === 'string' ? __ALP_DAEMON_ENTRY__ : undefined, beside()];
  return candidates.find(candidate => candidate && existsSync(candidate));
}

async function openBackend(options: Options): Promise<Backend> {
  const { home, daemonEntry: entry, embedded: inProcess, ...runtimeOptions } = options;
  if (inProcess || runtimeOptions.transport) {
    const runtime = createAlpRuntime({ ...runtimeOptions, templates });
    const server = createDaemonServer({ runtime, socketPath: '', version: 'embedded' });
    const client = server.local();
    return { client, async shutdown() { client.close(); await runtime.shutdown(); } };
  }
  const where = home ?? alpHome();
  const open = async (demand: boolean) => {
    const lock = await readLock(where);
    if (!demand && !(lockAlive(lock) && lock.ready) && await daemonHeld(where)) throw new Error('alpd was stopped with alp daemon stop');
    return connect(await startDaemon({ home: where, entry: daemonEntry(entry) }), { name: 'alp-paseo', version: '1' });
  };
  return { client: await open(true), async shutdown(client) { client.close(); }, relink: open };
}

/** How long a request waits for alpd to come back before it fails. */
const RELINK_WAIT_MS = 20_000;

const errorData = (error: unknown) => ({
  message: error instanceof Error ? error.message : String(error),
});

/** A session's config: the profile (or a child's own model), its permission mode; model and effort are fixed. */
const sessionConfig = (session: SessionSnapshot, thinking: string) => ({
  ...configModels(session),
  mode: session.mode,
  thinkingOption: thinking,
  modes,
  thinkingOptions: [],
  settings: [],
});

function timelineItem(item: TimelineItem): ProviderTimelineItem {
  if (item.kind === 'user_message') return { type: 'user_message', id: item.id, text: item.text, ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}) };
  if (item.kind === 'assistant_message') return { type: 'assistant_message', id: item.id, text: item.text };
  if (item.kind === 'notice') return { type: 'notification', id: item.id, level: item.level, message: item.text } as ProviderTimelineItem;
  if (item.kind === 'todo') return { type: 'todo', id: item.id, items: item.items.map(entry => ({ id: entry.id, text: entry.text, status: entry.status, completed: entry.status === 'completed' })) };
  return {
    type: 'tool_call',
    id: item.id,
    callId: item.callId,
    name: item.name,
    ...(item.status === 'failed' ? { status: item.status, error: item.error ?? 'Tool call failed' } : { status: item.status, error: null }),
    detail: item.detail,
  } as ProviderTimelineItem;
}

export function createProvider(options: Options = {}): ProviderRegistration {
  return {
    id: 'alp',
    label: 'ALP',
    description: 'Filesystem-defined ALP agents backed by Codex or Claude Code',

    async connect(request) {
      if (!request.versions.includes(PROVIDER_PROTOCOL_VERSION)) {
        throw new Error('Unsupported Paseo provider protocol version');
      }

      const capabilities = negotiateProviderCapabilities(
        request.capabilities,
        supported,
      );

      const backend = await openBackend(options);
      let client = backend.client;
      const delegation = capabilities.includes('session.subsession');
      /** Questions to the user appear as Paseo question prompts on the root agent; without them, answer with the CLI. */
      const asksUser = capabilities.includes('permission');
      const questionRoots = new Map<string, string>();
      /** Roots this connection opened; children belong to their root. */
      const roots = new Set<string>();
      const listeners = new Set<(event: ProviderEvent) => void>();
      /** Request ids of client-initiated opens; children are opened by the runtime. */
      const opening = new Map<string, string>();
      /** Paseo names a resumed or imported root afresh; alpd keeps the original id. */
      const alpdIds = new Map<string, string>();
      const paseoIds = new Map<string, string>();
      const toAlpd = (sessionId: string) => alpdIds.get(sessionId) ?? sessionId;
      const toPaseo = (sessionId: string) => paseoIds.get(sessionId) ?? sessionId;
      let closed = false;
      /** Roots' directories, to reopen one that alpd no longer has open after a restart. */
      const cwds = new Map<string, string>();
      /** Roots alpd did not reopen after a restart: the next prompt reopens them. */
      const dormant = new Set<string>();
      /** A reconnection to alpd in progress; `demanded` once the user asks for something meanwhile. */
      let relinking: Promise<void> | undefined;
      let demanded = false;
      let lastError: unknown;

      const emit = (event: ProviderEvent) => {
        const checked = ProviderEventSchema.parse(event);
        for (const listener of listeners) listener(checked);
      };

      function project(envelope: Envelope) {
        const sessionId = toPaseo(envelope.sessionId);
        const { event } = envelope;
        switch (event.type) {
          case 'session.opened': {
            const { session } = event;
            // A root Paseo already shows, reopened after alpd restarted: only its config may have changed.
            if (roots.has(sessionId) && !opening.has(envelope.sessionId)) {
              emit({ type: 'session.config', sessionId, config: sessionConfig({ ...session, model: event.effective.model }, event.effective.thinking) });
              return;
            }
            const parentId = session.parentId && toPaseo(session.parentId);
            emit({
              type: 'session.opened',
              requestId: opening.get(envelope.sessionId) ?? `open-${sessionId}`,
              sessionId,
              cwd: event.cwd,
              capabilities,
              restoration: parentId ? 'parent' : 'core',
              ...(parentId
                ? { parentSessionId: parentId, toolCallId: session.toolCallId, title: `ALP ${session.agent} (${session.runtime})` }
                : {}),
              ...(session.persistent ? { persistence: handleFor(session) } : {}),
            });
            emit({ type: 'session.config', sessionId, config: sessionConfig({ ...session, model: event.effective.model }, event.effective.thinking) });
            return;
          }
          case 'session.ready':
            if (roots.has(sessionId) && !opening.has(envelope.sessionId)) return;
            emit({ type: 'session.ready', requestId: opening.get(envelope.sessionId) ?? `open-${sessionId}`, sessionId });
            return;
          case 'session.updated': {
            const { session } = event;
            emit({ type: 'session.config', sessionId, config: sessionConfig(session, session.thinking) });
            return;
          }
          case 'session.closed':
            emit({ type: 'session.closed', sessionId });
            return;
          case 'session.failed':
            emit({ type: 'session.runtime_failed', sessionId, error: event.error });
            return;
          case 'prompt.accepted':
            emit({ type: 'session.prompt_result', sessionId, clientMessageId: event.clientMessageId, result: { type: event.result, turnId: event.turnId } });
            return;
          case 'prompt.failed':
            emit({ type: 'session.prompt_result', sessionId, clientMessageId: event.clientMessageId, result: { type: 'failed', error: event.error } });
            return;
          case 'turn.started':
            emit({ type: 'session.turn', sessionId, turnId: event.turnId, state: 'started' });
            return;
          case 'turn.ended':
            emit({ type: 'session.turn', sessionId, turnId: event.turnId, state: event.state, ...(event.error ? { error: event.error } : {}) });
            return;
          case 'item':
            emit({ type: 'timeline.item', sessionId, item: timelineItem(event.item) });
            return;
          case 'question': {
            const { question } = event;
            if (!asksUser) return;
            const root = toPaseo(question.rootId);
            questionRoots.set(question.id, root);
            emit({
              type: 'session.permission',
              sessionId: root,
              request: {
                id: question.id,
                name: 'alp_ask',
                kind: 'question',
                title: `${question.agent} asks you`,
                description: question.body,
                input: { questions: [{ id: '0', header: 'Answer', question: question.body, options: (question.options ?? []).map(label => ({ label })), isOther: true, allowOther: true }] },
                metadata: { agent: question.agent, alpSessionId: question.sessionId },
              },
            });
            return;
          }
          case 'question.resolved': {
            const root = questionRoots.get(event.questionId);
            if (!root) return;
            questionRoots.delete(event.questionId);
            emit({ type: 'session.permission_resolved', sessionId: root, permissionId: event.questionId });
            return;
          }
          // Mail and assignments reach Paseo through the agents' own timelines; the board through alp board.
          case 'mail':
          case 'assignment':
          case 'pin':
          case 'unpin':
            return;
        }
      }

      const notify = (sessionId: string, level: 'info' | 'warning' | 'error', message: string) =>
        emit({ type: 'timeline.item', sessionId, item: { type: 'notification', id: `alp-link-${randomUUID()}`, level, message } as ProviderTimelineItem });

      function wire(connection: DaemonConnection) {
        connection.onEvent(project);
        // An older connection closing after a reconnect is not news.
        connection.onClose(error => { if (connection === client) lost(error); });
      }

      /** alpd went away. In-process backends end their sessions; alpd is started again and its sessions picked up. */
      function lost(error: unknown) {
        if (closed) return;
        if (!backend.relink) {
          for (const sessionId of roots) emit({ type: 'session.runtime_failed', sessionId, error: errorData(error) });
          roots.clear();
          return;
        }
        if (relinking) return;
        for (const sessionId of roots) notify(sessionId, 'warning', `ALP lost its connection to alpd (${errorData(error).message}); reconnecting. Work that was running continues once alpd is back.`);
        relinking = relink().finally(() => { relinking = undefined; });
      }

      async function relink() {
        for (let attempt = 0; !closed; attempt++) {
          try {
            const next = await backend.relink!(demanded);
            if (closed) { next.close(); return; }
            client = next;
            wire(next);
            for (const sessionId of [...roots]) await reattach(sessionId);
            demanded = false;
            for (const sessionId of roots) notify(sessionId, 'info', 'ALP reconnected to alpd.');
            return;
          } catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, Math.min(250 * 2 ** attempt, 5_000)));
          }
        }
      }

      /** Follows a root again in the new alpd; one alpd did not reopen waits for its next prompt. */
      async function reattach(sessionId: string) {
        const alpdId = toAlpd(sessionId);
        try {
          const { session } = await client.request('session.get', { sessionId: alpdId });
          await client.request('session.attach', { sessionId: alpdId, replay: false });
          if (session.status === 'idle' || session.status === 'running') dormant.delete(sessionId);
          else dormant.add(sessionId);
        } catch (error) {
          roots.delete(sessionId);
          emit({ type: 'session.runtime_failed', sessionId, error: errorData(error) });
        }
      }

      /** Reopens a dormant root before it is used, unless alpd reopened it meanwhile. */
      async function wake(sessionId: string) {
        if (!dormant.has(sessionId)) return;
        const alpdId = toAlpd(sessionId);
        const { session } = await client.request('session.get', { sessionId: alpdId });
        if (session.status !== 'idle' && session.status !== 'running') {
          await client.request('session.create', { sessionId: alpdId, spec: { cwd: cwds.get(sessionId) ?? session.projectRoot }, resume: true, delegation });
        }
        dormant.delete(sessionId);
      }

      /** Waits for alpd when it is coming back; asking makes it start even after a deliberate stop. */
      async function linked() {
        if (!relinking) return;
        demanded = true;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`alpd is not reachable${lastError ? `: ${errorData(lastError).message}` : ''}; ALP keeps trying to start it`)), RELINK_WAIT_MS); });
        try { await Promise.race([relinking, timeout]); } finally { clearTimeout(timer); }
      }

      wire(client);

      async function handle(input: ProviderInput) {
        requireProviderCapabilities(
          capabilities,
          input,
        );

        if (input.type === 'catalog') {
          emit({
            type: 'catalog',
            requestId: input.requestId,
            catalog: {
              models: profileModels,
              modes,
              thinkingOptions: [],
              defaultModel: DEFAULT_PROFILE,
              defaultMode: 'full-access',
            },
          });
          return;
        }

        if (input.type === 'sessions') {
          const { sessions } = await client.request('session.list', { projectRoot: input.cwd ? path.resolve(input.cwd) : undefined, rootsOnly: true, includeClosed: true });
          const query = input.query?.toLowerCase();
          emit({
            type: 'sessions',
            requestId: input.requestId,
            sessions: sessions
              .filter((session: any) => session.persistent && (!query || `${session.title ?? ''} ${session.agent}`.toLowerCase().includes(query)))
              .slice(0, input.limit ?? 50)
              .map((session: any) => ({
                persistence: handleFor(session),
                cwd: session.projectRoot,
                title: session.title ? `${session.agent}: ${session.title}` : `ALP ${session.agent}`,
                description: `${profiles[profileFor(session.workflow?.mode) as keyof typeof profiles]?.label ?? 'ALP'} · ${session.runtime}:${session.model} · ${session.status}`,
                ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
              })),
          });
          return;
        }

        if (input.type === 'session.open') {
          const named = alpdSessionOf(input.config, input.persistence);
          const alpdId = named ?? input.sessionId;
          opening.set(alpdId, input.requestId);
          alpdIds.set(input.sessionId, alpdId);
          paseoIds.set(alpdId, input.sessionId);
          try {
            await client.request('session.create', { sessionId: alpdId, spec: toSessionSpec(input.config, input.persistence), history: input.history, delegation, resume: named !== undefined });
            roots.add(input.sessionId);
            cwds.set(input.sessionId, input.config.cwd);
          } catch (error) {
            alpdIds.delete(input.sessionId);
            paseoIds.delete(alpdId);
            throw error;
          } finally {
            opening.delete(alpdId);
          }
          return;
        }

        if (!('sessionId' in input)) {
          throw new Error(
            `Unsupported operation '${input.type}'`,
          );
        }

        // The answer to a question an agent asked the user.
        if (input.type === 'session.permission') {
          const { response } = input;
          if (response.behavior === 'allow') {
            const answers = (response.updatedInput as { answers?: Record<string, unknown> } | undefined)?.answers ?? {};
            const text = [answers.Answer, ...Object.values(answers)].find((value): value is string => typeof value === 'string' && !!value.trim());
            if (!text) throw new Error('Type an answer before submitting');
            await client.request('question.answer', { questionId: input.permissionId, text });
          } else {
            await client.request('question.answer', { questionId: input.permissionId, dismiss: true, ...(response.message ? { reason: response.message } : {}) });
          }
          return;
        }

        if (input.type === 'session.prompt') {
          const { prompt } = input;
          await wake(input.sessionId);
          await client.request('session.prompt', {
            sessionId: toAlpd(input.sessionId),
            clientMessageId: prompt.clientMessageId,
            delivery: prompt.delivery === 'steer' ? 'steer' : 'auto',
            content: prompt.input.type === 'message' ? prompt.input.content : [{ type: prompt.input.type }],
          });
          return;
        }

        // The daemon checks that the session is open, in order with earlier inputs.
        if (input.type === 'session.configure') {
          if (input.changes.model !== undefined || input.changes.settings?.workflow !== undefined) throw new Error('The profile is fixed for this session; choose Phở or Cafe when creating a new session');
          if (Object.keys(input.changes).some(key => key !== 'mode')) throw new Error('Only permission mode can be changed in an existing ALP session');
          await wake(input.sessionId);
          await client.request('session.configure', { sessionId: toAlpd(input.sessionId), mode: input.changes.mode === undefined ? undefined : input.changes.mode ?? 'read-only' });
        } else if (input.type === 'session.close') {
          // Closing a view: alpd closes the session once idle, or lets running work finish.
          await client.request('session.release', { sessionId: toAlpd(input.sessionId) });
          roots.delete(input.sessionId);
          cwds.delete(input.sessionId);
          dormant.delete(input.sessionId);
        } else if (input.type === 'session.interrupt') {
          await client.request('session.interrupt', { sessionId: toAlpd(input.sessionId) });
        } else {
          throw new Error(
            `Unsupported operation '${input.type}'`,
          );
        }

        emit({ type: 'request.completed', requestId: input.requestId });
      }

      return {
        version:
          PROVIDER_PROTOCOL_VERSION,
        capabilities,

        onEvent(listener) {
          listeners.add(listener);

          return () => {
            listeners.delete(listener);
          };
        },

        async send(raw) {
          if (closed) {
            throw new Error(
              'Provider connection is closed',
            );
          }

          const input =
            ProviderInputSchema.parse(
              raw,
            );

          try {
            await linked();
            try {
              await handle(input);
            } catch (error) {
              // The request beat the news that alpd went away: wait for it to come back and try once more.
              if (!backend.relink || closed || !client.closed) throw error;
              lost(error);
              await linked();
              await handle(input);
            }
          } catch (error) {
            if (input.type === 'session.prompt') {
              emit({ type: 'session.prompt_result', sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: 'failed', error: errorData(error) } });
            } else if (
              'requestId' in input
            ) {
              emit({
                type: 'request.failed',
                requestId:
                  input.requestId,
                error:
                  errorData(error),
              });
            } else {
              throw error;
            }
          }
        },

        async close() {
          closed = true;
          await Promise.all([...roots].map(sessionId => client.request('session.release', { sessionId: toAlpd(sessionId) }).catch(() => {})));
          roots.clear();
          await backend.shutdown(client);
          listeners.clear();
        },
      };
    },
  };
}
