import path from 'node:path';
import { access, stat } from 'node:fs/promises';
import { resolveWorkflow } from '../core/workflow.js';
import { initProject } from '../core/init.js';
import { resolveAgent } from '../core/resolver.js';
import { compileAgent } from '../core/adapter.js';
import type { ResolvedAgent } from '../core/types.js';
import type { AlpRuntimeAdapter } from '../core/adapter.js';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_MODEL, modes, thinkingOptions, thinkingOptionsFor } from './catalog.js';

export type RuntimeKind = 'codex' | 'claude';

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
  /** Native model, or runtime-prefixed (`codex:`/`claude:`) to also choose the runtime. */
  model?: string;
  mode?: string;
  thinking?: string;
  systemPrompt?: string;
  env?: Record<string, string>;
  mcpServers?: Record<string, HostMcpServer>;
  /** Keep the native thread so the session can be resumed. */
  persist?: boolean;
  restore?: { agent: string; threadId: string; runtime?: string; model?: string; workflow?: { mode: string; maxPeers: number } };
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
  capabilities() { return { instructions: 'emulated', skills: 'emulated', hooks: 'unsupported', mcp: 'native' } as const; }
  async compile(agent: ResolvedAgent) {
    const skills = agent.skills.length ? `Available skills (read a SKILL.md only when needed):\n${agent.skills.map(s => `${JSON.stringify(s.name)}: ${JSON.stringify(s.path)}`).join('\n')}` : '';
    return { adapterId: this.id, agentName: agent.name, projectRoot: agent.projectRoot, material: {
      instructions: [agent.instructions.project, agent.instructions.agent, skills].filter(Boolean).join('\n\n'),
      mcp: agent.mcp, runtime: agent.runtime,
    } };
  }
}

export async function resolveSession(spec: SessionSpec, options: { templates?: Record<string, string> } = {}) {
  if (!path.isAbsolute(spec.cwd) || !(await stat(spec.cwd)).isDirectory()) throw new Error('Session cwd must be an existing absolute directory');
  const hasProjectFile = await exists(path.join(spec.cwd, 'ALP.md'));
  const hasMainAgent = await exists(path.join(spec.cwd, '.alp', 'agents', 'main', 'AGENT.md'));
  if (!hasProjectFile || !hasMainAgent) await initProject(spec.cwd, options.templates ? { templates: options.templates } : {});
  const restored = spec.restore;
  if (restored && spec.agent !== undefined && spec.agent !== restored.agent) throw new Error('Cannot resume a thread as a different ALP agent');
  const workflow = await resolveWorkflow(spec.cwd, spec.workflow, restored?.workflow);
  const agent = await resolveAgent(spec.cwd, { agent: spec.agent ?? restored?.agent });
  if (agent.name === 'oracle' && !restored && (!spec.model || !spec.thinking)) throw new Error('Oracle requires an explicit premium model and effort');
  const compiled = await compileAgent(new InstructionsAdapter(), agent);
  let runtimeKind = restored?.runtime ?? agent.runtime.provider ?? 'codex';
  let model = restored?.model ?? spec.model ?? agent.runtime.model ?? (runtimeKind === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_MODEL);
  if (model.startsWith('codex:')) { runtimeKind = 'codex'; model = model.slice('codex:'.length); }
  if (model.startsWith('claude:')) { runtimeKind = 'claude'; model = model.slice('claude:'.length); }
  if (model.startsWith('codex/')) { runtimeKind = 'codex'; model = model.slice('codex/'.length); }
  if (model.startsWith('claude/')) { runtimeKind = 'claude'; model = model.slice('claude/'.length); }
  if (!['codex', 'claude'].includes(runtimeKind)) throw new Error(`Unsupported ALP runtime provider '${runtimeKind}'`);
  if (restored?.runtime && runtimeKind !== restored.runtime) throw new Error('Cannot resume a thread with a different runtime provider');
  const mode = ['oracle', 'reviewer'].includes(agent.name) ? 'read-only' : spec.mode ?? 'read-only';
  const availableThinking = thinkingOptionsFor(runtimeKind as RuntimeKind, model);
  const thinking = spec.thinking ?? agent.runtime.reasoning ?? (availableThinking.length ? 'medium' : 'none');
  if (!model.trim()) throw new Error('Model must be nonempty');
  if (!modes.some(m => m.id === mode)) throw new Error(`Unsupported mode '${mode}'`);
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
  return {
    agent, workflow, runtimeKind: runtimeKind as RuntimeKind, model, mode, thinking, threadId: restored?.threadId,
    instructions: [compiled.material.instructions, spec.systemPrompt].filter(Boolean).join('\n\n'),
    mcp, env: { ...spec.env }, persist: spec.persist ?? false,
  };
}
