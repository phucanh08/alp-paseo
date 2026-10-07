import path from 'node:path';
import { jsonObject } from './resolver.js';
import { AlpError } from './errors.js';

const name = value => typeof value === 'string' && value.trim() && !['.', '..'].includes(value) && !/[\\/\x00]/.test(value);

/** The graph is project data, not a registry or provider-specific role enum. */
export async function resolveDelegation(projectRoot) {
  const source = path.join(projectRoot, '.alp', 'settings.json');
  const settings = await jsonObject(source, 'INVALID_SETTINGS');
  const graph = settings.delegation === undefined ? {} : settings.delegation;
  const invalid = message => { throw new AlpError('INVALID_DELEGATION', `${source}: ${message}`); };
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) invalid('delegation must map agent names to target arrays');
  for (const [owner, targets] of Object.entries(graph)) {
    if (!name(owner) || !Array.isArray(targets) || !targets.every(name) || new Set(targets).size !== targets.length) invalid(`invalid targets for '${owner}'`);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(owner) {
    if (visiting.has(owner)) invalid(`delegation cycle at '${owner}'`);
    if (visited.has(owner)) return;
    visiting.add(owner);
    for (const target of Object.hasOwn(graph, owner) ? graph[owner] : []) visit(target);
    visiting.delete(owner); visited.add(owner);
  }
  for (const owner of Object.keys(graph)) visit(owner);
  return graph;
}
