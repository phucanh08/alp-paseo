import path from 'node:path';
import { resolveWorkflow } from '../../../src/core/workflow.js';
import { access, stat } from 'node:fs/promises';
import { initProject } from '../../../src/core/init.js';
import bundledTemplates from 'alp:templates';
import { resolveAgent } from '../../../src/core/resolver.js';
import { compileAgent } from '../../../src/core/adapter.js';
import type { ResolvedAgent } from '../../../src/core/types.js';
import type { AlpRuntimeAdapter } from '../../../src/core/adapter.js';
import type { ProviderSessionConfig, ProviderPersistence } from './compat.js';

export const DEFAULT_MODEL = 'gpt-5.6-sol';
export const DEFAULT_CLAUDE_MODEL = 'sonnet';
export const modes = [{ id: 'read-only', label: 'Read only' }, { id: 'workspace-write', label: 'Workspace write' }];
const option = (id: string) => ({ id, label: id });
const options = (ids: string[]) => ids.map(option);
const codexFull = options(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const codexStandard = options(['low', 'medium', 'high', 'xhigh', 'max']);
const claudeFull = options(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
const claudeLegacy = options(['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
const claude46 = options(['off', 'low', 'medium', 'high', 'max']);
export const thinkingOptions = options(['none', 'off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']);
async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

const model = (runtime: 'codex' | 'claude', id: string, label: string, description: string, modelThinkingOptions: Array<{ id: string; label: string }>, defaultThinkingOptionId?: string) => ({
  id: `${runtime}:${id}`,
  label: `${runtime === 'codex' ? 'Codex' : 'Claude Code'} · ${label}`,
  description,
  thinkingOptions: modelThinkingOptions,
  ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}),
});

export const models = [
  model('codex', 'gpt-6.1-sol', 'GPT-6.1-Sol', 'Latest workhorse model for coding and everyday work.', codexFull, 'low'),
  model('codex', 'gpt-6-astra', 'GPT-6-Astra', 'Frontier intelligence for the most demanding work.', codexFull, 'low'),
  model('codex', 'gpt-6-sol', 'GPT-6-Sol', 'Previous generation workhorse model.', codexFull, 'low'),
  model('codex', 'gpt-6-luna', 'GPT-6-Luna', 'Fast and affordable model for easier tasks.', codexStandard, 'low'),
  model('codex', 'gpt-5.6-sol', 'GPT-5.6-Sol', 'Older generation workhorse model.', codexFull, 'low'),
  model('codex', 'gpt-5.6-terra', 'GPT-5.6-Terra', 'Older balanced model for straightforward work.', codexFull, 'low'),
  model('codex', 'gpt-5.6-luna', 'GPT-5.6-Luna', 'Older fast and efficient model.', codexStandard, 'low'),
  model('claude', 'claude-opus-5-5', 'Opus 5.5', 'Latest release.', claudeFull, 'medium'),
  model('claude', 'claude-opus-5', 'Opus 5', 'Previous release.', claudeLegacy, 'high'),
  model('claude', 'claude-fable-5-1', 'Fable 5.1', 'Most powerful model.', claudeFull, 'high'),
  model('claude', 'claude-fable-5', 'Fable 5', 'Previous release.', claudeFull, 'high'),
  model('claude', 'claude-opus-4-8[1m]', 'Opus 4.8 1M', 'Opus 4.8 with 1M context window.', claudeLegacy, 'high'),
  model('claude', 'claude-opus-4-8', 'Opus 4.8', 'Previous release.', claudeLegacy, 'high'),
  model('claude', 'claude-sonnet-5-5', 'Sonnet 5.5', 'Best for everyday tasks.', claudeFull, 'medium'),
  model('claude', 'claude-sonnet-5', 'Sonnet 5', 'Previous release.', claudeLegacy, 'high'),
  model('claude', 'claude-sonnet-5[1m]', 'Sonnet 5 1M', 'Sonnet 5 with 1M context window.', claudeLegacy, 'high'),
  model('claude', 'claude-opus-4-7[1m]', 'Opus 4.7 1M', 'Opus 4.7 with 1M context window.', claudeLegacy, 'high'),
  model('claude', 'claude-opus-4-7', 'Opus 4.7', 'Previous release.', claudeLegacy, 'high'),
  model('claude', 'claude-opus-4-6[1m]', 'Opus 4.6 1M', 'Opus 4.6 with 1M context window.', claude46, 'high'),
  model('claude', 'claude-opus-4-6', 'Opus 4.6', 'Most capable for complex work.', claude46, 'high'),
  model('claude', 'claude-sonnet-4-6[1m]', 'Sonnet 4.6 1M', 'Sonnet 4.6 with 1M context window.', claude46, 'high'),
  model('claude', 'claude-sonnet-4-6', 'Sonnet 4.6', 'Best for everyday tasks.', claude46, 'high'),
  model('claude', 'claude-haiku-4-5', 'Haiku 4.5', 'Fastest for quick answers.', [], undefined),
  model('claude', 'sonnet', 'sonnet', 'From Claude settings.json model.', [], undefined),
];

export function thinkingOptionsFor(runtime: 'codex' | 'claude', nativeModel: string) {
  return models.find(candidate => candidate.id === `${runtime}:${nativeModel}`)?.thinkingOptions ?? thinkingOptions;
}

export class PaseoAdapter implements AlpRuntimeAdapter<{ instructions: string; mcp: ResolvedAgent['mcp']; runtime: ResolvedAgent['runtime'] }> {
  id = 'paseo';
  capabilities() { return { instructions: 'emulated', skills: 'emulated', hooks: 'unsupported', mcp: 'native' } as const; }
  async compile(agent: ResolvedAgent) {
    const skills = agent.skills.length ? `Available skills (read a SKILL.md only when needed):\n${agent.skills.map(s => `${JSON.stringify(s.name)}: ${JSON.stringify(s.path)}`).join('\n')}` : '';
    return { adapterId: this.id, agentName: agent.name, projectRoot: agent.projectRoot, material: {
      instructions: [agent.instructions.project, agent.instructions.agent, skills].filter(Boolean).join('\n\n'),
      mcp: agent.mcp, runtime: agent.runtime,
    } };
  }
}

export async function mapSession(config: ProviderSessionConfig, persistence?: ProviderPersistence) {
  if (!path.isAbsolute(config.cwd) || !(await stat(config.cwd)).isDirectory()) throw new Error('Session cwd must be an existing absolute directory');
  const hasProjectFile = await exists(path.join(config.cwd, 'ALP.md'));
  const hasMainAgent = await exists(path.join(config.cwd, '.alp', 'agents', 'main', 'AGENT.md'));
  if (!hasProjectFile || !hasMainAgent) await initProject(config.cwd, { templates: bundledTemplates });
  const options = config.providerOptions ?? {};
  for (const key of Object.keys(options)) if (!['agent', 'workflow'].includes(key)) throw new Error(`Unknown ALP provider option '${key}'`);
  if (options.agent !== undefined && (typeof options.agent !== 'string' || !options.agent.trim())) throw new Error('providerOptions.agent must be a nonempty string');
  if (Object.keys(config.settings).some(key => key !== 'workflow')) throw new Error('Unknown ALP session setting');
  if (config.settings.workflow !== undefined && typeof config.settings.workflow !== 'string') throw new Error('workflow must be a string');
  if (config.toolPolicy) throw new Error('Per-tool approval policy is unsupported by this prototype');
  const restored = persistence?.data as { agent?: string; cwd?: string; threadId?: string; runtime?: string; model?: string; workflow?: { mode: string; maxPeers: number } } | undefined;
  if (persistence && (persistence.version !== 1 || !restored || typeof restored.agent !== 'string' || typeof restored.threadId !== 'string' || restored.cwd !== path.resolve(config.cwd))) throw new Error('Invalid ALP persistence or project mismatch');
  if (restored && options.agent !== undefined && options.agent !== restored.agent) throw new Error('Cannot resume a thread as a different ALP agent');
  if (options.workflow !== undefined && typeof options.workflow !== 'string') throw new Error('providerOptions.workflow must be a string');
  if (options.workflow !== undefined && config.settings.workflow !== undefined && options.workflow !== config.settings.workflow) throw new Error('Conflicting workflow selections');
  const workflow = await resolveWorkflow(config.cwd, options.workflow ?? config.settings.workflow, restored?.workflow);
  const agent = await resolveAgent(config.cwd, { agent: options.agent ?? restored?.agent });
  if (agent.name === 'oracle' && !restored && (!config.model || !config.thinkingOption)) throw new Error('Oracle requires an explicit premium model and effort');
  const compiled = await compileAgent(new PaseoAdapter(), agent);
  let runtimeKind = restored?.runtime ?? agent.runtime.provider ?? 'codex';
  let model = restored?.model ?? config.model ?? agent.runtime.model ?? (runtimeKind === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_MODEL);
  if (model.startsWith('codex:')) { runtimeKind = 'codex'; model = model.slice('codex:'.length); }
  if (model.startsWith('claude:')) { runtimeKind = 'claude'; model = model.slice('claude:'.length); }
  if (model.startsWith('codex/')) { runtimeKind = 'codex'; model = model.slice('codex/'.length); }
  if (model.startsWith('claude/')) { runtimeKind = 'claude'; model = model.slice('claude/'.length); }
  if (!['codex', 'claude'].includes(runtimeKind)) throw new Error(`Unsupported ALP runtime provider '${runtimeKind}'`);
  if (restored?.runtime && runtimeKind !== restored.runtime) throw new Error('Cannot resume a thread with a different runtime provider');
  const mode = ['oracle', 'reviewer'].includes(agent.name) ? 'read-only' : config.mode ?? 'read-only';
  const availableThinking = thinkingOptionsFor(runtimeKind as 'codex' | 'claude', model);
  const thinking = config.thinkingOption ?? agent.runtime.reasoning ?? (availableThinking.length ? 'medium' : 'none');
  if (!model.trim()) throw new Error('Model must be nonempty');
  if (!modes.some(m => m.id === mode)) throw new Error(`Unsupported mode '${mode}'`);
  if (!thinkingOptions.some(m => m.id === thinking)) throw new Error(`Unsupported thinking option '${thinking}'`);
  if (availableThinking.length && !availableThinking.some(candidate => candidate.id === thinking)) throw new Error(`Thinking option '${thinking}' is unsupported by ${runtimeKind}:${model}`);
  const mcp: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(compiled.material.mcp.mcpServers) as [string, any][]) {
    const { headers, ...rest } = value;
    Object.defineProperty(mcp, name, { value: { ...rest, ...(headers ? { http_headers: headers } : {}) }, enumerable: true, writable: true });
  }
  for (const [name, value] of Object.entries(config.mcpServers)) {
    if (Object.hasOwn(mcp, name)) throw new Error(`MCP server name collision: '${name}'`);
    if (value.type === 'sse') throw new Error(`SSE MCP server '${name}' is unsupported by this runtime`);
    const server = value.type === 'stdio'
      ? { command: value.command, args: value.args ?? [], env: value.env ?? {} }
      : { url: value.url, http_headers: value.headers ?? {} };
    Object.defineProperty(mcp, name, { value: server, enumerable: true, writable: true });
  }
  return {
    agent, workflow, runtimeKind: runtimeKind as 'codex' | 'claude', model, mode, thinking, threadId: restored?.threadId,
    instructions: [compiled.material.instructions, config.systemPrompt].filter(Boolean).join('\n\n'),
    mcp, env: { ...config.env }, persist: config.persist,
  };
}
