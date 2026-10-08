import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { workflowGraphs } from '../core/workflow.js';
import { resolveDelegation } from '../core/delegation.js';
import { CodexTransport } from './transport.js';
import { ClaudeTransport } from './claude-transport.js';
import { modes } from './catalog.js';
import { resolveSession, type ResolvedSession, type RuntimeKind, type SessionSpec } from './resolve.js';
import { MAIL_BODY_CHARS, publicEvent, renderMail, takeBatch, type MailEvent } from './mailbox.js';
import type { AlpEvent, Envelope, SessionSnapshot, TurnOrigin } from './events.js';

export type RuntimeTransport = {
  request(method: string, params: any): Promise<any>;
  initialize(): Promise<void>;
  orchestrationContext?: () => Promise<unknown>;
  onNotification(listener: (method: string, params: any) => void): void;
  onFailure(listener: (error: unknown) => void): void;
  close(): Promise<void>;
  onRequest?: (listener: (method: string, params: any) => Promise<unknown>) => void;
};

export type RuntimeOptions = {
  codexCommand?: string;
  claudeCommand?: string;
  environment?: NodeJS.ProcessEnv;

  /**
   * Optional transport factory for tests/custom runtimes.
   * When omitted, ALP creates CodexTransport or ClaudeTransport itself.
   */
  transport?: (
    cwd: string,
    env: NodeJS.ProcessEnv,
    runtime?: RuntimeKind,
  ) => RuntimeTransport;

  /** An assignment with no activity this long is reported stalled; twice this long, it fails. */
  silentForMs?: number;
  /** How long alp_ask waits for the requester before returning unanswered. */
  askTimeoutMs?: number;

  /** Directory for per-root-session assignment logs (JSONL). Omitted disables logging. */
  runLogDir?: string;

  /** Starter files for projects without ALP; omitted reads the repository templates. */
  templates?: Record<string, string>;

  /** False when no viewer can show child sessions; delegation is then refused. */
  subsessions?: boolean;
};

export type PromptContent = Array<{ type: string; text?: string }>;

export type PromptInput = {
  clientMessageId: string;
  /** auto starts a turn; steer adds to the running one. */
  delivery: 'auto' | 'steer';
  content: PromptContent;
};

export type AlpRuntime = {
  onEvent(listener: (envelope: Envelope) => void): () => void;
  /** Opens a root session under a client-chosen id. */
  open(sessionId: string, spec: SessionSpec, options?: { history?: 'replay' | 'skip' }): Promise<SessionSnapshot>;
  /** Failures are reported as prompt.failed, once per clientMessageId. */
  prompt(sessionId: string, input: PromptInput): Promise<void>;
  /** Cancels the running turn and closes the whole subtree. */
  interrupt(sessionId: string): Promise<void>;
  /** Changes permission mode while idle; undefined keeps the current mode. */
  configure(sessionId: string, changes: { mode?: string }): Promise<SessionSnapshot>;
  close(sessionId: string): Promise<void>;
  snapshot(sessionId: string): SessionSnapshot | undefined;
  shutdown(): Promise<void>;
};

type Session = {
  runtimeKind: RuntimeKind;
  runtime: RuntimeTransport;
  mapping: ResolvedSession;
  threadId: string;
  active?: string;

  pending: boolean;
  buffered: Array<[string, any]>;
  closed: boolean;

  seen: Set<string>;
  text: Map<string, string>;

  spec: SessionSpec;
  graph: Record<string, string[]>;
  ancestry: string[];

  parent?: string;
  toolCallId?: string;
  children: Set<string>;

  peerCount: number;
  /** Live assignments this session requested, keyed by child session id. */
  assignments: Map<string, Assignment>;
  calls: number;

  mail: MailEvent[];
  waiters: Waiter[];
  lastActivity: number;
  /** Auto-wakes since the last user prompt; capped to stop runaway loops. */
  wakes: number;
  /** Set by interrupt: pending mail waits for the next user prompt. */
  wakeBlocked: boolean;

  toolCalls: Map<string, Promise<unknown>>;
  acknowledged: Promise<void>;

  settle?: (state: string, error?: unknown) => void;

  /** Requesting agent for a child assignment; enables alp_handoff and alp_ask. */
  parentAgent?: string;
  handoff?: Handoff;
};

type Assignment = {
  id: string;
  agent: string;
  mode: string;
  startedAt: number;
  warned: boolean;
  finished: boolean;
  rootId: string;
  ask?: { id: string; resolve: (result: unknown) => void };
};

type Waiter = {
  accept: (event: MailEvent) => boolean;
  resolve: (events: MailEvent[] | null) => void;
  timer?: NodeJS.Timeout;
};

const MAX_WAKES = 8;
// Placeholder delivery marks while a steer or a woken turn is starting.
const STEERING = '\u0000steering';
const STARTING = '\u0000starting';

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

const WAIT_TOOL = {
  type: 'function',
  name: 'alp_wait',
  description: 'Wait for mail from your assignments: results, questions, notes, and stall reports. Returns as soon as any arrives, or with an empty list and a status snapshot on timeout.',
  inputSchema: {
    type: 'object',
    properties: {
      assignments: { type: 'array', items: { type: 'string' }, description: 'Assignment ids to wait for; omit for all of yours.' },
      timeoutMs: { type: 'integer', description: 'Maximum wait. Default 300000, maximum 900000.' },
    },
    additionalProperties: false,
  },
};

const SEND_TOOL = {
  type: 'function',
  name: 'alp_send',
  description: 'Send mail to one of your live assignments, or to "parent", your requester. Siblings are not addressable.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'An assignment id you started (or its agent name when only one is live), or "parent".' },
      kind: { type: 'string', enum: ['answer', 'note', 'steer'], description: 'answer replies to a question (needs replyTo); steer changes an instruction (requester only); note is information.' },
      body: { type: 'string' },
      replyTo: { type: 'string', description: 'Question id, for example #4.' },
    },
    required: ['to', 'kind', 'body'],
    additionalProperties: false,
  },
};

const ASK_TOOL = {
  type: 'function',
  name: 'alp_ask',
  description: 'Ask your requester a question and wait for the answer. Returns unanswered after the ask timeout.',
  inputSchema: {
    type: 'object',
    properties: { question: { type: 'string' } },
    required: ['question'],
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

const errorData = (error: unknown) => ({
  message: error instanceof Error ? error.message : String(error),
});

function createTransport(
  options: RuntimeOptions,
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
 * The runtime speaks a normalized protocol to its transport.
 *
 * CodexTransport and ClaudeTransport map it to each native harness.
 *
 * The runtime therefore owns orchestration only; the transport adapters
 * preserve the full native harness underneath.
 */
function nativeSessionConfig(
  runtimeKind: RuntimeKind,
  mapping: ResolvedSession,
  targets: string[],
  parentAgent?: string,
) {
  const delegationInstruction = targets.length
    ? `Use alp_delegate to assign bounded work to: ${targets.join(', ')}. ` +
      'By default it waits and returns the result, or returns early with the child\'s first question. ' +
      'The result carries the child\'s structured handoff (null if it filed none) and output, its final message. ' +
      'Pass wait: false to start an assignment and keep working; collect results and questions with alp_wait. ' +
      'Answer questions with alp_send kind answer and replyTo; use kind steer to change an instruction, note for information. ' +
      'Before ending your turn, alp_wait for running assignments; if you end it anyway, ALP wakes you with their mail. ' +
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
        ? [`This session is an assignment from ${parentAgent}. If a decision is genuinely theirs, ask with alp_ask (it waits for the answer); send information they need now with alp_send to: "parent", kind note. You cannot reach other assignments directly; ${parentAgent} relays. Before ending your turn, call alp_handoff with outcome, summary, and the evidence fields that apply (candidate, scope, verification, risks, ownership). Calling it again replaces the earlier handoff. Then end with a one-line final message.`]
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
                wait: { type: 'boolean', description: 'Default true: wait for the result or the first question. false: return the assignmentId immediately.' },
              },
              required: ['agent', 'task'],
              additionalProperties: false,
            },
          },
        ]
      : []),
      ...(targets.length ? [WAIT_TOOL] : []),
      ...(targets.length || parentAgent ? [SEND_TOOL] : []),
      ...(parentAgent ? [HANDOFF_TOOL, ASK_TOOL] : []),
    ],
  };
}

export function createAlpRuntime(options: RuntimeOptions = {}): AlpRuntime {
  const sessions = new Map<string, Session>();

  const childContexts = new Map<
    string,
    {
      parent: string;
      callId: string;
      graph: Record<string, string[]>;
      workflow: ResolvedSession['workflow'];
      ancestry: string[];
    }
  >();

  const listeners = new Set<(envelope: Envelope) => void>();
  const epoch = randomUUID();
  const sequences = new Map<string, number>();

  let closed = false;
  let queue = Promise.resolve();

  const emit = (sessionId: string, event: AlpEvent) => {
    const seq = (sequences.get(sessionId) ?? 0) + 1;
    sequences.set(sessionId, seq);
    const envelope: Envelope = { sessionId, epoch, seq, ts: new Date().toISOString(), event };
    for (const listener of listeners) listener(envelope);
  };

  /** Public operations run one at a time, so a wake never races a client prompt or an interrupt. */
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(() => {
      if (closed) throw new Error('Runtime is closed');
      return work();
    });
    queue = run.then(() => {}, () => {});
    return run;
  }

  function snapshot(sessionId: string, session: Session): SessionSnapshot {
    return {
      id: sessionId,
      projectRoot: session.mapping.agent.projectRoot,
      agent: session.mapping.agent.name,
      runtime: session.runtimeKind,
      model: session.mapping.model,
      mode: session.mapping.mode,
      thinking: session.mapping.thinking,
      workflow: session.mapping.workflow,
      threadId: session.threadId,
      persistent: session.mapping.persist,
      ...(session.parent ? { parentId: session.parent } : {}),
      ...(session.toolCallId ? { toolCallId: session.toolCallId } : {}),
    };
  }

  function terminal(
    sessionId: string,
    session: Session,
    state: 'completed' | 'failed' | 'canceled',
    error?: unknown,
  ) {
    if (!session.active) return;

    emit(sessionId, {
      type: 'turn.ended',
      turnId: session.active,
      state,
      ...(error ? { error: errorData(error) } : {}),
    });

    const turnId = session.active;
    session.active = undefined;

    // Tool calls of the ended turn stop waiting.
    for (const waiter of session.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    if (session.parent) sessions.get(session.parent)?.assignments.get(sessionId)?.ask?.resolve(toolResult(false, { error: 'Turn ended' }));

    // Mail is acknowledged only by a turn that completed; otherwise it is delivered again.
    session.mail = session.mail.filter(event => !(event.deliveredTurn === turnId && state === 'completed'));
    for (const event of session.mail) {
      if (event.deliveredTurn === turnId) { event.deliveredTurn = undefined; event.redelivered = true; }
    }

    // A requester is not done while its assignments run or mail awaits it.
    if (state === 'completed' && (session.assignments.size || hasActiveMail(session))) {
      queueMicrotask(() => deliver(sessionId, session));
      return;
    }

    session.settle?.(state, error);
  }

  function nativeItem(
    sessionId: string,
    session: Session,
    item: any,
  ) {
    if (item.type === 'agentMessage') {
      session.text.set(item.id, item.text);
      emit(sessionId, { type: 'item', item: { kind: 'assistant_message', id: item.id, text: item.text } });
      return;
    }

    if (item.type === 'userMessage') {
      const text = (item.content ?? [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      emit(sessionId, { type: 'item', item: { kind: 'user_message', id: item.id, text } });
      return;
    }

    if (item.type === 'dynamicToolCall') {
      const status =
        item.status === 'inProgress'
          ? 'running'
          : item.success === false || item.status === 'failed'
            ? 'failed'
            : 'completed';

      emit(sessionId, {
        type: 'item',
        item: {
          kind: 'tool_call',
          id: item.id,
          callId: item.callId ?? item.id,
          name: item.tool,
          status,
          ...(status === 'failed' ? { error: item.tool === 'alp_delegate' ? 'Delegation failed' : 'Tool call failed' } : {}),
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

      emit(sessionId, {
        type: 'item',
        item: {
          kind: 'tool_call',
          id: item.id,
          callId: item.id,
          name: 'shell',
          status,
          ...(status === 'failed' ? { error: 'Command failed' } : {}),
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

    touch(sessionId, session);

    if (session.pending) {
      session.buffered.push([method, params]);
      return;
    }

    if (params?.threadId && params.threadId !== session.threadId) return;

    if (method === 'item/agentMessage/delta') {
      const text =
        (session.text.get(params.itemId) ?? '') + params.delta;

      session.text.set(params.itemId, text);
      emit(sessionId, { type: 'item', item: { kind: 'assistant_message', id: params.itemId, text } });
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

    emit(sessionId, { type: 'session.closed' });
    sequences.delete(sessionId);
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

  const silentForMs = options.silentForMs ?? 600_000;
  const askTimeoutMs = options.askTimeoutMs ?? 900_000;
  let mailSequence = 0;
  let watchdog: NodeJS.Timeout | undefined;

  function rootOf(sessionId: string) {
    let id = sessionId;
    for (let parent: string | undefined = sessions.get(id)?.parent; parent && sessions.has(parent); parent = sessions.get(id)?.parent) id = parent;
    return id;
  }

  function hasActiveMail(session: Session) {
    return session.mail.some(event => !event.deliveredTurn && !event.passive);
  }

  /** Activity anywhere in a subtree keeps its ancestors' assignments alive. */
  function touch(sessionId: string, session: Session) {
    const now = Date.now();
    let id = sessionId;
    for (let current: Session | undefined = session; current; ) {
      current.lastActivity = now;
      const parent: Session | undefined = current.parent ? sessions.get(current.parent) : undefined;
      const assignment = parent?.assignments.get(id);
      if (assignment) assignment.warned = false;
      id = current.parent ?? '';
      current = parent;
    }
  }

  function post(sessionId: string, event: Omit<MailEvent, 'id'>) {
    const mail: MailEvent = { id: `#${++mailSequence}`, ...event };
    const { result: _result, ...logged } = publicEvent(mail);
    runLog(rootOf(sessionId), { event: 'mail', to: sessionId, ...logged });
    const session = sessions.get(sessionId);
    if (session && !session.closed) {
      emit(sessionId, { type: 'mail', mail: publicEvent(mail) });
      session.mail.push(mail);
      deliver(sessionId, session);
    }
    return mail;
  }

  /** Waiting tool calls first, then the running turn (steer), then an idle session (wake). */
  function deliver(sessionId: string, session: Session) {
    if (session.closed) return;
    for (const waiter of [...session.waiters]) {
      const batch = takeBatch(session.mail, waiter.accept);
      if (!batch.length) continue;
      for (const event of batch) event.deliveredTurn = session.active;
      session.waiters.splice(session.waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(batch);
    }
    if (!hasActiveMail(session)) return;
    if (session.pending) {
      void session.acknowledged.then(() => deliver(sessionId, session));
    } else if (session.active) {
      void steerMail(sessionId, session);
    } else if (!session.wakeBlocked && session.wakes < MAX_WAKES) {
      autoWake(sessionId, session);
    } else if (session.parent && !session.wakeBlocked) {
      // A child never gets the user prompt that resets its wakes; report instead of waiting out the watchdog.
      session.settle?.('failed', `Wake limit (${MAX_WAKES}) reached with mail outstanding`);
    }
  }

  async function steerMail(sessionId: string, session: Session) {
    const turnId = session.active!;
    const batch = takeBatch(session.mail, () => true);
    if (!batch.length) return;
    for (const event of batch) event.deliveredTurn = STEERING;
    const id = `alp-mail-${randomUUID()}`;
    const text = renderMail(batch, session.parentAgent);
    let steered = false;
    try {
      await session.runtime.request('turn/steer', { threadId: session.threadId, expectedTurnId: turnId, clientUserMessageId: id, input: [{ type: 'text', text, text_elements: [] }] });
      steered = true;
      emit(sessionId, { type: 'item', item: { kind: 'user_message', id: `user:${id}`, clientMessageId: id, text } });
    } catch {}
    // If the turn ended meanwhile, receipt is uncertain: deliver again rather than lose mail.
    const received = steered && session.active === turnId;
    for (const event of batch) {
      if (event.deliveredTurn !== STEERING) continue;
      event.deliveredTurn = received ? turnId : undefined;
      if (!received && steered) event.redelivered = true;
    }
    if (!received) deliver(sessionId, session);
  }

  /** Queued behind client operations, so a wake never races a user prompt or an interrupt. */
  function autoWake(sessionId: string, session: Session) {
    const batch = takeBatch(session.mail, () => true);
    if (!batch.length) return;
    for (const event of batch) event.deliveredTurn = STARTING;
    const release = () => {
      for (const event of batch) if (event.deliveredTurn === STARTING) event.deliveredTurn = undefined;
    };
    const work = queue.then(async () => {
      if (closed || session.closed) return release();
      // Whatever ran first decides: a running turn gets the mail by steering, an interrupt holds it.
      if (session.wakeBlocked || session.active || session.pending) {
        release();
        return deliver(sessionId, session);
      }
      session.wakes++;
      const id = `alp-wake-${randomUUID()}`;
      try {
        await startPrompt(sessionId, { clientMessageId: id, delivery: 'auto', content: [{ type: 'text', text: renderMail(batch, session.parentAgent) }] }, 'wake', batch);
      } catch {
        release();
        deliver(sessionId, session);
      }
    });
    queue = work.catch(() => {});
  }

  /**
   * Resolves with delivered mail, [] on timeout, or null when the turn ends.
   * A waiting delegate goes first so a concurrent catch-all alp_wait cannot take its result.
   */
  function waitFor(session: Session, accept: (event: MailEvent) => boolean, timeoutMs?: number, first = false) {
    const ready = takeBatch(session.mail, accept);
    if (ready.length) {
      for (const event of ready) event.deliveredTurn = session.active;
      return Promise.resolve<MailEvent[] | null>(ready);
    }
    return new Promise<MailEvent[] | null>(resolve => {
      const waiter: Waiter = { accept, resolve };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const index = session.waiters.indexOf(waiter);
          if (index >= 0) session.waiters.splice(index, 1);
          resolve([]);
        }, timeoutMs);
      }
      if (first) session.waiters.unshift(waiter);
      else session.waiters.push(waiter);
    });
  }

  function running(session: Session) {
    const now = Date.now();
    return [...session.assignments.values()].map(assignment => ({
      assignmentId: assignment.id,
      agent: assignment.agent,
      status: assignment.ask ? 'waiting_parent' : 'running',
      idleMs: now - (sessions.get(assignment.id)?.lastActivity ?? assignment.startedAt),
    }));
  }

  /** Reports a silent assignment once, then fails it at twice the limit; time spent asking does not count. */
  function watch() {
    if (watchdog) return;
    watchdog = setInterval(() => {
      let live = 0;
      const now = Date.now();
      for (const [parentId, parent] of [...sessions]) {
        for (const assignment of [...parent.assignments.values()]) {
          live++;
          const child = sessions.get(assignment.id);
          if (!child || assignment.ask || assignment.finished) continue;
          const idle = now - child.lastActivity;
          if (idle >= 2 * silentForMs) {
            void finishAssignment(parentId, parent, assignment, 'failed', `Assignment timed out: no activity for ${2 * silentForMs} ms`);
          } else if (idle >= silentForMs && !assignment.warned) {
            assignment.warned = true;
            post(parentId, { kind: 'stalled', from: assignment.agent, assignment: assignment.id, passive: true, body: `No activity for ${Math.round(idle / 1000)} s; the assignment fails after ${Math.round(2 * silentForMs / 1000)} s without activity.` });
          }
        }
      }
      if (!live) {
        clearInterval(watchdog);
        watchdog = undefined;
      }
    }, Math.max(5, Math.min(silentForMs / 4, 30_000)));
    watchdog.unref?.();
  }

  const assignmentSnapshot = (assignment: Assignment, status: string) => ({
    id: assignment.id,
    agent: assignment.agent,
    mode: assignment.mode,
    status,
    startedAt: new Date(assignment.startedAt).toISOString(),
  });

  async function finishAssignment(parentId: string, parent: Session, assignment: Assignment, state: string, error?: unknown, quiet = false) {
    if (assignment.finished) return;
    assignment.finished = true;
    const child = sessions.get(assignment.id);
    if (child && state === 'failed' && child.active) terminal(assignment.id, child, 'failed', error);
    assignment.ask?.resolve(toolResult(false, { error: 'Assignment ended' }));

    // Interim commentary stays in the child timeline; the final message is the answer.
    const result = {
      agent: assignment.agent,
      ...(child ? { runtime: child.runtimeKind, threadId: child.threadId } : {}),
      sessionId: assignment.id,
      status: state,
      handoff: child?.handoff ?? null,
      output: child ? [...child.text.values()].at(-1) ?? '' : '',
      ...(error ? { error: errorData(error).message } : {}),
    };

    await closeSession(assignment.id);

    runLog(rootOf(parentId), {
      event: 'assignment.finished',
      assignmentId: assignment.id,
      durationMs: Date.now() - assignment.startedAt,
      ...result,
    });
    if (!parent.closed) emit(parentId, { type: 'assignment', assignment: assignmentSnapshot(assignment, state) });

    childContexts.delete(assignment.id);
    parent.children.delete(assignment.id);
    parent.assignments.delete(assignment.id);
    if (assignment.agent === 'peer') {
      const root = sessions.get(assignment.rootId);
      if (root) root.peerCount--;
    }
    parent.mail = parent.mail.filter(event => event.deliveredTurn || event.kind !== 'question' || event.assignment !== assignment.id);
    if (!quiet) post(parentId, { kind: 'result', from: assignment.agent, assignment: assignment.id, result });
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
      !['alp_delegate', 'alp_handoff', 'alp_wait', 'alp_send', 'alp_ask'].includes(params.tool) ||
      params.namespace != null ||
      typeof params.callId !== 'string'
    ) {
      return toolResult(false, {
        error: 'Unknown ALP tool',
      });
    }

    const cached = session.toolCalls.get(params.callId);
    if (cached) return cached;

    const args = params.arguments;
    const work =
      params.tool === 'alp_delegate' ? runDelegation(sessionId, session, params)
      : params.tool === 'alp_wait' ? waitTool(session, args)
      : params.tool === 'alp_ask' ? askTool(sessionId, session, args)
      : Promise.resolve(params.tool === 'alp_send' ? sendTool(sessionId, session, args) : recordHandoff(session, args));

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

  const plainObject = (value: unknown, keys: string[]): value is Record<string, any> =>
    !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

  async function waitTool(session: Session, args: unknown) {
    if (!plainObject(args, ['assignments', 'timeoutMs'])) return toolResult(false, { error: 'Invalid wait' });
    const known = (id: unknown) => typeof id === 'string' && (session.assignments.has(id) || session.mail.some(event => event.assignment === id));
    if (args.assignments !== undefined && (!Array.isArray(args.assignments) || !args.assignments.every(known))) {
      return toolResult(false, { error: 'Unknown assignment, or its result was already delivered' });
    }
    if (args.timeoutMs !== undefined && (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1)) {
      return toolResult(false, { error: 'timeoutMs must be a positive integer' });
    }
    const ids: Set<string> | undefined = args.assignments?.length ? new Set(args.assignments) : undefined;
    const accept = (event: MailEvent) => !ids || ids.has(event.assignment);
    const pending = [...session.assignments.keys()].some(id => !ids || ids.has(id)) || takeBatch(session.mail, accept).length > 0;
    const events = pending ? await waitFor(session, accept, Math.min(args.timeoutMs ?? 300_000, 900_000)) : [];
    if (!events) return toolResult(false, { error: 'Turn ended' });
    return toolResult(true, { events: events.map(publicEvent), running: running(session) });
  }

  function sendTool(sessionId: string, session: Session, args: unknown) {
    if (
      !plainObject(args, ['to', 'kind', 'body', 'replyTo']) ||
      typeof args.to !== 'string' ||
      !['answer', 'note', 'steer'].includes(args.kind) ||
      typeof args.body !== 'string' || !args.body.trim() || args.body.length > MAIL_BODY_CHARS ||
      (args.replyTo !== undefined && typeof args.replyTo !== 'string')
    ) {
      return toolResult(false, { error: `Mail needs to, kind (answer, note, or steer), and a body of at most ${MAIL_BODY_CHARS} characters` });
    }
    const from = session.mapping.agent.name;
    if (args.to === 'parent') {
      if (!session.parent || !session.parentAgent) return toolResult(false, { error: 'This session has no requester' });
      if (args.kind !== 'note') return toolResult(false, { error: 'Mail to your requester is a note; ask with alp_ask and report with alp_handoff' });
      return toolResult(true, { sent: post(session.parent, { kind: 'note', from, assignment: sessionId, body: args.body }).id });
    }
    // Models often address an assignment by its agent name; accept that when it is unambiguous.
    const named = [...session.assignments.values()].filter(candidate => candidate.agent === args.to);
    const assignment = session.assignments.get(args.to) ?? (named.length === 1 ? named[0] : undefined);
    if (named.length > 1) return toolResult(false, { error: `Several live ${args.to} assignments; use the assignment id` });
    if (!assignment) return toolResult(false, { error: 'Not one of your live assignments; other agents are reached through your requester' });
    if (args.kind === 'answer') {
      if (!assignment.ask || args.replyTo !== assignment.ask.id) return toolResult(false, { error: 'No pending question with that replyTo on this assignment' });
      runLog(rootOf(sessionId), { event: 'mail', to: assignment.id, kind: 'answer', from, assignment: assignment.id, replyTo: args.replyTo, body: args.body });
      emit(assignment.id, { type: 'mail', mail: { id: `answer:${args.replyTo}`, kind: 'answer', from, assignment: assignment.id, replyTo: args.replyTo, body: args.body } });
      assignment.ask.resolve(toolResult(true, { status: 'answered', from, answer: args.body }));
      return toolResult(true, { sent: true, replyTo: args.replyTo });
    }
    return toolResult(true, { sent: post(assignment.id, { kind: args.kind, from, assignment: assignment.id, body: args.body, ...(args.replyTo ? { replyTo: args.replyTo } : {}) }).id });
  }

  function askTool(sessionId: string, session: Session, args: unknown) {
    const parent = session.parent ? sessions.get(session.parent) : undefined;
    const assignment = parent?.assignments.get(sessionId);
    if (!session.parent || !parent || !assignment) return Promise.resolve(toolResult(false, { error: 'Only assignment sessions can ask their requester' }));
    if (!plainObject(args, ['question']) || typeof args.question !== 'string' || !args.question.trim() || args.question.length > MAIL_BODY_CHARS) {
      return Promise.resolve(toolResult(false, { error: `question is required, at most ${MAIL_BODY_CHARS} characters` }));
    }
    if (assignment.ask) return Promise.resolve(toolResult(false, { error: 'A question is already waiting for an answer' }));
    const parentId = session.parent;
    return new Promise<unknown>(resolve => {
      const question = post(parentId, { kind: 'question', from: session.mapping.agent.name, assignment: sessionId, body: args.question });
      let timer: NodeJS.Timeout | undefined;
      const settle = (result: unknown) => {
        if (assignment.ask?.id !== question.id) return;
        clearTimeout(timer);
        assignment.ask = undefined;
        session.lastActivity = Date.now();
        // An unread question is stale once answered, timed out, or abandoned.
        parent.mail = parent.mail.filter(event => event !== question || event.deliveredTurn);
        resolve(result);
      };
      assignment.ask = { id: question.id, resolve: settle };
      timer = setTimeout(() => settle(toolResult(true, {
        status: 'unanswered',
        question: question.id,
        next: 'Decide, and record the assumption in your handoff; or file outcome blocked.',
      })), askTimeoutMs);
    });
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
        (key) => !['agent', 'task', 'mode', 'model', 'thinking', 'modelReason', 'wait'].includes(key),
      ) ||
      !targets.includes(args.agent) ||
      typeof args.task !== 'string' ||
      !args.task.trim() ||
      args.task.length > 32000 ||
      (
        args.mode !== undefined &&
        !['read-only', 'workspace-write'].includes(args.mode)
      ) ||
      (args.wait !== undefined && typeof args.wait !== 'boolean')
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
    if (session.assignments.size && (args.agent !== 'peer' || childMode !== 'read-only' || [...session.assignments.values()].some(assignment => assignment.mode !== 'read-only'))) {
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

    const rootId = rootOf(sessionId);
    const root = sessions.get(rootId)!;

    if (root.calls >= 16) {
      return toolResult(false, {
        error: 'Delegation limit reached for this turn',
      });
    }

    if (args.agent === 'peer' && root.peerCount >= session.mapping.workflow.maxPeers) return toolResult(false, { error: 'Concurrent peer limit reached; wait or ask the user to increase workflow.maxPeers for a new session' });
    root.calls++;
    if (args.agent === 'peer') root.peerCount++;

    const childId = `alp-child-${randomUUID()}`;
    const assignment: Assignment = { id: childId, agent: args.agent, mode: childMode, rootId, startedAt: Date.now(), warned: false, finished: false };

    session.children.add(childId);
    session.assignments.set(childId, assignment);

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

    const model = args.model ?? `${session.runtimeKind}:${session.mapping.model}`;
    const thinking = args.thinking ?? (args.model ? undefined : session.mapping.thinking);

    runLog(rootId, {
      event: 'assignment.started',
      assignmentId: childId,
      parentSessionId: sessionId,
      parentAgent: session.mapping.agent.name,
      agent: args.agent,
      project: session.mapping.agent.projectRoot,
      mode: childMode,
      model,
      thinking: thinking ?? null,
      ...(args.modelReason ? { modelReason: args.modelReason } : {}),
      wait: args.wait !== false,
      task: args.task,
    });
    emit(sessionId, { type: 'assignment', assignment: assignmentSnapshot(assignment, 'running') });

    try {
      // A child inherits the requester's client configuration, never its native thread.
      const { restore: _restore, ...inherited } = session.spec;
      await openSession(childId, {
        ...inherited,
        persist: false,
        workflow: session.mapping.workflow.mode === 'custom' ? undefined : session.mapping.workflow.mode,
        agent: args.agent,
        model,
        thinking,
        mode: childMode,
      }, 'skip');

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

      child.settle = (state, error) =>
        void finishAssignment(sessionId, session, assignment, state, error);

      await startPrompt(childId, {
        clientMessageId: `task-${childId}`,
        delivery: 'auto',
        content: [
          {
            type: 'text',
            text:
              `Assignment from ${session.mapping.agent.name}. ` +
              'Finish by filing your handoff for that agent with alp_handoff.\n\n' +
              args.task,
          },
        ],
      }, 'assignment');
    } catch (error) {
      // A child that failed while starting may already have reported by mail; report once.
      session.mail = session.mail.filter(event => event.deliveredTurn || event.kind !== 'result' || event.assignment !== childId);
      await finishAssignment(sessionId, session, assignment, 'failed', error, true);
      return toolResult(false, {
        agent: args.agent,
        error: errorData(error).message,
      });
    }

    watch();

    if (args.wait === false) {
      return toolResult(true, { assignmentId: childId, agent: args.agent, status: 'running' });
    }

    // Waiting returns the result, or the child's first question so it can be answered.
    const events = await waitFor(session, event => event.assignment === childId && (event.kind === 'result' || event.kind === 'question'), undefined, true);

    if (!events) {
      return toolResult(false, {
        agent: args.agent,
        assignmentId: childId,
        status: 'canceled',
        error: 'Parent assignment stopped',
      });
    }

    const [event] = events;
    if (event.kind === 'result') return toolResult(event.result!.status === 'completed', event.result);
    return toolResult(true, {
      assignmentId: childId,
      agent: args.agent,
      status: 'running',
      events: [publicEvent(event)],
      next: 'Answer with alp_send kind answer, then alp_wait for this assignment.',
    });
  }

  async function openSession(sessionId: string, spec: SessionSpec, history: 'replay' | 'skip'): Promise<SessionSnapshot> {
    if (sessions.has(sessionId)) {
      throw new Error(
        'Session is already open',
      );
    }

    const mapping = await resolveSession(spec, { templates: options.templates });

    const runtimeKind = mapping.runtimeKind;

    const context =
      childContexts.get(sessionId);

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

    const runtime = createTransport(
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

      spec,
      graph,
      ancestry:
        context?.ancestry ??
        [mapping.agent.name],
      parent: context?.parent,
      toolCallId: context?.callId,
      parentAgent: context
        ? sessions.get(context.parent)?.mapping.agent.name
        : undefined,

      children: new Set(),
      peerCount: 0,
      assignments: new Map(),
      calls: 0,
      mail: [],
      waiters: [],
      lastActivity: Date.now(),
      wakes: 0,
      wakeBlocked: false,

      toolCalls: new Map(),
      acknowledged: Promise.resolve(),
    };

    runtime.onRequest?.(
      (_method, params) =>
        toolCall(
          sessionId,
          session,
          params,
        ),
    );

    sessions.set(
      sessionId,
      session,
    );

    runtime.onNotification(
      (method, params) =>
        notification(
          sessionId,
          session,
          method,
          params,
        ),
    );

    runtime.onFailure((error) => {
      if (!session.closed) {
        terminal(
          sessionId,
          session,
          'failed',
          error,
        );

        session.settle?.(
          'failed',
          error,
        );

        void closeSession(
          sessionId,
        );

        emit(sessionId, { type: 'session.failed', error: errorData(error) });
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
        options.subsessions === false
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

      emit(sessionId, {
        type: 'session.opened',
        session: snapshot(sessionId, session),
        cwd: result.cwd ?? mapping.agent.projectRoot,
        effective: {
          model: result.model ?? mapping.model,
          thinking: result.reasoningEffort ?? mapping.thinking,
        },
      });

      if (
        history === 'replay'
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
              sessionId,
              session,
              item,
            );
          }
        }
      }

      emit(sessionId, { type: 'session.ready' });
      return snapshot(sessionId, session);
    } catch (error) {
      session.closed = true;
      sessions.delete(
        sessionId,
      );

      await runtime.close();

      throw error;
    }
  }

  function openOf(sessionId: string) {
    const session =
      sessions.get(sessionId);

    if (
      !session ||
      session.closed
    ) {
      throw new Error(
        'Session is not open',
      );
    }
    return session;
  }

  async function configureSession(sessionId: string, changes: { mode?: string }) {
    const session = openOf(sessionId);
    if (session.active || session.pending || session.children.size) throw new Error('Wait for the current turn and child sessions to finish before changing permissions');
    const mode = changes.mode ?? session.mapping.mode;
    if (!modes.some(candidate => candidate.id === mode)) throw new Error(`Unsupported mode '${mode}'`);
    if (['oracle', 'reviewer'].includes(session.mapping.agent.name) && mode !== 'read-only') throw new Error('Advisors must remain read-only');
    if (session.parent && sessions.get(session.parent)?.mapping.mode === 'read-only' && mode !== 'read-only') throw new Error('Child cannot exceed parent permissions');
    if (session.runtimeKind === 'claude') await session.runtime.request('session/configure', { sandbox: mode });
    session.mapping.mode = mode;
    session.spec = { ...session.spec, mode };
    const updated = snapshot(sessionId, session);
    emit(sessionId, { type: 'session.updated', session: updated });
    return updated;
  }

  async function interruptSession(sessionId: string) {
    const session = openOf(sessionId);
    const activeTurn =
      session.active;

    session.wakeBlocked = true;

    terminal(
      sessionId,
      session,
      'canceled',
    );

    await Promise.all(
      [...session.children].map(
        closeSession,
      ),
    );

    // An idle requester waiting on its assignments has no turn to cancel; end its assignment now.
    if (!activeTurn) session.settle?.('canceled', 'Interrupted');

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
  }

  /** Starts a turn or steers the running one; throws when the prompt was not delivered. */
  async function startPrompt(sessionId: string, prompt: PromptInput, origin: TurnOrigin, wake?: MailEvent[]) {
    const session = openOf(sessionId);

    if (
      session.seen.has(
        prompt.clientMessageId,
      )
    ) {
      return;
    }

    if (
      prompt.content.some(
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

    const text = prompt.content
      .map(
        (content) => content.text ?? '',
      )
      .join('\n');

    // Steering changes the brief; live assignments keep running and report by mail.
    const mail = wake ?? (prompt.delivery === 'steer' ? [] : takeBatch(session.mail, () => true));
    for (const event of mail) event.deliveredTurn = STARTING;

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

      // A wake continues the same assignment: keep its handoff and limits.
      if (!wake) {
        session.handoff = undefined;
        session.wakes = 0;
        session.wakeBlocked = false;

        if (!session.parent) {
          session.calls = 0;
        }
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
        ...(mail.length && !wake ? [{ type: 'text', text: renderMail(mail, session.parentAgent), text_elements: [] }] : []),
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

      for (const event of mail) event.deliveredTurn = turnId;

      session.seen.add(
        prompt.clientMessageId,
      );

      emit(sessionId, {
        type: 'item',
        item: {
          kind: 'user_message',
          id: `user:${prompt.clientMessageId}`,
          clientMessageId: prompt.clientMessageId,
          text,
        },
      });

      emit(sessionId, {
        type: 'prompt.accepted',
        clientMessageId: prompt.clientMessageId,
        result: prompt.delivery === 'steer' ? 'steer' : 'turn',
        turnId,
      });

      if (
        prompt.delivery !== 'steer'
      ) {
        session.active = turnId;
        emit(sessionId, { type: 'turn.started', turnId, origin });
      }
    } finally {
      // A turn that never started did not receive its mail.
      for (const event of mail) if (event.deliveredTurn === STARTING) event.deliveredTurn = undefined;

      session.pending = false;
      acknowledged();

      for (
        const [method, params] of
        session.buffered.splice(0)
      ) {
        notification(
          sessionId,
          session,
          method,
          params,
        );
      }

      // Mail beyond the first batch follows into the running turn.
      if (hasActiveMail(session)) deliver(sessionId, session);
    }
  }

  return {
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    open: (sessionId, spec, { history = 'skip' } = {}) => enqueue(() => openSession(sessionId, spec, history)),

    prompt: (sessionId, input) => enqueue(async () => {
      try {
        await startPrompt(sessionId, input, 'user');
      } catch (error) {
        const session = sessions.get(sessionId);
        if (session?.seen.has(input.clientMessageId)) return;
        session?.seen.add(input.clientMessageId);
        emit(sessionId, { type: 'prompt.failed', clientMessageId: input.clientMessageId, error: errorData(error) });
      }
    }),

    interrupt: sessionId => enqueue(() => interruptSession(sessionId)),

    configure: (sessionId, changes) => enqueue(() => configureSession(sessionId, changes)),

    close: sessionId => enqueue(async () => {
      openOf(sessionId);
      await closeSession(sessionId);
    }),

    snapshot(sessionId) {
      const session = sessions.get(sessionId);
      return session && !session.closed ? snapshot(sessionId, session) : undefined;
    },

    async shutdown() {
      closed = true;

      await queue;

      await Promise.all(
        [...sessions.keys()].map(
          closeSession,
        ),
      );

      clearInterval(watchdog);

      await runLogWrites;

      listeners.clear();
    },
  };
}
