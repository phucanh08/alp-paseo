import { randomUUID } from 'node:crypto';
import { resolveDelegation } from '../../../src/core/delegation.js';
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
  type ProviderSessionConfig,
} from './compat.js';
import { CodexTransport } from './transport.js';
import { ClaudeTransport } from './claude-transport.js';
import { mapSession, DEFAULT_MODEL, modes, models, thinkingOptions, thinkingOptionsFor } from './mapping.js';

const supported = [
  'prompt.message',
  'prompt.steer',
  'session.persistence',
  'session.subsession',
] as const;

type RuntimeKind = 'codex' | 'claude';

type RuntimeTransport = {
  request(method: string, params: any): Promise<any>;
  initialize(): Promise<void>;
  onNotification(listener: (method: string, params: any) => void): void;
  onFailure(listener: (error: unknown) => void): void;
  close(): Promise<void>;
  onRequest?: (listener: (method: string, params: any) => Promise<unknown>) => void;
};

type Mapping = Awaited<ReturnType<typeof mapSession>>;

type Session = {
  runtimeKind: RuntimeKind;
  runtime: RuntimeTransport;
  mapping: Mapping;
  threadId: string;
  active?: string;

  pending: boolean;
  buffered: Array<[string, any]>;
  closed: boolean;

  seen: Set<string>;
  text: Map<string, string>;

  config: ProviderSessionConfig;
  graph: Record<string, string[]>;
  ancestry: string[];

  parent?: string;
  children: Set<string>;

  delegating: boolean;
  calls: number;

  toolCalls: Map<string, Promise<unknown>>;
  acknowledged: Promise<void>;

  settle?: (state: string, error?: unknown) => void;
};

type Options = {
  codexCommand?: string;
  claudeCommand?: string;
  environment?: NodeJS.ProcessEnv;

  /**
   * Optional transport factory for tests/custom runtimes.
   * When omitted, ALP creates CodexTransport itself.
   */
  transport?: (
    cwd: string,
    env: NodeJS.ProcessEnv,
    runtime?: RuntimeKind,
  ) => RuntimeTransport;

  delegationTimeoutMs?: number;
};

const errorData = (error: unknown) => ({
  message: error instanceof Error ? error.message : String(error),
});

function runtimeKindOf(mapping: Mapping): RuntimeKind {
  return mapping.runtimeKind;
}

function createRuntime(
  options: Options,
  runtimeKind: RuntimeKind,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): RuntimeTransport {
  if (options.transport) {
    return options.transport(cwd, environment, runtimeKind);
  }

  if (runtimeKind === 'claude') {
    return new ClaudeTransport(
      options.claudeCommand ?? process.env.ALP_CLAUDE_BIN ?? 'claude',
      cwd,
      environment,
    );
  }

  return new CodexTransport(
    options.codexCommand ?? process.env.ALP_CODEX_BIN ?? 'codex',
    cwd,
    environment,
  );
}

/**
 * The provider speaks a normalized runtime protocol to its adapter.
 *
 * CodexTransport and ClaudeTransport map it to each native harness.
 *
 * This provider therefore owns orchestration only; the transport adapters
 * preserve the full native harness underneath.
 */
function nativeSessionConfig(
  runtimeKind: RuntimeKind,
  mapping: Mapping,
  targets: string[],
) {
  const delegationInstruction = targets.length
    ? `Use alp_delegate to assign bounded work to: ${targets.join(', ')}. ` +
      'It starts a real child session and waits for the handoff. ' +
      'Only one child runs at a time. ' +
      'Do not run shell/file mutations in parallel with delegation. ' +
      'Include scope, constraints, verification, and required handoff in task. ' +
      'Child inherits your mode unless you request read-only. ' +
      'Review its returned evidence before answering. ' +
      'Do not use native spawn tools or shell-launched agents to bypass this route.'
    : 'No delegation targets are authorized. ' +
      'Do not spawn agents or use shell-launched agents. ' +
      'Complete your assigned scope and return evidence.';

  return {
    runtime: runtimeKind,
    cwd: mapping.agent.projectRoot,
    model: mapping.model,
    sandbox: mapping.mode,
    approvalPolicy: 'never',

    developerInstructions: [
      mapping.instructions,
      `ALP runtime identity: ${mapping.agent.name}. ${delegationInstruction}`,
    ].join('\n\n'),

    mcpServers: mapping.mcp,
    thinking: mapping.thinking,

    /**
     * ALP owns multi-agent orchestration.
     *
     * The adapter must disable/bypass the harness' native agent spawning
     * while preserving all other native Codex capabilities.
     */
    nativeMultiAgent: false,

    dynamicTools: targets.length
      ? [
          {
            type: 'function',
            name: 'alp_delegate',
            description:
              'Delegate a bounded task to an authorized ALP agent and wait for its real handoff.',
            inputSchema: {
              type: 'object',
              properties: {
                agent: {
                  type: 'string',
                  enum: targets,
                },
                task: {
                  type: 'string',
                  description:
                    'Complete brief: objective, scope, constraints, verification, handoff.',
                },
                mode: {
                  type: 'string',
                  enum: ['read-only', 'workspace-write'],
                },
              },
              required: ['agent', 'task'],
              additionalProperties: false,
            },
          },
        ]
      : [],
  };
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

      const sessions = new Map<string, Session>();

      const childContexts = new Map<
        string,
        {
          parent: string;
          callId: string;
          graph: Record<string, string[]>;
          ancestry: string[];
        }
      >();

      const listeners = new Set<(event: ProviderEvent) => void>();

      let closed = false;
      let queue = Promise.resolve();

      const emit = (event: ProviderEvent) => {
        const checked = ProviderEventSchema.parse(event);
        for (const listener of listeners) listener(checked);
      };

      const persist = (session: Session): ProviderPersistence => ({
        version: 1,
        data: {
          threadId: session.threadId,
          agent: session.mapping.agent.name,
          cwd: session.mapping.agent.projectRoot,
          runtime: session.runtimeKind,
          model: session.mapping.model,
        },
      });

      function terminal(
        sessionId: string,
        session: Session,
        state: 'completed' | 'failed' | 'canceled',
        error?: unknown,
      ) {
        if (!session.active) return;

        emit({
          type: 'session.turn',
          sessionId,
          turnId: session.active,
          state,
          ...(error ? { error: errorData(error) } : {}),
        });

        session.active = undefined;
        session.settle?.(state, error);
      }

      function nativeItem(
        sessionId: string,
        session: Session,
        item: any,
      ) {
        if (item.type === 'agentMessage') {
          session.text.set(item.id, item.text);

          emit({
            type: 'timeline.item',
            sessionId,
            item: {
              type: 'assistant_message',
              id: item.id,
              text: item.text,
            },
          });

          return;
        }

        if (item.type === 'userMessage') {
          const text = (item.content ?? [])
            .filter((c: any) => c.type === 'text')
            .map((c: any) => c.text)
            .join('\n');

          emit({
            type: 'timeline.item',
            sessionId,
            item: {
              type: 'user_message',
              id: item.id,
              text,
            },
          });

          return;
        }

        if (item.type === 'dynamicToolCall') {
          const status =
            item.status === 'inProgress'
              ? 'running'
              : item.success === false || item.status === 'failed'
                ? 'failed'
                : 'completed';

          emit({
            type: 'timeline.item',
            sessionId,
            item: {
              type: 'tool_call',
              id: item.id,
              callId: item.callId ?? item.id,
              name: item.tool,
              ...(status === 'failed'
                ? { status, error: 'Delegation failed' }
                : { status, error: null }),
              detail: {
                type: 'unknown',
                input: item.arguments ?? {},
                output: item.contentItems ?? null,
              },
            },
          });

          return;
        }

        if (item.type === 'commandExecution') {
          const status =
            item.status === 'inProgress'
              ? 'running'
              : item.status === 'completed'
                ? 'completed'
                : 'failed';

          emit({
            type: 'timeline.item',
            sessionId,
            item: {
              type: 'tool_call',
              id: item.id,
              callId: item.id,
              name: 'shell',
              ...(status === 'failed'
                ? { status, error: 'Command failed' }
                : { status, error: null }),
              detail: {
                type: 'shell',
                command: item.command,
                cwd: item.cwd,
                output: item.aggregatedOutput ?? '',
                exitCode: item.exitCode,
              },
            },
          });
        }
      }

      function notification(
        sessionId: string,
        session: Session,
        method: string,
        params: any,
      ) {
        if (session.closed) return;

        if (session.pending) {
          session.buffered.push([method, params]);
          return;
        }

        if (params?.threadId && params.threadId !== session.threadId) return;

        if (method === 'item/agentMessage/delta') {
          const text =
            (session.text.get(params.itemId) ?? '') + params.delta;

          session.text.set(params.itemId, text);

          emit({
            type: 'timeline.item',
            sessionId,
            item: {
              type: 'assistant_message',
              id: params.itemId,
              text,
            },
          });

          return;
        }

        if (method === 'item/completed' || method === 'item/started') {
          if (params.item?.type !== 'userMessage') {
            nativeItem(sessionId, session, params.item);
          }
          return;
        }

        if (
          method === 'turn/completed' &&
          params.turn.id === session.active
        ) {
          const state =
            params.turn.status === 'completed'
              ? 'completed'
              : params.turn.status === 'interrupted'
                ? 'canceled'
                : 'failed';

          terminal(
            sessionId,
            session,
            state,
            params.turn.error?.message,
          );
        }
      }

      async function closeSession(sessionId: string) {
        const session = sessions.get(sessionId);
        if (!session || session.closed) return;

        session.closed = true;

        await Promise.all(
          [...session.children].map(closeSession),
        );

        terminal(sessionId, session, 'canceled');
        session.settle?.('canceled', 'Session closed');

        await session.runtime.close();

        sessions.delete(sessionId);

        if (session.parent) {
          sessions.get(session.parent)?.children.delete(sessionId);
        }

        emit({
          type: 'session.closed',
          sessionId,
        });
      }

      const toolResult = (
        success: boolean,
        value: unknown,
      ) => ({
        success,
        contentItems: [
          {
            type: 'inputText',
            text: JSON.stringify(value),
          },
        ],
      });

      async function delegate(
        sessionId: string,
        session: Session,
        params: any,
      ): Promise<unknown> {
        await session.acknowledged;

        if (
          session.closed ||
          !session.active ||
          params.threadId !== session.threadId ||
          params.turnId !== session.active
        ) {
          return toolResult(false, {
            error: 'Delegation requires the current active turn',
          });
        }

        if (
          params.tool !== 'alp_delegate' ||
          params.namespace != null ||
          typeof params.callId !== 'string'
        ) {
          return toolResult(false, {
            error: 'Unknown delegation tool',
          });
        }

        const cached = session.toolCalls.get(params.callId);
        if (cached) return cached;

        const work = runDelegation(
          sessionId,
          session,
          params,
        );

        session.toolCalls.set(params.callId, work);
        return work;
      }

      async function runDelegation(
        sessionId: string,
        session: Session,
        params: any,
      ): Promise<unknown> {
        const args = params.arguments;

        const targets = Object.hasOwn(
          session.graph,
          session.mapping.agent.name,
        )
          ? session.graph[session.mapping.agent.name]
          : [];

        if (
          !args ||
          typeof args !== 'object' ||
          Array.isArray(args) ||
          Object.keys(args).some(
            (key) => !['agent', 'task', 'mode'].includes(key),
          ) ||
          !targets.includes(args.agent) ||
          typeof args.task !== 'string' ||
          !args.task.trim() ||
          args.task.length > 32000 ||
          (
            args.mode !== undefined &&
            !['read-only', 'workspace-write'].includes(args.mode)
          )
        ) {
          return toolResult(false, {
            error: 'Invalid assignment or unauthorized target',
          });
        }

        if (session.delegating) {
          return toolResult(false, {
            error:
              'A child assignment is already running; wait for its handoff',
          });
        }

        if (
          session.ancestry.includes(args.agent) ||
          session.ancestry.length >= 4
        ) {
          return toolResult(false, {
            error: 'Delegation depth/cycle limit',
          });
        }

        if (
          session.mapping.mode === 'read-only' &&
          args.mode === 'workspace-write'
        ) {
          return toolResult(false, {
            error: 'Child cannot exceed parent permissions',
          });
        }

        let root = session;
        while (
          root.parent &&
          sessions.has(root.parent)
        ) {
          root = sessions.get(root.parent)!;
        }

        if (root.calls >= 16) {
          return toolResult(false, {
            error: 'Delegation limit reached for this turn',
          });
        }

        root.calls++;
        session.delegating = true;

        const childId = `alp-child-${randomUUID()}`;

        session.children.add(childId);

        childContexts.set(childId, {
          parent: sessionId,
          callId: params.callId,
          graph: session.graph,
          ancestry: [
            ...session.ancestry,
            args.agent,
          ],
        });

        let timer: NodeJS.Timeout | undefined;

        try {
          await handle({
            type: 'session.open',
            requestId: `open-${childId}`,
            sessionId: childId,
            history: 'skip',
            config: {
              ...session.config,
              persist: false,
              providerOptions: {
                agent: args.agent,
              },
              model: `${session.runtimeKind}:${session.mapping.model}`,
              thinkingOption: session.mapping.thinking,
              mode: args.mode ?? session.mapping.mode,
            },
          });

          const child = sessions.get(childId);

          if (
            !child ||
            session.closed ||
            session.active !== params.turnId
          ) {
            throw new Error(
              'Parent stopped before child became ready',
            );
          }

          const outcome = new Promise<{
            state: string;
            error?: unknown;
          }>((resolve) => {
            child.settle = (state, error) =>
              resolve({ state, error });

            timer = setTimeout(
              () =>
                resolve({
                  state: 'failed',
                  error: 'Delegation timed out',
                }),
              options.delegationTimeoutMs ?? 600_000,
            );
          });

          await handle({
            type: 'session.prompt',
            sessionId: childId,
            prompt: {
              clientMessageId: `task-${childId}`,
              delivery: 'auto',
              input: {
                type: 'message',
                content: [
                  {
                    type: 'text',
                    text:
                      `Assignment from ${session.mapping.agent.name}. ` +
                      'Return your evidence and handoff to that agent.\n\n' +
                      args.task,
                  },
                ],
              },
            },
          });

          const result = await outcome;

          if (
            session.closed ||
            session.active !== params.turnId
          ) {
            return toolResult(false, {
              agent: args.agent,
              status: 'canceled',
              error: 'Parent assignment stopped',
            });
          }

          if (
            result.state === 'failed' &&
            child.active
          ) {
            terminal(
              childId,
              child,
              'failed',
              result.error,
            );
          }

          const text = [
            ...child.text.values(),
          ].join('\n');

          return toolResult(
            result.state === 'completed',
            {
              agent: args.agent,
              runtime: child.runtimeKind,
              sessionId: childId,
              threadId: child.threadId,
              status: result.state,
              output: text,
              ...(result.error
                ? {
                    error:
                      errorData(result.error).message,
                  }
                : {}),
            },
          );
        } catch (error) {
          return toolResult(false, {
            agent: args.agent,
            error: errorData(error).message,
          });
        } finally {
          clearTimeout(timer);

          await closeSession(childId);

          childContexts.delete(childId);
          session.children.delete(childId);
          session.delegating = false;
        }
      }

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
              /**
               * Keep Paseo's existing generic model selector.
               * Per-agent runtime/model selection is resolved by mapSession().
               *
               * If you want Paseo UI to expose native model catalogs later,
               * aggregate them in mapping/catalog code instead
               * of hard-coding provider-specific model IDs here.
               */
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
          if (sessions.has(input.sessionId)) {
            throw new Error(
              'Session is already open',
            );
          }

          const mapping = await mapSession(
            input.config,
            input.persistence,
          );

          const runtimeKind =
            runtimeKindOf(mapping);

          const context =
            childContexts.get(input.sessionId);

          const graph =
            context?.graph ??
            await resolveDelegation(
              mapping.agent.projectRoot,
            );

          const targets: string[] =
            Object.hasOwn(
              graph,
              mapping.agent.name,
            )
              ? graph[mapping.agent.name]
              : [];

          if (
            context &&
            (
              !sessions.has(context.parent) ||
              sessions.get(context.parent)!.closed ||
              !sessions.get(context.parent)!.active
            )
          ) {
            throw new Error(
              'Parent assignment stopped during child open',
            );
          }

          const environment = {
            ...(options.environment ?? process.env),
            ...mapping.env,
          };

          for (
            const key of Object.keys(environment)
          ) {
            if (
              /^(PASEO_|CODEX_THREAD_ID$|CODEX_INTERNAL_|CODEX_PARENT_|CLAUDE_CODE_|ANTHROPIC_AGENT_)/.test(
                key,
              )
            ) {
              delete environment[key];
            }
          }

          const runtime = createRuntime(
            options,
            runtimeKind,
            mapping.agent.projectRoot,
            environment,
          );

          const session: Session = {
            runtimeKind,
            runtime,
            mapping,
            threadId: '',
            pending: true,
            buffered: [],
            closed: false,
            seen: new Set(),
            text: new Map(),

            config: input.config,
            graph,
            ancestry:
              context?.ancestry ??
              [mapping.agent.name],
            parent: context?.parent,

            children: new Set(),
            delegating: false,
            calls: 0,

            toolCalls: new Map(),
            acknowledged: Promise.resolve(),
          };

          runtime.onRequest?.(
            (_method, params) =>
              delegate(
                input.sessionId,
                session,
                params,
              ),
          );

          sessions.set(
            input.sessionId,
            session,
          );

          runtime.onNotification(
            (method, params) =>
              notification(
                input.sessionId,
                session,
                method,
                params,
              ),
          );

          runtime.onFailure((error) => {
            if (!session.closed) {
              terminal(
                input.sessionId,
                session,
                'failed',
                error,
              );

              session.settle?.(
                'failed',
                error,
              );

              void closeSession(
                input.sessionId,
              );

              emit({
                type: 'session.runtime_failed',
                sessionId: input.sessionId,
                error: errorData(error),
              });
            }
          });

          try {
            await runtime.initialize();

            if (session.closed) {
              throw new Error(
                'Session closed during initialization',
              );
            }

            if (
              targets.length &&
              !runtime.onRequest
            ) {
              throw new Error(
                `${runtimeKind} runtime transport does not support delegation`,
              );
            }

            if (
              targets.length &&
              !capabilities.includes(
                'session.subsession',
              )
            ) {
              throw new Error(
                'Host does not support delegated sessions',
              );
            }

            const nativeConfig =
              nativeSessionConfig(
                runtimeKind,
                mapping,
                targets,
              );

            const result = mapping.threadId
              ? await runtime.request(
                  'thread/resume',
                  {
                    ...nativeConfig,
                    threadId:
                      mapping.threadId,
                  },
                )
              : await runtime.request(
                  'thread/start',
                  {
                    ...nativeConfig,
                    ephemeral:
                      !mapping.persist,
                  },
                );

            session.threadId =
              result.thread.id;

            if (session.closed) {
              throw new Error(
                'Session closed during thread creation',
              );
            }

            session.pending = false;
            session.buffered = [];

            emit({
              type: 'session.opened',
              requestId: input.requestId,
              sessionId: input.sessionId,
              cwd:
                result.cwd ??
                mapping.agent.projectRoot,
              capabilities,
              restoration: context
                ? 'parent'
                : 'core',
              ...(context
                ? {
                    parentSessionId:
                      context.parent,
                    toolCallId:
                      context.callId,
                    title:
                      `ALP ${mapping.agent.name} (${runtimeKind})`,
                  }
                : {}),
              ...(mapping.persist
                ? {
                    persistence:
                      persist(session),
                  }
                : {}),
            });

            emit({
              type: 'session.config',
              sessionId: input.sessionId,
              config: {
                model:
                  result.model ??
                  mapping.model,
                mode: mapping.mode,
                thinkingOption:
                  result.reasoningEffort ??
                  mapping.thinking,
                models,
                modes,
                thinkingOptions: thinkingOptionsFor(runtimeKind, mapping.model),
                settings: [],
              },
            });

            if (
              input.history === 'replay'
            ) {
              for (
                const turn of
                result.thread.turns ?? []
              ) {
                for (
                  const item of
                  turn.items ?? []
                ) {
                  nativeItem(
                    input.sessionId,
                    session,
                    item,
                  );
                }
              }
            }

            emit({
              type: 'session.ready',
              requestId: input.requestId,
              sessionId: input.sessionId,
            });
          } catch (error) {
            session.closed = true;
            sessions.delete(
              input.sessionId,
            );

            await runtime.close();

            throw error;
          }

          return;
        }

        if (!('sessionId' in input)) {
          throw new Error(
            `Unsupported operation '${input.type}'`,
          );
        }

        const session =
          sessions.get(input.sessionId);

        if (
          !session ||
          session.closed
        ) {
          throw new Error(
            'Session is not open',
          );
        }

        if (input.type === 'session.close') {
          await closeSession(
            input.sessionId,
          );

          emit({
            type: 'request.completed',
            requestId: input.requestId,
          });

          return;
        }

        if (
          input.type ===
          'session.interrupt'
        ) {
          const activeTurn =
            session.active;

          terminal(
            input.sessionId,
            session,
            'canceled',
          );

          await Promise.all(
            [...session.children].map(
              closeSession,
            ),
          );

          if (activeTurn) {
            await session.runtime.request(
              'turn/interrupt',
              {
                threadId:
                  session.threadId,
                turnId: activeTurn,
              },
            );
          }

          emit({
            type: 'request.completed',
            requestId: input.requestId,
          });

          return;
        }

        if (
          input.type !== 'session.prompt'
        ) {
          throw new Error(
            `Unsupported operation '${input.type}'`,
          );
        }

        const prompt = input.prompt;

        if (
          session.seen.has(
            prompt.clientMessageId,
          )
        ) {
          return;
        }

        if (
          prompt.input.type !==
            'message' ||
          prompt.input.content.some(
            (content) =>
              content.type !== 'text',
          )
        ) {
          throw new Error(
            'Only text prompts are supported',
          );
        }

        if (
          prompt.delivery === 'steer' &&
          !session.active
        ) {
          throw new Error(
            'No active turn to steer',
          );
        }

        if (
          prompt.delivery !== 'steer' &&
          session.active
        ) {
          throw new Error(
            'Turn already active; use steering or interrupt first',
          );
        }

        const text = prompt.input.content
          .map(
            (content) =>
              (content as {
                text: string;
              }).text,
          )
          .join('\n');

        if (
          prompt.delivery === 'steer'
        ) {
          await Promise.all(
            [...session.children].map(
              closeSession,
            ),
          );
        }

        session.pending = true;

        let acknowledged!: () => void;

        session.acknowledged =
          new Promise((resolve) => {
            acknowledged = resolve;
          });

        if (
          prompt.delivery !== 'steer'
        ) {
          session.text.clear();
          session.toolCalls.clear();

          if (!session.parent) {
            session.calls = 0;
          }
        }

        try {
          const nativeInput = [
            {
              type: 'text',
              text,
              text_elements: [],
            },
          ];

          const result =
            prompt.delivery === 'steer'
              ? await session.runtime.request(
                  'turn/steer',
                  {
                    threadId:
                      session.threadId,
                    expectedTurnId:
                      session.active,
                    clientUserMessageId:
                      prompt.clientMessageId,
                    input: nativeInput,
                  },
                )
              : await session.runtime.request(
                  'turn/start',
                  {
                    threadId:
                      session.threadId,
                    clientUserMessageId:
                      prompt.clientMessageId,
                    input: nativeInput,
                    effort:
                      session.mapping.thinking,
                  },
                );

          const turnId =
            prompt.delivery === 'steer'
              ? session.active!
              : result.turn.id;

          session.seen.add(
            prompt.clientMessageId,
          );

          emit({
            type: 'timeline.item',
            sessionId: input.sessionId,
            item: {
              type: 'user_message',
              id:
                `user:${prompt.clientMessageId}`,
              clientMessageId:
                prompt.clientMessageId,
              text,
            },
          });

          emit({
            type: 'session.prompt_result',
            sessionId: input.sessionId,
            clientMessageId:
              prompt.clientMessageId,
            result: {
              type:
                prompt.delivery ===
                'steer'
                  ? 'steer'
                  : 'turn',
              turnId,
            },
          });

          if (
            prompt.delivery !== 'steer'
          ) {
            session.active = turnId;

            emit({
              type: 'session.turn',
              sessionId:
                input.sessionId,
              turnId,
              state: 'started',
            });
          }
        } finally {
          session.pending = false;
          acknowledged();

          for (
            const [method, params] of
            session.buffered.splice(0)
          ) {
            notification(
              input.sessionId,
              session,
              method,
              params,
            );
          }
        }
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

        send(raw) {
          const work = queue.then(
            async () => {
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
                if (
                  input.type ===
                  'session.prompt'
                ) {
                  const session =
                    sessions.get(
                      input.sessionId,
                    );

                  if (
                    session?.seen.has(
                      input.prompt
                        .clientMessageId,
                    )
                  ) {
                    return;
                  }

                  session?.seen.add(
                    input.prompt
                      .clientMessageId,
                  );

                  emit({
                    type:
                      'session.prompt_result',
                    sessionId:
                      input.sessionId,
                    clientMessageId:
                      input.prompt
                        .clientMessageId,
                    result: {
                      type: 'failed',
                      error:
                        errorData(error),
                    },
                  });
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
          );

          queue = work.catch(() => {});
          return work;
        },

        async close() {
          closed = true;

          await queue;

          await Promise.all(
            [...sessions.keys()].map(
              closeSession,
            ),
          );

          listeners.clear();
        },
      };
    },
  };
}
