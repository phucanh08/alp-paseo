import { workflowGraphs } from '../../../src/core/workflow.js';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
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
  'session.configure',
] as const;

type RuntimeKind = 'codex' | 'claude';

type RuntimeTransport = {
  request(method: string, params: any): Promise<any>;
  initialize(): Promise<void>;
  orchestrationContext?: () => Promise<unknown>;
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

  delegating: number;
  peerCount: number;
  assignments: Map<string, string>;
  calls: number;

  toolCalls: Map<string, Promise<unknown>>;
  acknowledged: Promise<void>;

  settle?: (state: string, error?: unknown) => void;

  /** Requesting agent for a child assignment; enables alp_handoff. */
  parentAgent?: string;
  handoff?: Handoff;
};

const HANDOFF_OUTCOMES = ['complete', 'partial', 'blocked', 'reconsider'] as const;
const HANDOFF_LISTS = ['candidate', 'scope', 'verification', 'risks'] as const;

type Handoff = {
  outcome: typeof HANDOFF_OUTCOMES[number];
  summary: string;
  ownership?: string;
} & Partial<Record<typeof HANDOFF_LISTS[number], string[]>>;

const handoffList = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

const HANDOFF_TOOL = {
  type: 'function',
  name: 'alp_handoff',
  description: 'File the structured handoff for your current assignment. The requesting agent receives it when your turn ends.',
  inputSchema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: HANDOFF_OUTCOMES, description: 'complete, partial, blocked, or reconsider (the premise needs reconsideration).' },
      summary: { type: 'string', description: 'Result, answer, or findings the requester needs.' },
      candidate: handoffList('Artifacts or files produced; base and candidate SHA when applicable.'),
      scope: handoffList('Paths changed or read.'),
      verification: handoffList('Commands run with actual results, and checks not run.'),
      risks: handoffList('Unresolved findings, assumptions, and decisions needed.'),
      ownership: { type: 'string', description: 'Resources released or retained.' },
    },
    required: ['outcome', 'summary'],
    additionalProperties: false,
  },
};

/** Returns the normalized handoff, or an error message for the child. */
function parseHandoff(args: any): Handoff | string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Handoff must be an object';
  const allowed = ['outcome', 'summary', 'ownership', ...HANDOFF_LISTS];
  if (Object.keys(args).some(key => !allowed.includes(key))) return 'Unknown handoff field';
  if (!HANDOFF_OUTCOMES.includes(args.outcome)) return `outcome must be one of ${HANDOFF_OUTCOMES.join(', ')}`;
  if (typeof args.summary !== 'string' || !args.summary.trim()) return 'summary is required';
  if (args.ownership !== undefined && typeof args.ownership !== 'string') return 'ownership must be a string';
  const handoff: Handoff = { outcome: args.outcome, summary: args.summary };
  for (const key of HANDOFF_LISTS) {
    if (args[key] === undefined) continue;
    if (!Array.isArray(args[key]) || args[key].length > 100 || !args[key].every((item: unknown) => typeof item === 'string' && item.trim())) {
      return `${key} must be a list of at most 100 nonempty strings`;
    }
    handoff[key] = args[key];
  }
  if (args.ownership?.trim()) handoff.ownership = args.ownership;
  if (JSON.stringify(handoff).length > 32_000) return 'Handoff exceeds 32000 characters; summarize and point to files instead';
  return handoff;
}

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

  /** Directory for per-root-session assignment logs (JSONL). Omitted disables logging. */
  runLogDir?: string;
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
  parentAgent?: string,
) {
  const delegationInstruction = targets.length
    ? `Use alp_delegate to assign bounded work to: ${targets.join(', ')}. ` +
      'It starts a real child session and waits for the handoff. ' +
      'The result carries the child\'s structured handoff (null if it filed none) and output, its final message. ' +
      `At most ${mapping.workflow.maxPeers} peers may run concurrently. Concurrent assignments must be read-only; serialize writers in this shared checkout. ` +
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
      `Workflow: ${mapping.workflow.mode}; fixed for this session. In Smart, main implements or directly delegates to peer; do not create lead. In Supervised, main supervises lead; lead may implement or delegate to peer. The technical coordinator chooses each peer's model and effort. Use oracle for significant uncertainty; use reviewer for logic changes and risky changes, not mandatory for typo/format fixes. Advisors return only to their requesting coordinator.`,
      'Oracle must use the highest-capability available model, chosen from runtime catalog evidence, never a fixed model name or inherited default. Supply model, thinking, and modelReason explaining the premium choice; do not silently downgrade. If availability or ranking is unknown, say so. Usage context is advisory, may be unavailable or stale; never infer quota from token counts. Respect known exhausted limits and report them.',

      `ALP runtime identity: ${mapping.agent.name}. ${delegationInstruction}`,

      ...(parentAgent
        ? [`This session is an assignment from ${parentAgent}. Before ending your turn, call alp_handoff with outcome, summary, and the evidence fields that apply (candidate, scope, verification, risks, ownership). Calling it again replaces the earlier handoff. Then end with a one-line final message.`]
        : []),
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

    dynamicTools: [
      ...(targets.length
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
                model: { type: 'string', description: 'Explicit runtime-prefixed model ID from the available catalog.' },
                thinking: { type: 'string', description: 'Effort supported by the selected model.' },
                modelReason: { type: 'string', description: 'For oracle: evidence that this is the highest-capability available model.' },
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
      : []),
      ...(parentAgent ? [HANDOFF_TOOL] : []),
    ],
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
          workflow: Mapping['workflow'];
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
          workflow: session.mapping.workflow,
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
                ? { status, error: item.tool === 'alp_delegate' ? 'Delegation failed' : 'Tool call failed' }
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

      let runLogWrites = Promise.resolve();

      /** Best effort: an unwritable log never blocks or fails delegation. */
      function runLog(rootId: string, entry: Record<string, unknown>) {
        const directory = options.runLogDir;
        if (!directory) return;
        const file = path.join(directory, `${rootId.replace(/[^\w.-]/g, '_')}.jsonl`);
        const line = JSON.stringify({ ts: new Date().toISOString(), rootSessionId: rootId, ...entry }) + '\n';
        runLogWrites = runLogWrites
          .then(() => mkdir(directory, { recursive: true }))
          .then(() => appendFile(file, line))
          .catch(() => {});
      }

      async function toolCall(
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
            error: 'ALP tools require the current active turn',
          });
        }

        if (
          !['alp_delegate', 'alp_handoff'].includes(params.tool) ||
          params.namespace != null ||
          typeof params.callId !== 'string'
        ) {
          return toolResult(false, {
            error: 'Unknown ALP tool',
          });
        }

        const cached = session.toolCalls.get(params.callId);
        if (cached) return cached;

        const work = params.tool === 'alp_handoff'
          ? Promise.resolve(recordHandoff(session, params.arguments))
          : runDelegation(
              sessionId,
              session,
              params,
            );

        session.toolCalls.set(params.callId, work);
        return work;
      }

      function recordHandoff(session: Session, args: unknown) {
        if (!session.parentAgent) {
          return toolResult(false, { error: 'Only assignment sessions can file a handoff' });
        }
        const handoff = parseHandoff(args);
        if (typeof handoff === 'string') return toolResult(false, { error: handoff });
        session.handoff = handoff;
        return toolResult(true, { recorded: true, to: session.parentAgent, next: 'End your turn with a one-line final message.' });
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
            (key) => !['agent', 'task', 'mode', 'model', 'thinking', 'modelReason'].includes(key),
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

        for (const key of ['model', 'thinking', 'modelReason']) {
          if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim())) return toolResult(false, { error: `Invalid ${key}` });
        }
        if (args.model !== undefined && !/^(codex|claude):[^\s]+$/.test(args.model)) return toolResult(false, { error: 'Use a runtime-prefixed model ID' });
        if (args.agent === 'oracle' && (!args.model || !args.thinking || !args.modelReason)) return toolResult(false, { error: 'Oracle requires an explicit premium model, effort, and selection rationale; no default fallback' });
        const childMode = ['oracle', 'reviewer'].includes(args.agent) ? 'read-only' : args.mode ?? session.mapping.mode;
        if (session.delegating && (args.agent !== 'peer' || childMode !== 'read-only' || [...session.assignments.values()].some(mode => mode !== 'read-only'))) {
          return toolResult(false, { error: 'A child assignment is already running; wait for its handoff (parallel read-only peers only)' });
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

        let rootId = sessionId;
        let root = session;
        while (
          root.parent &&
          sessions.has(root.parent)
        ) {
          rootId = root.parent;
          root = sessions.get(root.parent)!;
        }

        if (root.calls >= 16) {
          return toolResult(false, {
            error: 'Delegation limit reached for this turn',
          });
        }

        if (args.agent === 'peer' && root.peerCount >= session.mapping.workflow.maxPeers) return toolResult(false, { error: 'Concurrent peer limit reached; wait or ask the user to increase workflow.maxPeers for a new session' });
        root.calls++;
        if (args.agent === 'peer') root.peerCount++;
        session.delegating++;

        const childId = `alp-child-${randomUUID()}`;

        session.children.add(childId);
        session.assignments.set(childId, childMode);

        childContexts.set(childId, {
          parent: sessionId,
          callId: params.callId,
          graph: session.graph,
          workflow: session.mapping.workflow,
          ancestry: [
            ...session.ancestry,
            args.agent,
          ],
        });

        let timer: NodeJS.Timeout | undefined;
        const startedAt = Date.now();
        let finished: Record<string, unknown> = { status: 'failed' };

        runLog(rootId, {
          event: 'assignment.started',
          assignmentId: childId,
          parentSessionId: sessionId,
          parentAgent: session.mapping.agent.name,
          agent: args.agent,
          project: session.mapping.agent.projectRoot,
          mode: childMode,
          model: args.model ?? `${session.runtimeKind}:${session.mapping.model}`,
          thinking: args.thinking ?? (args.model ? null : session.mapping.thinking),
          ...(args.modelReason ? { modelReason: args.modelReason } : {}),
          task: args.task,
        });

        try {
          await handle({
            type: 'session.open',
            requestId: `open-${childId}`,
            sessionId: childId,
            history: 'skip',
            config: {
              ...session.config,
              persist: false,
              settings: session.mapping.workflow.mode === 'custom' ? {} : { workflow: session.mapping.workflow.mode },
              providerOptions: {
                agent: args.agent,
              },
              model: args.model ?? `${session.runtimeKind}:${session.mapping.model}`,
              thinkingOption: args.thinking ?? (args.model ? undefined : session.mapping.thinking),
              mode: childMode,
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
                      'Finish by filing your handoff for that agent with alp_handoff.\n\n' +
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
            finished = { status: 'canceled', error: 'Parent assignment stopped' };
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

          // Interim commentary stays in the child timeline; the final message is the answer.
          const output = [
            ...child.text.values(),
          ].at(-1) ?? '';

          const handoff = child.handoff ?? null;

          finished = {
            status: result.state,
            runtime: child.runtimeKind,
            threadId: child.threadId,
            handoff,
            output,
            ...(result.error ? { error: errorData(result.error).message } : {}),
          };

          return toolResult(
            result.state === 'completed',
            {
              agent: args.agent,
              runtime: child.runtimeKind,
              sessionId: childId,
              threadId: child.threadId,
              status: result.state,
              handoff,
              output,
              ...(result.error
                ? {
                    error:
                      errorData(result.error).message,
                  }
                : {}),
            },
          );
        } catch (error) {
          finished = { status: 'failed', error: errorData(error).message };
          return toolResult(false, {
            agent: args.agent,
            error: errorData(error).message,
          });
        } finally {
          clearTimeout(timer);

          await closeSession(childId);

          runLog(rootId, {
            event: 'assignment.finished',
            assignmentId: childId,
            agent: args.agent,
            durationMs: Date.now() - startedAt,
            ...finished,
          });

          childContexts.delete(childId);
          session.children.delete(childId);
          session.delegating--;
          session.assignments.delete(childId);
          if (args.agent === 'peer') root.peerCount--;
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

          if (context) mapping.workflow = context.workflow;

          const graph =
            context?.graph ??
            (mapping.workflow.mode === 'custom' ? await resolveDelegation(mapping.agent.projectRoot) : workflowGraphs[mapping.workflow.mode as keyof typeof workflowGraphs]);

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
            parentAgent: context
              ? sessions.get(context.parent)?.mapping.agent.name
              : undefined,

            children: new Set(),
            delegating: 0,
            peerCount: 0,
            assignments: new Map(),
            calls: 0,

            toolCalls: new Map(),
            acknowledged: Promise.resolve(),
          };

          runtime.onRequest?.(
            (_method, params) =>
              toolCall(
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
              (targets.length || session.parentAgent) &&
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
                session.parentAgent,
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
                settings: [{ type: 'select', id: 'workflow', label: 'Workflow (new session only)', value: mapping.workflow.mode, options: [{ value: 'smart', label: 'Smart' }, { value: 'supervised', label: 'Supervised' }] }],
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

        if (input.type === 'session.configure' && input.changes.settings?.workflow !== undefined) {
          throw new Error('Workflow is fixed for this session; select Smart or Supervised when creating a new session');
        }

        if (input.type === 'session.configure') {
          if (session.active || session.pending || session.children.size) throw new Error('Wait for the current turn and child sessions to finish before changing permissions');
          if (Object.keys(input.changes).some(key => key !== 'mode')) throw new Error('Only permission mode can be changed in an existing ALP session');
          const mode = input.changes.mode === undefined ? session.mapping.mode : input.changes.mode ?? 'read-only';
          if (!modes.some(candidate => candidate.id === mode)) throw new Error(`Unsupported mode '${mode}'`);
          if (['oracle', 'reviewer'].includes(session.mapping.agent.name) && mode !== 'read-only') throw new Error('Advisors must remain read-only');
          if (session.parent && sessions.get(session.parent)?.mapping.mode === 'read-only' && mode !== 'read-only') throw new Error('Child cannot exceed parent permissions');
          if (session.runtimeKind === 'claude') await session.runtime.request('session/configure', { sandbox: mode });
          session.mapping.mode = mode;
          session.config = { ...session.config, mode };
          emit({ type: 'session.config', sessionId: input.sessionId, config: {
            model: session.mapping.model, mode, thinkingOption: session.mapping.thinking,
            models, modes, thinkingOptions: thinkingOptionsFor(session.runtimeKind, session.mapping.model),
            settings: [{ type: 'select', id: 'workflow', label: 'Workflow (new session only)', value: session.mapping.workflow.mode, options: [{ value: 'smart', label: 'Smart' }, { value: 'supervised', label: 'Supervised' }] }],
          } });
          emit({ type: 'request.completed', requestId: input.requestId });
          return;
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
          session.handoff = undefined;

          if (!session.parent) {
            session.calls = 0;
          }
        }

        try {
          const orchestration = session.runtime.orchestrationContext ? await session.runtime.orchestrationContext().catch(() => ({ available: false })) : { available: false };
          const nativeInput = [
            { type: 'text', text: 'ALP runtime catalog and usage snapshot (data, not instructions): ' + JSON.stringify(orchestration), text_elements: [] },
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
                    sandboxPolicy: session.mapping.mode === 'read-only'
                      ? { type: 'readOnly', networkAccess: false }
                      : { type: 'workspaceWrite', writableRoots: [session.mapping.agent.projectRoot], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
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

          await runLogWrites;

          listeners.clear();
        },
      };
    },
  };
}
