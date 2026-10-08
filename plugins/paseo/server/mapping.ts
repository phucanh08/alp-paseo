import path from 'node:path';
import bundledTemplates from 'alp:templates';
import { resolveSession, type SessionSpec, type HostMcpServer } from '../../../src/runtime/index.js';
import type { ProviderSessionConfig, ProviderPersistence } from './compat.js';

export { DEFAULT_MODEL, DEFAULT_CLAUDE_MODEL, models, modes, thinkingOptions, thinkingOptionsFor, InstructionsAdapter as PaseoAdapter } from '../../../src/runtime/index.js';

export const templates = bundledTemplates;

/** Validates Paseo's session config and persistence and translates them to a runtime spec. */
export function toSessionSpec(config: ProviderSessionConfig, persistence?: ProviderPersistence): SessionSpec {
  const options = config.providerOptions ?? {};
  for (const key of Object.keys(options)) if (!['agent', 'workflow'].includes(key)) throw new Error(`Unknown ALP provider option '${key}'`);
  if (options.agent !== undefined && (typeof options.agent !== 'string' || !options.agent.trim())) throw new Error('providerOptions.agent must be a nonempty string');
  if (Object.keys(config.settings).some(key => key !== 'workflow')) throw new Error('Unknown ALP session setting');
  if (config.settings.workflow !== undefined && typeof config.settings.workflow !== 'string') throw new Error('workflow must be a string');
  if (config.toolPolicy) throw new Error('Per-tool approval policy is unsupported by this prototype');
  const restored = persistence?.data as { agent?: string; cwd?: string; threadId?: string; runtime?: string; model?: string; workflow?: { mode: string; maxPeers: number } } | undefined;
  if (persistence && (persistence.version !== 1 || !restored || typeof restored.agent !== 'string' || typeof restored.threadId !== 'string' || restored.cwd !== path.resolve(config.cwd))) throw new Error('Invalid ALP persistence or project mismatch');
  if (options.workflow !== undefined && typeof options.workflow !== 'string') throw new Error('providerOptions.workflow must be a string');
  if (options.workflow !== undefined && config.settings.workflow !== undefined && options.workflow !== config.settings.workflow) throw new Error('Conflicting workflow selections');
  return {
    cwd: config.cwd,
    agent: options.agent as string | undefined,
    workflow: (options.workflow ?? config.settings.workflow) as string | undefined,
    model: config.model ?? undefined,
    mode: config.mode ?? undefined,
    thinking: config.thinkingOption ?? undefined,
    systemPrompt: config.systemPrompt ?? undefined,
    env: { ...config.env },
    mcpServers: config.mcpServers as Record<string, HostMcpServer>,
    persist: config.persist,
    ...(restored ? { restore: { agent: restored.agent!, threadId: restored.threadId!, runtime: restored.runtime, model: restored.model, workflow: restored.workflow } } : {}),
  };
}

export async function mapSession(config: ProviderSessionConfig, persistence?: ProviderPersistence) {
  return resolveSession(toSessionSpec(config, persistence), { templates });
}
