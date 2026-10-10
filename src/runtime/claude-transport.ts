import { accessSync, constants, existsSync, mkdirSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { optionalRead, claudeUsage } from './runtime-context.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PIN_KINDS } from './board.js';
import { CLOSE_REASONS, GATE_KINDS, TASK_STATUSES, TASK_TYPES } from '../core/tasks.js';
import { commandDecision } from '../core/permissions.js';

// Keep the Claude SDK behind the runtime boundary. Paseo inspects static
// imports while compiling plugin entrypoints, including their declaration
// graph; the SDK is a daemon-only optional runtime dependency.
const CLAUDE_SDK = ['@anthropic-ai', 'claude-agent-sdk'].join('/');

type SDKUserMessage = any;
type SDKMessage = any;
type ClaudeQuery = AsyncGenerator<SDKMessage, void> & {
  supportedModels(): Promise<Array<{ value: string; displayName: string; description: string; supportedEffortLevels?: string[] }>>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options: { skipBehaviors: boolean }): Promise<any>;
  getContextUsage(options: { detail: 'summary' | 'full' }): Promise<any>;
  interrupt(): Promise<unknown>;
  setPermissionMode(mode: 'default' | 'acceptEdits' | 'bypassPermissions'): Promise<void>;
  close(): void;
};

// Zod mirrors of the provider's dynamic tool schemas; the provider validates again.
const handoffList = z.array(z.string().min(1)).max(100).optional();
const taskIds = z.array(z.string().min(1)).max(50).optional();
const taskLinks = z.object({ blockedBy: taskIds, related: taskIds, parent: z.string().min(1).optional() }).strict().optional();
export const toolShapes: Record<string, Record<string, z.ZodType>> = {
  alp_delegate: {
    agent: z.string().min(1),
    task: z.string().min(1).max(32_000),
    model: z.string().min(1).optional(),
    thinking: z.string().min(1).optional(),
    modelReason: z.string().min(1).optional(),
    mode: z.enum(['read-only', 'workspace-write', 'full-access']).optional(),
    isolation: z.enum(['shared', 'worktree']).optional(),
    wait: z.boolean().optional(),
    etaMinutes: z.number().int().min(1).max(1440).optional(),
    taskId: z.string().min(1).optional(),
    continueFrom: z.string().min(1).optional(),
  },
  alp_merge: {
    assignmentId: z.string().min(1),
    skipVerify: z.string().min(1).max(2000).optional(),
  },
  alp_verify: {
    taskId: z.string().min(1).optional(),
  },
  alp_recall: {
    assignmentId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    question: z.string().min(1).max(4000),
  },
  alp_lesson: {
    scope: z.enum(['project', 'user']),
    lesson: z.string().min(1).max(600),
  },
  alp_skill: {
    name: z.string().min(1),
    description: z.string().min(1).max(300),
    body: z.string().min(1).max(20_000),
    roles: z.array(z.string().min(1)).min(1).max(10),
    lessons: z.array(z.string().min(1).max(600)).max(50).optional(),
    replace: z.boolean().optional(),
  },
  alp_issue: {
    action: z.enum(['search', 'create', 'comment']),
    target: z.enum(['project', 'alp']),
    query: z.string().min(1).max(200).optional(),
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(20_000).optional(),
    issue: z.number().int().positive().optional(),
    labels: z.array(z.string().min(1).max(50)).max(10).optional(),
  },
  alp_task: {
    action: z.enum(['create', 'update', 'link', 'start', 'close', 'reopen', 'gate', 'clear', 'pour', 'formulas', 'show', 'list', 'ready']),
    id: z.string().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(8000).optional(),
    type: z.enum(TASK_TYPES as [string, ...string[]]).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    labels: z.array(z.string().min(1).max(50)).max(10).optional(),
    paths: z.array(z.string().min(1)).max(50).optional(),
    parent: z.string().min(1).optional(),
    blockedBy: taskIds,
    discoveredFrom: z.string().min(1).optional(),
    add: taskLinks,
    remove: taskLinks,
    reason: z.enum(CLOSE_REASONS as [string, ...string[]]).optional(),
    kind: z.enum(GATE_KINDS as [string, ...string[]]).optional(),
    until: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
    gate: z.string().min(1).optional(),
    formula: z.string().min(1).optional(),
    vars: z.record(z.string(), z.string()).optional(),
    summary: z.string().min(1).max(2000).optional(),
    unverified: z.string().min(1).max(2000).optional(),
    note: z.string().min(1).max(2000).optional(),
    status: z.enum(TASK_STATUSES as [string, ...string[]]).optional(),
    label: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
  },
  alp_discard: {
    assignmentId: z.string().min(1),
  },
  alp_cancel: {
    assignmentId: z.string().min(1),
    reason: z.string().optional(),
  },
  alp_pin: {
    kind: z.enum(PIN_KINDS),
    body: z.string().min(1),
    paths: z.array(z.string().min(1)).optional(),
  },
  alp_board: {
    kinds: z.array(z.enum(PIN_KINDS)).optional(),
    limit: z.number().int().positive().optional(),
  },
  alp_unpin: {
    pinId: z.string().min(1),
  },
  alp_wait: {
    assignments: z.array(z.string().min(1)).max(32).optional(),
    timeoutMs: z.number().int().positive().optional(),
  },
  alp_send: {
    to: z.string().min(1),
    kind: z.enum(['answer', 'note', 'steer']),
    body: z.string().min(1).max(8000),
    replyTo: z.string().min(1).optional(),
  },
  alp_ask: {
    question: z.string().min(1).max(8000),
    to: z.enum(['parent', 'user']).optional(),
    options: z.array(z.string().min(1).max(200)).max(10).optional(),
  },
  alp_handoff: {
    outcome: z.enum(['complete', 'partial', 'blocked', 'reconsider']),
    summary: z.string().min(1),
    candidate: handoffList,
    scope: handoffList,
    verification: handoffList,
    risks: handoffList,
    discovered: handoffList,
    ownership: z.string().optional(),
    // ALP checks that the result follows from the criteria and findings (ALPD §38).
    verdict: z.object({
      result: z.enum(['pass', 'pass_with_findings', 'fail', 'blocked']),
      criteria: z.array(z.object({ criterion: z.string().min(1), result: z.enum(['pass', 'fail', 'not_checked']), evidence: z.string().min(1) }).strict()).min(1).max(50),
      findings: z.array(z.object({ severity: z.enum(['critical', 'high', 'medium', 'low']), where: z.string().min(1), problem: z.string().min(1), fix: z.string().min(1).optional() }).strict()).max(100).optional(),
    }).strict().optional(),
  },
};

type Listener = (method: string, params: any) => void;
type RequestHandler = (method: string, params: any) => Promise<unknown>;

type NativeConfig = {
  cwd: string;
  model: string;
  sandbox: string;
  developerInstructions: string;
  mcpServers: Record<string, any>;
  thinking: string;
  dynamicTools: Array<{
    name: string;
    description: string;
  }>;
  ephemeral?: boolean;
  threadId?: string;
  /** The session's permission profile: rules Claude enforces itself, in every permission mode. */
  permissions?: PermissionRules | null;
  /** The OS sandbox for Bash, when ALP chose one. */
  floor?: 'read-only' | 'workspace-write';
  /** The context window the session works in before Claude compacts it, in tokens; absent: the model's (ALPD §57). */
  context?: number;
  /** The agent's skills, each a SKILL.md, loaded as Claude Code skills alp:<name> (ALPD §59). */
  skills?: Array<{ name: string; path: string }>;
};

/** The plugin name ALP's skills are loaded under, so Claude Code calls them alp:<name>. */
export const SKILL_PLUGIN = 'alp';

/**
 * A Claude Code plugin in `directory` holding the given skills, linked to their own
 * directories so an edit to a skill reaches the next session (ALPD §59).
 */
export function skillPlugin(directory: string, skills: Array<{ name: string; path: string }>) {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(path.join(directory, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(directory, 'skills'));
  writeFileSync(path.join(directory, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: SKILL_PLUGIN, description: "The agent's ALP skills" }));
  for (const skill of skills) symlinkSync(path.dirname(skill.path), path.join(directory, 'skills', skill.name), 'dir');
  return directory;
}

type PermissionRules = {
  allow: string[]; ask?: string[]; deny: string[]; beyondMode?: 'refuse' | 'ask';
  /** The OS sandbox ALP puts Bash in, and the directory it may write besides temp files. */
  floor?: 'read-only' | 'workspace-write'; floorRoot?: string;
};

/** Whether Claude Code can sandbox Bash here: Seatbelt on macOS, bubblewrap and socat on Linux. ALP_CLAUDE_SANDBOX=0 turns it off, =1 claims it (tests). */
export function claudeSandboxAvailable() {
  if (process.env.ALP_CLAUDE_SANDBOX === '0') return false;
  if (process.env.ALP_CLAUDE_SANDBOX === '1') return true;
  if (process.platform === 'darwin') return existsSync('/usr/bin/sandbox-exec');
  if (process.platform !== 'linux') return false;
  const onPath = (name: string) => (process.env.PATH ?? '').split(path.delimiter).some(dir => dir && existsSync(path.join(dir, name)));
  return onPath('bwrap') && onPath('socat');
}

const WRITERS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const inside = (file: string, root: string) => { const relative = path.relative(root, file); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
/** What ALP asks the user for a permission Claude would otherwise not have. */
export type PermissionRequest = { tool: string; input: Record<string, unknown>; reason: 'rule' | 'mode'; rule?: string };
export type PermissionAnswer = { allow: boolean; always?: boolean; message?: string };

/** The rule an "always allow" adds: Claude's own suggestion, else the exact command or path. */
function suggestedRule(tool: string, input: Record<string, unknown>, suggestions: any) {
  const suggestion = (Array.isArray(suggestions) ? suggestions : []).find((entry: any) => entry?.type === 'addRules' && entry.behavior === 'allow' && entry.rules?.length);
  const rule = suggestion?.rules[0];
  if (rule?.toolName) return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
  if (tool === 'Bash' && typeof input.command === 'string' && !input.command.includes(')')) return `Bash(${input.command})`;
  if (typeof input.file_path === 'string' && !input.file_path.includes(')')) return `${tool}(${input.file_path})`;
  return undefined;
}

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private ended = false;

  push(value: SDKUserMessage) {
    if (this.ended) throw new Error('Claude input is closed');
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close() {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Claude's permission mode for an ALP mode; full-access skips every permission check. */
export const claudePermissionMode = (sandbox: string) => sandbox === 'read-only' ? 'default' : sandbox === 'full-access' ? 'bypassPermissions' : 'acceptEdits';

export function claudePermissions(sandbox: string, currentSandbox?: () => string, rules?: PermissionRules | null, ask?: (request: PermissionRequest) => Promise<PermissionAnswer>) {
  const readOnly = sandbox === 'read-only';
  // A skill only adds instructions; what they lead to is checked as itself (ALPD §59).
  const readers = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill'];
  return {
    // Plan mode permits writes to plan files and requires ExitPlanMode approval.
    // Fixed read-only callers restrict the tool surface; live sessions keep
    // tools available and consult the current sandbox at the permission gate.
    permissionMode: claudePermissionMode(sandbox),
    // Lets a live session switch to full-access later; it bypasses nothing by itself.
    allowDangerouslySkipPermissions: true,
    ...(readOnly && !currentSandbox ? { tools: readers } : {}),
    // Allow rules run without asking, even in a read-only session; deny rules hold even with full access.
    ...(rules?.allow.length ? { allowedTools: rules.allow } : {}),
    disallowedTools: ['Agent', 'Task', 'TeamCreate', 'EnterPlanMode', 'ExitPlanMode', ...(rules?.deny ?? [])],
    // Ask rules make Claude consult canUseTool in every mode, which asks the user.
    ...(rules?.ask?.length ? { settings: { permissions: { ask: rules.ask } } } : {}),
    // The floor: Bash runs in the OS sandbox, which writes only the workspace (or nothing, read-only) and temp files, offline.
    // A command leaves it only with dangerouslyDisableSandbox, which Claude allows itself for allow rules and asks canUseTool otherwise.
    ...(rules?.floor ? { sandbox: { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: true, ...(rules.floor === 'read-only' && rules.floorRoot ? { filesystem: { denyWrite: [rules.floorRoot] } } : {}) } } : {}),
    canUseTool: async (name: string, input: Record<string, unknown>, context?: { decisionReasonType?: string; suggestions?: unknown }) => {
      const mode = currentSandbox ? currentSandbox() : sandbox;
      const leaving = Boolean(rules?.floor) && name === 'Bash' && input.dangerouslyDisableSandbox === true;
      // Inside a read-only floor the OS keeps Bash from writing, so it may run.
      const sandboxed = rules?.floor === 'read-only' && name === 'Bash' && !leaving;
      const beyond = (mode === 'read-only' && !readers.includes(name) && !name.startsWith('mcp__alp__') && !sandboxed) ||
        // With a floor, file tools write only the workspace and temp files, like Bash.
        (Boolean(rules?.floor && rules.floorRoot) && WRITERS.includes(name) && typeof input.file_path === 'string' && !inside(path.resolve(rules!.floorRoot!, input.file_path), rules!.floorRoot!) && !inside(path.resolve(input.file_path), os.tmpdir())) ||
        (leaving && mode !== 'full-access');
      if (leaving && typeof input.command === 'string' && rules) {
        const decision = commandDecision(rules, input.command);
        if (decision === 'deny') return { behavior: 'deny', message: 'A deny rule of your permission profile covers it' };
        if (decision === 'allow') return { behavior: 'allow', updatedInput: input };
        if (decision === 'ask' && ask) context = { ...context, decisionReasonType: 'rule' };
      }
      const reason = context?.decisionReasonType === 'rule' && (rules?.ask?.length || leaving) ? 'rule' : beyond && rules?.beyondMode === 'ask' ? 'mode' : undefined;
      if (reason && ask) {
        const rule = reason === 'mode' ? suggestedRule(name, input, context?.suggestions) : undefined;
        const answer = await ask({ tool: name, input, reason, ...(rule ? { rule } : {}) });
        if (!answer.allow) return { behavior: 'deny', message: answer.message ?? 'The user did not allow it' };
        const [, toolName, ruleContent] = /^([^(]+)(?:\((.*)\))?$/s.exec(rule ?? '') ?? [];
        return { behavior: 'allow', updatedInput: input, ...(answer.always && toolName ? { updatedPermissions: [{ type: 'addRules', rules: [{ toolName, ...(ruleContent ? { ruleContent } : {}) }], behavior: 'allow', destination: 'session' }] } : {}) };
      }
      if (leaving && beyond) return { behavior: 'deny', message: 'Bash runs inside the sandbox; leaving it needs an allow rule in your permission profile' };
      if (beyond) return { behavior: 'deny', message: mode === 'read-only' ? 'ALP session is read-only' : 'Outside your workspace' };
      return { behavior: 'allow', updatedInput: input };
    },
  };
}

/** Whether Claude's last rate limit report means requests are refused: rejected, with no overage to fall back on. */
export const claudeLimited = (info?: { status: string; overageStatus?: string }) =>
  info?.status === 'rejected' && info.overageStatus !== 'allowed' && info.overageStatus !== 'allowed_warning';

/** Maps Claude Agent SDK streaming sessions to the normalized runtime protocol. */
export class ClaudeTransport {
  private listeners = new Set<Listener>();
  private failures = new Set<(error: Error) => void>();
  private requestHandler?: RequestHandler;
  /** Whether the workspace had a .claude directory before a sandboxed session started. */
  private claudeDirectory?: boolean;
  private input = new InputQueue();
  private query?: ClaudeQuery;
  private pump?: Promise<void>;
  private config?: NativeConfig;
  private threadId = '';
  private activeTurn?: string;
  private closed = false;
  private assistantText = new Map<string, string>();
  private toolCalls = new Map<string, { name: string; command: string }>();
  /** The last rate limit Claude reported, and whether the running turn hit one. */
  private rateLimit?: { status: string; resetsAt?: number; overageStatus?: string; rateLimitType?: string; utilization?: number };
  private limitedTurn = false;
  /** The model's context window and the fill at which Claude compacts it, as Claude reports them (ALPD §57). */
  private contextWindow?: number;
  private compactAt?: number;
  /** The compaction running now, from its start to its boundary. */
  private compaction?: string;
  /** The plugin directory that loads the agent's skills, removed on close. */
  private skillDirectory?: string;

  constructor(
    private readonly command: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    if (!path.isAbsolute(command)) {
      const names = process.platform === 'win32' && !path.extname(command) ? [command, `${command}.exe`] : [command];
      const candidates = (env.PATH ?? '').split(path.delimiter).filter(Boolean).flatMap(directory => names.map(name => path.resolve(directory, name)));
      const executable = candidates.find(candidate => {
        try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); } catch { return false; }
      });
      if (!executable) throw new Error('Claude executable not found on PATH; set ALP_CLAUDE_BIN to an absolute native executable');
      this.command = realpathSync(executable);
    }
    if (/\.(cmd|bat|ps1)$/i.test(this.command)) {
      throw new Error('Claude executable must be a native binary, not a shell launcher');
    }
  }

  async orchestrationContext() {
    const [catalog, usage] = await Promise.all([
      optionalRead(async () => this.query ? this.query.supportedModels() : undefined),
      // Without a session yet, a short-lived Claude process answers (ALPD §58); it takes a second or two.
      this.query
        ? optionalRead(async () => this.query!.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }))
        : optionalRead(() => this.probeUsage(), 15_000),
    ]);
    return { runtime: 'claude', observedAt: new Date().toISOString(), catalogAvailable: Array.isArray(catalog),
      models: (catalog ?? []).map(model => ({ id: `claude:${model.value}`, label: model.displayName,
        description: model.description, thinking: model.supportedEffortLevels })), usage: claudeUsage(usage) };
  }
  async initialize() {}

  /** The plan's usage windows before a session starts, from a Claude process that sends no prompt and is closed after. */
  private async probeUsage() {
    if (this.closed) return undefined;
    const { query } = await import(CLAUDE_SDK);
    const probe = query({ prompt: new InputQueue(), options: { cwd: this.cwd, env: this.env, settingSources: [], persistSession: false, strictMcpConfig: true, mcpServers: {}, pathToClaudeCodeExecutable: this.command } }) as ClaudeQuery;
    try {
      return await probe.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    } finally {
      probe.close();
    }
  }

  onNotification(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void) {
    this.failures.add(listener);
    return () => this.failures.delete(listener);
  }

  onRequest(handler: RequestHandler) {
    this.requestHandler = handler;
  }

  async request(method: string, params: any): Promise<any> {
    if (this.closed) throw new Error('Runtime is closed');

    if (method === 'session/configure') {
      if (!this.query || !this.config) throw new Error('Claude thread is not initialized');
      await this.query.setPermissionMode(claudePermissionMode(params.sandbox));
      this.config.sandbox = params.sandbox;
      return {};
    }

    if (method === 'thread/delete') {
      const { deleteSession } = await import(CLAUDE_SDK);
      await deleteSession(params.threadId, params.cwd ? { dir: params.cwd } : {});
      return {};
    }

    if (method === 'thread/start' || method === 'thread/resume' || method === 'thread/fork') {
      this.config = params as NativeConfig;
      this.threadId =
        method === 'thread/resume' ? params.threadId : randomUUID();
      // A fork resumes the thread's history under a new id, leaving the thread itself unchanged.
      await this.start(method === 'thread/start' ? undefined : { resume: params.threadId, fork: method === 'thread/fork' });
      return {
        thread: { id: this.threadId, turns: [] },
        cwd: this.cwd,
        model: params.model,
        reasoningEffort: params.thinking,
      };
    }

    if (method === 'turn/start' || method === 'turn/steer') {
      if (!this.query) throw new Error('Claude thread is not initialized');
      const turnId = method === 'turn/steer'
        ? params.expectedTurnId
        : randomUUID();
      if (method === 'turn/start') this.activeTurn = turnId;
      this.input.push({
        type: 'user',
        message: {
          role: 'user',
          content: params.input.map((part: any) => ({
            type: 'text',
            text: part.text,
          })),
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: this.threadId,
      });
      return method === 'turn/start' ? { turn: { id: turnId } } : {};
    }

    if (method === 'turn/interrupt') {
      await this.query?.interrupt();
      return {};
    }

    throw new Error(`Unsupported Claude runtime operation '${method}'`);
  }

  private async start(from?: { resume: string; fork: boolean }) {
    const { createSdkMcpServer, query, tool } = await import(CLAUDE_SDK);
    const config = this.config!;
    const mcpServers = this.convertMcp(config.mcpServers);

    if (config.dynamicTools.length) {
      const tools = config.dynamicTools.map(definition => {
        const base = toolShapes[definition.name];
        if (!base) throw new Error(`Unsupported ALP tool '${definition.name}'`);
        // A role's definition may offer fewer actions (alp_task) and fewer fields than the full shape.
        const schema = (definition as { inputSchema?: { properties?: Record<string, { enum?: string[] }> } }).inputSchema?.properties;
        const actions = schema?.action?.enum;
        const shape = Object.fromEntries(Object.entries(base)
          .filter(([key]) => !schema || key in schema)
          .map(([key, value]) => [key, key === 'action' && actions?.length ? z.enum(actions as [string, ...string[]]) : value]));
        return tool(definition.name, definition.description, shape, async (args: Record<string, unknown>) => {
          if (!this.requestHandler || !this.activeTurn) {
            return {
              content: [{ type: 'text', text: 'ALP tools are unavailable' }],
              isError: true,
            };
          }
          const callId = `claude-tool-${randomUUID()}`;
          this.emit('item/started', {
            threadId: this.threadId,
            item: {
              type: 'dynamicToolCall',
              id: callId,
              callId,
              tool: definition.name,
              arguments: args,
              status: 'inProgress',
            },
          });
          const result: any = await this.requestHandler('item/tool/call', {
            threadId: this.threadId,
            turnId: this.activeTurn,
            callId,
            namespace: null,
            tool: definition.name,
            arguments: args,
          });
          this.emit('item/completed', {
            threadId: this.threadId,
            item: {
              type: 'dynamicToolCall',
              id: callId,
              callId,
              tool: definition.name,
              arguments: args,
              status: result?.success === false ? 'failed' : 'completed',
              success: result?.success !== false,
              contentItems: result?.contentItems ?? [],
            },
          });
          return {
            content: (result?.contentItems ?? []).map((item: any) => ({
              type: 'text' as const,
              text: item.text ?? JSON.stringify(item),
            })),
            isError: result?.success === false,
          };
        });
      });
      mcpServers.alp = createSdkMcpServer({
        name: 'alp',
        version: '0.0.0',
        tools,
      });
    }

    if (config.floor) this.claudeDirectory ??= existsSync(path.join(config.cwd, '.claude'));
    const rules = config.permissions || config.floor ? { allow: [], deny: [], ...config.permissions, ...(config.floor ? { floor: config.floor, floorRoot: config.cwd } : {}) } : null;
    const { settings: ruleSettings, ...permissions } = claudePermissions(config.sandbox, () => config.sandbox, rules,
      async request => (this.requestHandler ? await this.requestHandler('item/permission/request', request) as PermissionAnswer : { allow: false, message: 'No one can approve it' }));
    const settings = { ...(config.thinking === 'ultracode' ? { ultracode: true } : {}), ...(config.context ? { autoCompactWindow: config.context } : {}), ...ruleSettings };
    // The agent's skills as Claude Code's own, so Claude lists them with their descriptions and calls them with Skill.
    const plugins: Array<{ type: 'local'; path: string; skipMcpDiscovery: boolean }> = [];
    if (config.skills?.length) {
      try {
        this.skillDirectory ??= path.join(os.tmpdir(), 'alp-skills', randomUUID());
        plugins.push({ type: 'local', path: skillPlugin(this.skillDirectory, config.skills), skipMcpDiscovery: true });
      } catch {
        // The skills stay listed in the instructions by file.
      }
    }
    const options = {
      cwd: config.cwd,
      env: this.env,
      model: config.model,
      effort: ['none', 'off', 'ultracode'].includes(config.thinking) ? undefined : config.thinking,
      thinking: ['none', 'off'].includes(config.thinking) ? { type: 'disabled' } : { type: 'adaptive' },
      systemPrompt: config.developerInstructions,
      ...permissions,
      ...(Object.keys(settings).length ? { settings } : {}),
      mcpServers,
      strictMcpConfig: true,
      settingSources: [],
      ...(plugins.length ? { plugins } : {}),
      persistSession: !config.ephemeral,
      promptSuggestions: false,
      includePartialMessages: false,
      ...(from ? { resume: from.resume, ...(from.fork ? { forkSession: true, sessionId: this.threadId } : {}) } : { sessionId: this.threadId }),
      // Explicit native path avoids SDK optional binaries inside Electron app.asar.
      pathToClaudeCodeExecutable: this.command,
    };

    this.query = query({ prompt: this.input, options }) as ClaudeQuery;
    this.pump = this.consume(this.query).catch((error) => this.fail(error));
    void this.measureContext();
  }

  /** Reads the window and the compaction threshold Claude resolved for this session, before any turn. */
  private async measureContext() {
    // The first read waits for Claude to start; a reply from usage lets ALP guess meanwhile.
    const usage: any = await optionalRead(async () => this.query?.getContextUsage({ detail: 'summary' }), 60_000);
    if (!usage) return;
    const window = usage.rawMaxTokens ?? usage.maxTokens;
    if (typeof window === 'number' && window > 0) this.contextWindow = window;
    this.compactAt = usage.isAutoCompactEnabled !== false && typeof usage.autoCompactThreshold === 'number' && usage.autoCompactThreshold > 0 ? usage.autoCompactThreshold : undefined;
  }

  private convertMcp(values: Record<string, any>) {
    const result: Record<string, any> = {};
    for (const [name, value] of Object.entries(values)) {
      result[name] = value.url
        ? {
            type: 'http',
            url: value.url,
            headers: value.http_headers ?? {},
          }
        : {
            type: 'stdio',
            command: value.command,
            args: value.args ?? [],
            env: value.env ?? {},
          };
    }
    return result;
  }

  private async consume(stream: ClaudeQuery) {
    for await (const message of stream) this.handle(message);
    if (!this.closed) this.fail(new Error('Claude session exited'));
  }

  private handle(message: SDKMessage) {
    if (message.type === 'rate_limit_event') {
      this.rateLimit = message.rate_limit_info;
      this.emit('account/rateLimits/updated', { claude: message.rate_limit_info });
      return;
    }
    // Claude starts a turn by itself when a background task it ran ends (ALPD §56). Adopt it, so
    // ALP's tools work in it and its end is reported like any other turn's.
    if (message.type === 'assistant' && !message.parent_tool_use_id && !this.activeTurn && !this.closed) {
      this.activeTurn = randomUUID();
      this.emit('turn/started', { threadId: this.threadId, turn: { id: this.activeTurn } });
    }
    if (message.type === 'assistant' && message.error === 'rate_limit') this.limitedTurn = true;
    // A compaction, reported as Codex reports one: a contextCompaction item from start to end (ALPD §57).
    if (message.type === 'system' && (message.subtype === 'status' || message.subtype === 'compact_boundary')) {
      const system = message as any;
      if (system.subtype === 'status' && system.status === 'compacting' && !this.compaction) {
        this.compaction = randomUUID();
        this.emit('item/started', { threadId: this.threadId, turnId: this.activeTurn, item: { type: 'contextCompaction', id: this.compaction } });
      } else if (system.subtype === 'status' && system.compact_result === 'failed') {
        this.emit('item/completed', { threadId: this.threadId, turnId: this.activeTurn, item: { type: 'contextCompaction', id: this.compaction ?? randomUUID(), status: 'failed', error: system.compact_error } });
        this.compaction = undefined;
      } else if (system.subtype === 'compact_boundary') {
        const meta = system.compact_metadata ?? {};
        this.emit('item/completed', {
          threadId: this.threadId, turnId: this.activeTurn,
          item: { type: 'contextCompaction', id: this.compaction ?? randomUUID(), status: 'completed', trigger: meta.trigger, preTokens: meta.pre_tokens, postTokens: meta.post_tokens },
        });
        this.compaction = undefined;
      }
      return;
    }
    // How full the context is, reported as Codex does: the tokens of the latest model call against the window.
    // Until Claude has said what its window is, ALP does not guess one (ALPD §57).
    const usage = message.type === 'assistant' && !message.parent_tool_use_id ? (message.message as any).usage : undefined;
    if (usage) {
      const totalTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
      const last = { totalTokens, inputTokens: usage.input_tokens ?? 0, cachedInputTokens: usage.cache_read_input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 };
      this.emit('thread/tokenUsage/updated', {
        threadId: this.threadId, turnId: this.activeTurn,
        tokenUsage: { last, total: last, modelContextWindow: this.contextWindow ?? null, ...(this.compactAt ? { autoCompactTokens: this.compactAt } : {}) },
      });
    }
    if (message.type === 'result') {
      const windows = Object.values((message as any).modelUsage ?? {}).map((entry: any) => entry?.contextWindow).filter((value): value is number => typeof value === 'number' && value > 0);
      // Only when it was not measured: the measured window may be the setting's, smaller than the model's.
      if (windows.length && !this.compactAt) this.contextWindow = Math.max(...windows);
    }
    if (message.type === 'assistant' && !message.parent_tool_use_id) {
      for (const block of message.message.content as any[]) {
        if (block.type === 'text') {
          const id = message.message.id;
          const text = (this.assistantText.get(id) ?? '') + block.text;
          this.assistantText.set(id, text);
          this.emit('item/completed', {
            threadId: this.threadId,
            item: { type: 'agentMessage', id, text },
          });
        } else if (block.type === 'tool_use') {
          const command = block.name === 'Bash'
            ? String(block.input?.command ?? '')
            : `${block.name} ${JSON.stringify(block.input ?? {})}`;
          this.toolCalls.set(block.id, { name: block.name, command });
          this.emit('item/started', {
            threadId: this.threadId,
            item: {
              type: 'commandExecution',
              id: block.id,
              command,
              cwd: this.cwd,
              status: 'inProgress',
              aggregatedOutput: '',
            },
          });
        }
      }
      return;
    }

    if (message.type === 'user') {
      const content = Array.isArray(message.message.content)
        ? message.message.content as any[]
        : [];
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const call = this.toolCalls.get(block.tool_use_id);
        if (!call) continue;
        const output = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content ?? '');
        this.emit('item/completed', {
          threadId: this.threadId,
          item: {
            type: 'commandExecution',
            id: block.tool_use_id,
            command: call.command,
            cwd: this.cwd,
            status: block.is_error ? 'failed' : 'completed',
            exitCode: block.is_error ? 1 : 0,
            aggregatedOutput: output,
          },
        });
        this.toolCalls.delete(block.tool_use_id);
      }
      return;
    }

    if (message.type === 'result' && this.activeTurn) {
      const turnId = this.activeTurn;
      this.activeTurn = undefined;
      // A usage limit ends the turn with an error message or a failed result; report it as Codex does.
      const limited = this.limitedTurn || (message.is_error && claudeLimited(this.rateLimit));
      this.limitedTurn = false;
      const failed = message.is_error || limited;
      this.emit('turn/completed', {
        threadId: this.threadId,
        turn: {
          id: turnId,
          status: failed ? 'failed' : 'completed',
          ...(failed
            ? { error: {
              message: limited ? `Claude usage limit reached${this.rateLimit?.resetsAt ? `; resets ${new Date(this.rateLimit.resetsAt * 1000).toISOString()}` : ''}` : 'errors' in message && message.errors?.length ? message.errors.join('; ') : 'Claude turn failed',
              ...(limited ? { codexErrorInfo: 'usageLimitExceeded', ...(this.rateLimit?.resetsAt ? { resetsAt: this.rateLimit.resetsAt } : {}) } : {}),
            } }
            : {}),
        },
      });
    }
  }

  private emit(method: string, params: any) {
    for (const listener of this.listeners) listener(method, params);
  }

  private fail(value: unknown) {
    if (this.closed) return;
    const error = value instanceof Error ? value : new Error(String(value));
    for (const listener of this.failures) listener(error);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    this.query?.close();
    await this.pump?.catch(() => {});
    this.listeners.clear();
    this.failures.clear();
    if (this.skillDirectory) rmSync(this.skillDirectory, { recursive: true, force: true });
    // Claude's sandbox leaves an empty .claude/.cc-writes in the workspace; remove what it created.
    if (this.claudeDirectory === false && this.config) {
      for (const directory of ['.claude/.cc-writes', '.claude']) { try { rmdirSync(path.join(this.config.cwd, directory)); } catch {} }
    }
  }
}
