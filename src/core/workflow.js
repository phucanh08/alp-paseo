import path from 'node:path';
import { jsonObject } from './resolver.js';
import { resolveTeam, teamOf } from './teams.js';

export { teamOf as profileOf } from './teams.js';

/**
 * The team a session runs in (ALPD §42): the one the caller selects, the one a resumed
 * session ran in, or settings' workflow.mode. Without any, the session is `custom`: its
 * graph is settings' delegation and no supervisor watches it.
 * @returns {Promise<{ mode: string, maxPeers: number, supervisor: boolean, team?: Awaited<ReturnType<typeof resolveTeam>> }>}
 */
export async function resolveWorkflow(root, selected, restored, { library, templates } = {}) {
  const settings = await jsonObject(path.join(root, '.alp/settings.json'), 'INVALID_SETTINGS');
  const chosen = selected === undefined ? undefined : teamOf(selected);
  if (chosen === 'custom') throw new Error('Choose a team, such as pho (Phở) or cafe (Cafe)');
  const mode = chosen ?? teamOf(restored?.mode ?? settings.workflow?.mode ?? 'custom');
  if (restored && mode !== teamOf(restored.mode)) throw new Error('Cannot change team in an existing session');
  const team = mode === 'custom' ? undefined : await resolveTeam(root, mode, { library, templates });
  const maxPeers = restored?.maxPeers ?? settings.workflow?.maxPeers ?? team?.maxPeers ?? 2;
  if (!Number.isSafeInteger(maxPeers) || maxPeers < 1) throw new Error('workflow.maxPeers must be a positive integer');
  // A custom delegation graph has no main to supervise; settings can turn a team's supervisor off.
  const supervisor = !!team?.supervisor && (restored?.supervisor ?? settings.workflow?.supervisor ?? true);
  return { mode, maxPeers, supervisor, ...(team ? { team } : {}) };
}
