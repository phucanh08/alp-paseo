import path from 'node:path';
import { jsonObject } from './resolver.js';

export const workflowGraphs = {
  smart: { main: ['peer', 'oracle', 'reviewer'] },
  supervised: { main: ['lead', 'oracle', 'reviewer'], lead: ['peer', 'oracle', 'reviewer'] },
};

export async function resolveWorkflow(root, selected, restored) {
  const settings = await jsonObject(path.join(root, '.alp/settings.json'), 'INVALID_SETTINGS');
  const mode = selected ?? restored?.mode ?? settings.workflow?.mode ?? 'custom';
  if (!['smart', 'supervised', 'custom'].includes(mode) || (selected !== undefined && mode === 'custom')) throw new Error('Workflow must be smart or supervised');
  if (restored && mode !== restored.mode) throw new Error('Cannot change workflow in an existing session');
  const maxPeers = restored?.maxPeers ?? settings.workflow?.maxPeers ?? 2;
  if (!Number.isSafeInteger(maxPeers) || maxPeers < 1) throw new Error('workflow.maxPeers must be a positive integer');
  return { mode, maxPeers };
}
