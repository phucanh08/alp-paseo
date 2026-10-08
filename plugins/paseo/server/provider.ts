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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAlpRuntime, type RuntimeOptions, type SessionSnapshot, type TimelineItem, type Envelope } from '../../../src/runtime/index.js';
import { createDaemonServer, type DaemonConnection } from '../../../src/daemon/server.js';
import { alpHome, connect, ensureDaemon } from '../../../src/client/index.js';
import { alpdSessionOf, DEFAULT_MODEL, handleFor, models, modes, templates, thinkingOptions, thinkingOptionsFor, toSessionSpec } from './mapping.js';

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

type Backend = { client: DaemonConnection; shutdown(): Promise<void> };

declare const __ALP_DAEMON_ENTRY__: string | undefined;

/**
 * Paseo recompiles and evaluates plugin code, so import.meta.url may not name this
 * bundle; the build also records alpd's absolute path.
 */
function daemonEntry(explicit?: string) {
  const beside = () => { try { return fileURLToPath(new URL('./alpd.js', import.meta.url)); } catch { return undefined; } };
  const candidates = [explicit, process.env.ALP_DAEMON_ENTRY, typeof __ALP_DAEMON_ENTRY__ === 'string' ? __ALP_DAEMON_ENTRY__ : undefined, beside()];
  const entry = candidates.find(candidate => candidate && existsSync(candidate));
  if (!entry) throw new Error('alpd is not installed next to the ALP plugin; set ALP_DAEMON_ENTRY to its alpd.js');
  return entry;
}

async function openBackend(options: Options): Promise<Backend> {
  const { home, daemonEntry: entry, embedded: inProcess, ...runtimeOptions } = options;
  if (inProcess || runtimeOptions.transport) {
    const runtime = createAlpRuntime({ ...runtimeOptions, templates });
    const server = createDaemonServer({ runtime, socketPath: '', version: 'embedded' });
    const client = server.local();
    return { client, async shutdown() { client.close(); await runtime.shutdown(); } };
  }
  const socket = await ensureDaemon({ home: home ?? alpHome(), entry: daemonEntry(entry) });
  const client = await connect(socket, { name: 'alp-paseo', version: '1' });
  return { client, async shutdown() { client.close(); } };
}

const errorData = (error: unknown) => ({
  message: error instanceof Error ? error.message : String(error),
});

const workflowSetting = (mode: string) => ({ type: 'select' as const, id: 'workflow', label: 'Workflow (new session only)', value: mode, options: [{ value: 'smart', label: 'Smart' }, { value: 'supervised', label: 'Supervised' }] });

function timelineItem(item: TimelineItem): ProviderTimelineItem {
  if (item.kind === 'user_message') return { type: 'user_message', id: item.id, text: item.text, ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}) };
  if (item.kind === 'assistant_message') return { type: 'assistant_message', id: item.id, text: item.text };
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

      const { client, shutdown } = await openBackend(options);
      const delegation = capabilities.includes('session.subsession');
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
            emit({
              type: 'session.config',
              sessionId,
              config: {
                model: event.effective.model,
                mode: session.mode,
                thinkingOption: event.effective.thinking,
                models,
                modes,
                thinkingOptions: thinkingOptionsFor(session.runtime, session.model),
                settings: [workflowSetting(session.workflow.mode)],
              },
            });
            return;
          }
          case 'session.ready':
            emit({ type: 'session.ready', requestId: opening.get(envelope.sessionId) ?? `open-${sessionId}`, sessionId });
            return;
          case 'session.updated': {
            const { session } = event;
            emit({ type: 'session.config', sessionId, config: {
              model: session.model, mode: session.mode, thinkingOption: session.thinking,
              models, modes, thinkingOptions: thinkingOptionsFor(session.runtime, session.model),
              settings: [workflowSetting(session.workflow.mode)],
            } });
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
          // Mail and assignments reach Paseo through the agents' own timelines.
          case 'mail':
          case 'assignment':
            return;
        }
      }

      client.onEvent(project);
      client.onClose(error => {
        if (closed) return;
        for (const sessionId of roots) emit({ type: 'session.runtime_failed', sessionId, error: errorData(error) });
        roots.clear();
      });

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
              models,
              modes,
              thinkingOptions,
              defaultModel: `codex:${DEFAULT_MODEL}`,
              defaultMode: 'read-only',
              defaultThinkingOption: 'medium',
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
                description: `${session.runtime}:${session.model} · ${session.status}`,
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

        if (input.type === 'session.prompt') {
          const { prompt } = input;
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
          if (input.changes.settings?.workflow !== undefined) throw new Error('Workflow is fixed for this session; select Smart or Supervised when creating a new session');
          if (Object.keys(input.changes).some(key => key !== 'mode')) throw new Error('Only permission mode can be changed in an existing ALP session');
          await client.request('session.configure', { sessionId: toAlpd(input.sessionId), mode: input.changes.mode === undefined ? undefined : input.changes.mode ?? 'read-only' });
        } else if (input.type === 'session.close') {
          // Closing a view: alpd closes the session once idle, or lets running work finish.
          await client.request('session.release', { sessionId: toAlpd(input.sessionId) });
          roots.delete(input.sessionId);
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
            await handle(input);
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
          await shutdown();
          listeners.clear();
        },
      };
    },
  };
}
