import path from 'node:path';
import bundledTemplates from 'alp:templates';
import { resolveSession, models as runtimeModels, type SessionSpec, type HostMcpServer } from '../../../src/runtime/index.js';
import { profiles, profileOf } from '../../../src/core/workflow.js';
import type { ProviderSessionConfig, ProviderPersistence } from './compat.js';

export { DEFAULT_MODEL, DEFAULT_CLAUDE_MODEL, models, modes, thinkingOptions, thinkingOptionsFor, InstructionsAdapter as PaseoAdapter } from '../../../src/runtime/index.js';

export const templates = bundledTemplates;

/**
 * Paseo shows the two profiles in place of models: each fixes main's model and
 * effort (src/runtime/catalog.ts), so a session picks Phở or Cafe and nothing else.
 */
export const profileModels = Object.entries(profiles).map(([id, profile]) => ({ id, label: profile.label, description: profile.description, thinkingOptions: [] }));
export const DEFAULT_PROFILE = 'pho';

/** The profile a Paseo model selection names, accepting the profiles' old names. */
export const profileFor = (model: string | null | undefined) => {
  const profile = model ? profileOf(model) : undefined;
  return profile && Object.hasOwn(profiles, profile) ? profile : undefined;
};

/** The model list a session's config shows: profiles for a root, its own model for a child or a custom root. */
export function configModels(session: { parentId?: string; runtime: string; model: string; workflow: { mode: string } }) {
  if (!session.parentId && profileFor(session.workflow.mode)) return { model: session.workflow.mode, models: profileModels };
  const id = `${session.runtime}:${session.model}`;
  const known = runtimeModels.find(model => model.id === id);
  return { model: id, models: [{ id, label: known?.label ?? id, ...(known ? { description: known.description } : {}), thinkingOptions: [] }] };
}

/**
 * Version 2 names a session in alpd, which keeps its native thread and history.
 * Version 1 (plugin 0.2) carried the native thread itself; alpd adopts it on open.
 */
export type AlpdHandle = { alpdSessionId: string; agent: string; cwd: string };

export const handleFor = (session: { id: string; agent: string; projectRoot: string }): ProviderPersistence => ({
  version: 2,
  data: { alpdSessionId: session.id, agent: session.agent, cwd: session.projectRoot },
});

/** The alpd session a version 2 handle names, after checking it belongs to this project. */
export function alpdSessionOf(config: ProviderSessionConfig, persistence?: ProviderPersistence) {
  if (persistence?.version !== 2) return undefined;
  const data = persistence.data as Partial<AlpdHandle> | undefined;
  if (!data || typeof data.alpdSessionId !== 'string' || typeof data.agent !== 'string' || data.cwd !== path.resolve(config.cwd)) throw new Error('Invalid ALP persistence or project mismatch');
  const agent = config.providerOptions?.agent;
  if (agent !== undefined && agent !== data.agent) throw new Error('Cannot resume a thread as a different ALP agent');
  return data.alpdSessionId;
}

/** Validates Paseo's session config and persistence and translates them to a runtime spec. */
export function toSessionSpec(config: ProviderSessionConfig, persistence?: ProviderPersistence): SessionSpec {
  const options = config.providerOptions ?? {};
  for (const key of Object.keys(options)) if (!['agent', 'workflow'].includes(key)) throw new Error(`Unknown ALP provider option '${key}'`);
  if (options.agent !== undefined && (typeof options.agent !== 'string' || !options.agent.trim())) throw new Error('providerOptions.agent must be a nonempty string');
  if (Object.keys(config.settings).some(key => key !== 'workflow')) throw new Error('Unknown ALP session setting');
  if (config.settings.workflow !== undefined && typeof config.settings.workflow !== 'string') throw new Error('workflow must be a string');
  if (config.toolPolicy) throw new Error('Per-tool approval policy is unsupported by this prototype');
  const restored = persistence?.version === 2 ? undefined : persistence?.data as { agent?: string; cwd?: string; threadId?: string; runtime?: string; model?: string; workflow?: { mode: string; maxPeers: number } } | undefined;
  if (persistence?.version === 2) alpdSessionOf(config, persistence);
  else if (persistence && (persistence.version !== 1 || !restored || typeof restored.agent !== 'string' || typeof restored.threadId !== 'string' || restored.cwd !== path.resolve(config.cwd))) throw new Error('Invalid ALP persistence or project mismatch');
  if (options.workflow !== undefined && typeof options.workflow !== 'string') throw new Error('providerOptions.workflow must be a string');
  // The selected model is a profile; model and effort follow from it. Older clients send workflow instead.
  const selected = [profileFor(config.model), options.workflow, config.settings.workflow].filter((value): value is string => value !== undefined).map(value => profileOf(value));
  if (new Set(selected).size > 1) throw new Error('Conflicting profile selections');
  return {
    cwd: config.cwd,
    agent: options.agent as string | undefined,
    workflow: selected[0],
    mode: config.mode ?? undefined,
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
