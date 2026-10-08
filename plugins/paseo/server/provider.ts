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
import { createAlpRuntime, type RuntimeOptions, type SessionSnapshot, type TimelineItem, type Envelope } from '../../../src/runtime/index.js';
import { DEFAULT_MODEL, models, modes, templates, thinkingOptions, thinkingOptionsFor, toSessionSpec } from './mapping.js';

/**
 * Paseo is a viewer of the ALP runtime: this provider translates Paseo inputs
 * into runtime calls and runtime events into Paseo events. Orchestration lives
 * in src/runtime.
 */

const supported = [
  'prompt.message',
  'prompt.steer',
  'session.persistence',
  'session.subsession',
  'session.configure',
] as const;

type Options = Omit<RuntimeOptions, 'templates' | 'subsessions'>;

const errorData = (error: unknown) => ({
  message: error instanceof Error ? error.message : String(error),
});

const persistence = (session: SessionSnapshot): ProviderPersistence => ({
  version: 1,
  data: {
    threadId: session.threadId,
    agent: session.agent,
    cwd: session.projectRoot,
    runtime: session.runtime,
    model: session.model,
    workflow: session.workflow,
  },
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

      const runtime = createAlpRuntime({ ...options, templates, subsessions: capabilities.includes('session.subsession') });
      const listeners = new Set<(event: ProviderEvent) => void>();
      /** Request ids of client-initiated opens; children are opened by the runtime. */
      const opening = new Map<string, string>();
      let closed = false;

      const emit = (event: ProviderEvent) => {
        const checked = ProviderEventSchema.parse(event);
        for (const listener of listeners) listener(checked);
      };

      function project({ sessionId, event }: Envelope) {
        switch (event.type) {
          case 'session.opened': {
            const { session } = event;
            emit({
              type: 'session.opened',
              requestId: opening.get(sessionId) ?? `open-${sessionId}`,
              sessionId,
              cwd: event.cwd,
              capabilities,
              restoration: session.parentId ? 'parent' : 'core',
              ...(session.parentId
                ? { parentSessionId: session.parentId, toolCallId: session.toolCallId, title: `ALP ${session.agent} (${session.runtime})` }
                : {}),
              ...(session.persistent ? { persistence: persistence(session) } : {}),
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
            emit({ type: 'session.ready', requestId: opening.get(sessionId) ?? `open-${sessionId}`, sessionId });
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

      runtime.onEvent(project);

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

        if (input.type === 'session.open') {
          opening.set(input.sessionId, input.requestId);
          try {
            await runtime.open(input.sessionId, toSessionSpec(input.config, input.persistence), { history: input.history });
          } finally {
            opening.delete(input.sessionId);
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
          await runtime.prompt(input.sessionId, {
            clientMessageId: prompt.clientMessageId,
            delivery: prompt.delivery === 'steer' ? 'steer' : 'auto',
            content: prompt.input.type === 'message' ? prompt.input.content : [{ type: prompt.input.type }],
          });
          return;
        }

        // The runtime checks that the session is open, in order with earlier inputs.
        if (input.type === 'session.configure') {
          if (input.changes.settings?.workflow !== undefined) throw new Error('Workflow is fixed for this session; select Smart or Supervised when creating a new session');
          if (Object.keys(input.changes).some(key => key !== 'mode')) throw new Error('Only permission mode can be changed in an existing ALP session');
          await runtime.configure(input.sessionId, { mode: input.changes.mode === undefined ? undefined : input.changes.mode ?? 'read-only' });
        } else if (input.type === 'session.close') {
          await runtime.close(input.sessionId);
        } else if (input.type === 'session.interrupt') {
          await runtime.interrupt(input.sessionId);
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
          await runtime.shutdown();
          listeners.clear();
        },
      };
    },
  };
}
