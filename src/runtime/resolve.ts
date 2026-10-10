import path from 'node:path';
import { access, readFile, stat } from 'node:fs/promises';
import { resolveWorkflow } from '../core/workflow.js';
import { initProject } from '../core/init.js';
import { resolveAgent } from '../core/resolver.js';
import { resolveTeam } from '../core/teams.js';
import { loadHooks } from '../core/hooks.js';
import { acpModel, loadProvider } from '../core/providers.js';
import type { AcpProvider } from './acp-transport.js';
import { ensureLibrary } from '../core/library.js';
import { compileAgent } from '../core/adapter.js';
import { capMode, profileFor } from '../core/permissions.js';
import { userLanguage } from '../core/user-settings.js';
import { claudeSandboxAvailable } from './claude-transport.js';
import type { ResolvedAgent } from '../core/types.js';
import type { AlpRuntimeAdapter } from '../core/adapter.js';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_MODEL, ORACLE_MODELS, ORACLE_THINKING, modes, thinkingOptions, thinkingOptionsFor } from './catalog.js';

/** Codex and Claude Code, or an ACP agent the user's library defines (ALPD §46). */
export type RuntimeKind = 'codex' | 'claude' | 'acp';

/** MCP servers a client adds to the agent's own; the agent's names win no collisions. */
export type HostMcpServer =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

/** What a client asks for; resolveSession turns it into a launchable session. */
export type SessionSpec = {
  cwd: string;
  agent?: string;
  /** Workflow selected for a new session; omitted uses settings or the restored snapshot. */
  workflow?: string;
  /** Native model, or runtime-prefixed (`codex:`/`claude:`, or `acp:<provider>[/<model>]`) to also choose the runtime. */
  model?: string;
  mode?: string;
  thinking?: string;
  systemPrompt?: string;
  env?: Record<string, string>;
  mcpServers?: Record<string, HostMcpServer>;
  /** Keep the native thread so the session can be resumed. */
  persist?: boolean;
  /** Keep the native thread on disk though the session cannot be resumed: an assignment, which alp_recall may question later. */
  keepThread?: boolean;
  restore?: { agent: string; threadId: string; runtime?: string; model?: string; workflow?: { mode: string; maxPeers: number; supervisor?: boolean } };
  /** Where the native harness works, when not the project root: an assignment's git worktree. ALP files are still read from cwd. */
  workdir?: string;
  /** The workdir is a disposable copy the session may write, though its mode is read-only for the requester's tree. */
  copy?: boolean;
  /** The requester's directory the copy mirrors. */
  copyOf?: string;
};

export type ResolvedSession = Awaited<ReturnType<typeof resolveSession>>;

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/** Composes project and agent instructions with lazily referenced skills. */
export class InstructionsAdapter implements AlpRuntimeAdapter<{ instructions: string; mcp: ResolvedAgent['mcp']; runtime: ResolvedAgent['runtime'] }> {
  id = 'native';
  // ALP runs an agent's hooks itself, at its own events (ALPD §45).
  capabilities() { return { instructions: 'emulated', skills: 'emulated', hooks: 'emulated', mcp: 'native' } as const; }
  async compile(agent: ResolvedAgent) {
    const skills = agent.skills.length ? `Available skills (read a SKILL.md only when needed):\n${agent.skills.map(s => `${JSON.stringify(s.name)}: ${JSON.stringify(s.path)}`).join('\n')}` : '';
    return { adapterId: this.id, agentName: agent.name, projectRoot: agent.projectRoot, material: {
      instructions: [agent.instructions.project, agent.instructions.agent, skills].filter(Boolean).join('\n\n'),
      mcp: agent.mcp, runtime: agent.runtime,
    } };
  }
}

/** Lessons main recorded after supervisor reviews; the newest are kept when the file grows. */
export const LESSONS_FILE = 'lessons.md';
const LESSON_CHARS = 6000;

async function lessons(file: string) {
  const text = (await readFile(file, 'utf8').catch(() => '')).trim();
  return text.length > LESSON_CHARS ? `…\n${text.slice(-LESSON_CHARS)}` : text;
}

/** Agents that advise, review, or watch: they never write, and take no tasks. */
export const READ_ONLY_AGENTS = ['oracle', 'reviewer', 'supervisor'];

export async function resolveSession(spec: SessionSpec, options: { templates?: Record<string, string>; library?: string; language?: string } = {}) {
  if (!path.isAbsolute(spec.cwd) || !(await stat(spec.cwd)).isDirectory()) throw new Error('Session cwd must be an existing absolute directory');
  if (spec.workdir !== undefined && (!path.isAbsolute(spec.workdir) || !(await stat(spec.workdir)).isDirectory())) throw new Error('Session workdir must be an existing absolute directory');
  const starter = options.templates ? { templates: options.templates } : {};
  if (!(await exists(path.join(spec.cwd, 'ALP.md'))) || !(await exists(path.join(spec.cwd, '.alp', 'settings.json')))) await initProject(spec.cwd, starter);
  if (options.library) await ensureLibrary(options.library, options.templates ? { templates: options.templates } : {});
  const restored = spec.restore;
  if (restored && spec.agent !== undefined && spec.agent !== restored.agent) throw new Error('Cannot resume a thread as a different ALP agent');
  const { team, ...workflow } = await resolveWorkflow(spec.cwd, spec.workflow, restored?.workflow, { library: options.library, templates: options.templates });
  const agent = await resolveAgent(spec.cwd, { agent: spec.agent ?? restored?.agent, library: options.library, templates: options.templates });
  if (agent.name === 'oracle' && !restored && !ORACLE_MODELS.includes(spec.model ?? '')) throw new Error(`Oracle runs on ${ORACLE_MODELS.join(' or ')}; choose one`);
  const compiled = await compileAgent(new InstructionsAdapter(), agent);
  // Order (ALPD §42): the caller, then settings.json's runtime, then the team's choice for this member, then the agent's own.
  // A resumed session keeps its model; it keeps the team's effort while it still runs on the team's model.
  // A custom graph has no team; its main runs as Phở's does, and follows Phở's house rules, as before teams.
  const base = team ?? await resolveTeam(undefined, 'pho', { templates: options.templates });
  const main = base.main;
  const member = Object.hasOwn(base.members, agent.name) && (team || agent.name === main) ? base.members[agent.name] : undefined;
  const sameModel = (id?: string) => id === undefined || restored?.model === undefined || `${restored.runtime}:${restored.model}` === id || restored.model === id;
  const teamChoice = member && !agent.projectRuntime?.model && !agent.projectRuntime?.provider && spec.model === undefined && sameModel(member.model) ? member : undefined;
  let runtimeKind = restored?.runtime ?? (teamChoice?.model ? undefined : agent.runtime.provider) ?? 'codex';
  let model = restored?.model ?? spec.model ?? teamChoice?.model ?? agent.runtime.model ?? (runtimeKind === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_MODEL);
  if (model.startsWith('codex:')) { runtimeKind = 'codex'; model = model.slice('codex:'.length); }
  if (model.startsWith('claude:')) { runtimeKind = 'claude'; model = model.slice('claude:'.length); }
  if (model.startsWith('codex/')) { runtimeKind = 'codex'; model = model.slice('codex/'.length); }
  if (model.startsWith('claude/')) { runtimeKind = 'claude'; model = model.slice('claude/'.length); }
  if (model.startsWith('acp:')) { runtimeKind = 'acp'; model = model.slice('acp:'.length); }
  // An agent.json provider other than codex or claude names an ACP provider of the library; its model is that provider's.
  if (!['codex', 'claude', 'acp'].includes(runtimeKind)) { model = model === DEFAULT_MODEL && agent.runtime.model !== DEFAULT_MODEL ? runtimeKind : `${runtimeKind}/${model}`; runtimeKind = 'acp'; }
  if (restored?.runtime && runtimeKind !== restored.runtime) throw new Error('Cannot resume a thread with a different runtime provider');
  let acp: AcpProvider | undefined;
  if (runtimeKind === 'acp') {
    const { provider: id, model: native } = acpModel(model);
    acp = await loadProvider(options.library, id) as AcpProvider | undefined;
    if (!acp) throw new Error(`No ACP provider '${id}': add one to your library with alp provider add ${id}, or name codex or claude`);
    if (native && acp.models && !acp.models.some(candidate => candidate.id === native)) throw new Error(`ACP provider '${id}' lists no model '${native}'`);
    if (spec.copy) throw new Error('A review copy cannot run on an ACP agent: ALP cannot keep its commands inside the copy');
  }
  // Main has full access unless the caller limits it; a permission profile caps the mode at its base.
  const permissions = await profileFor(agent.projectRoot, options.library, agent.name);
  const requested = spec.mode ?? agent.mode ?? (agent.name === main ? 'full-access' : 'read-only');
  const mode = permissions ? capMode(requested, permissions.base) : requested;
  // An ACP agent chooses its own effort.
  const availableThinking = runtimeKind === 'acp' ? [] : thinkingOptionsFor(runtimeKind as 'codex' | 'claude', model);
  const thinking = runtimeKind === 'acp' ? 'none' : spec.thinking ?? agent.projectRuntime?.reasoning ?? teamChoice?.thinking ?? agent.runtime.reasoning ??
    (agent.name === 'oracle' ? ORACLE_THINKING : availableThinking.length ? 'medium' : 'none');
  if (!model.trim()) throw new Error('Model must be nonempty');
  if (!modes.some(m => m.id === mode)) throw new Error(`Unsupported mode '${mode}'`);
  // Only Claude's Bash sandbox keeps a session in a copy from writing elsewhere.
  if (spec.copy && runtimeKind === 'claude' && !claudeSandboxAvailable()) throw new Error('A review copy on Claude needs its Bash sandbox (Seatbelt on macOS; bubblewrap and socat on Linux)');
  if (!thinkingOptions.some(m => m.id === thinking)) throw new Error(`Unsupported thinking option '${thinking}'`);
  if (availableThinking.length && !availableThinking.some(candidate => candidate.id === thinking)) throw new Error(`Thinking option '${thinking}' is unsupported by ${runtimeKind}:${model}`);
  const mcp: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(compiled.material.mcp.mcpServers) as [string, any][]) {
    const { headers, ...rest } = value;
    Object.defineProperty(mcp, name, { value: { ...rest, ...(headers ? { http_headers: headers } : {}) }, enumerable: true, writable: true });
  }
  for (const [name, value] of Object.entries(spec.mcpServers ?? {})) {
    if (Object.hasOwn(mcp, name)) throw new Error(`MCP server name collision: '${name}'`);
    if (value.type === 'sse') throw new Error(`SSE MCP server '${name}' is unsupported by this runtime`);
    const server = value.type === 'stdio'
      ? { command: value.command, args: value.args ?? [], env: value.env ?? {} }
      : { url: value.url, http_headers: value.headers ?? {} };
    Object.defineProperty(mcp, name, { value: server, enumerable: true, writable: true });
  }
  // Main follows its lessons; the supervisor checks them.
  let learned = '';
  const supervisorAgent = team?.supervisor ? team.supervisor.agent : undefined;
  if ([main, supervisorAgent].includes(agent.name) && workflow.supervisor) {
    const user = options.library ? await lessons(path.join(options.library, LESSONS_FILE)) : '';
    const project = await lessons(path.join(agent.projectRoot, '.alp', LESSONS_FILE));
    if (user || project) {
      learned = 'Lessons main recorded after earlier supervisor reviews. Follow them; they are the user\'s process, not a task.' +
        (user ? `\n\nFor every project:\n${user}` : '') + (project ? `\n\nFor this project:\n${project}` : '');
    }
  }
  const houseRules = base.houseRules;
  const hooks = await loadHooks(agent);
  return {
    agent, workflow, team, houseRules, hooks, runtimeKind: runtimeKind as RuntimeKind, model, ...(acp ? { acp } : {}), mode, permissions, thinking, threadId: restored?.threadId,
    workdir: spec.workdir ?? agent.projectRoot,
    copy: Boolean(spec.copy && spec.workdir),
    ...(spec.copy && spec.copyOf ? { copyOf: spec.copyOf } : {}),
    instructions: [compiled.material.instructions, learned, spec.systemPrompt].filter(Boolean).join('\n\n'),
    mcp, env: { ...spec.env }, persist: spec.persist ?? false, keepThread: spec.keepThread ?? false,
    // ALPD §57: the window the agent works in before its runtime compacts; absent, the model's.
    ...(agent.context ? { context: agent.context } : {}),
    // ALPD §54: the language everything the user reads is written in.
    language: options.language ?? await userLanguage(options.library),
  };
}
