import path from 'node:path';
import { jsonObject } from './resolver.js';

/** The two profiles a session runs in. Phở: main implements or calls peer. Cafe: main supervises lead. */
export const profiles = {
  pho: { label: 'Phở', description: 'Main implements or delegates to peer; a supervisor reviews the process.' },
  cafe: { label: 'Cafe', description: 'Main supervises lead, who implements or delegates to peer; a supervisor reviews the process.' },
};

/** Names of profiles before they were renamed; settings and resumed sessions may still carry them. */
const aliases = { smart: 'pho', supervised: 'cafe' };

/** The profile a name selects, accepting the old names; other values pass through unchanged. */
export const profileOf = mode => aliases[mode] ?? mode;

export const workflowGraphs = {
  pho: { main: ['peer', 'oracle', 'reviewer'] },
  cafe: { main: ['lead', 'oracle', 'reviewer'], lead: ['peer', 'oracle', 'reviewer'] },
};

export async function resolveWorkflow(root, selected, restored) {
  const settings = await jsonObject(path.join(root, '.alp/settings.json'), 'INVALID_SETTINGS');
  const chosen = selected === undefined ? undefined : profileOf(selected);
  const mode = chosen ?? profileOf(restored?.mode ?? settings.workflow?.mode ?? 'custom');
  if (!['pho', 'cafe', 'custom'].includes(mode) || (chosen !== undefined && mode === 'custom')) throw new Error('Profile must be pho (Phở) or cafe (Cafe)');
  if (restored && mode !== profileOf(restored.mode)) throw new Error('Cannot change profile in an existing session');
  const maxPeers = restored?.maxPeers ?? settings.workflow?.maxPeers ?? 2;
  if (!Number.isSafeInteger(maxPeers) || maxPeers < 1) throw new Error('workflow.maxPeers must be a positive integer');
  // A custom delegation graph has no main to supervise.
  const supervisor = mode !== 'custom' && (restored?.supervisor ?? settings.workflow?.supervisor ?? true);
  return { mode, maxPeers, supervisor };
}
