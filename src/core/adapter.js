import { AlpError } from './errors.js';
import { validateResolvedAgent } from './validation.js';

/** Validate a plugin boundary before handing off the provider-neutral IR. */
export async function compileAgent(adapter, agent) {
  if (!adapter || typeof adapter.id !== 'string' || !adapter.id.trim() || typeof adapter.capabilities !== 'function' || typeof adapter.compile !== 'function') {
    throw new AlpError('INVALID_ADAPTER', 'Adapter requires id, capabilities(), and compile()');
  }
  validateResolvedAgent(agent);
  const capabilities = adapter.capabilities();
  for (const key of ['instructions', 'skills', 'hooks', 'mcp']) {
    if (!['native', 'emulated', 'unsupported'].includes(capabilities?.[key])) throw new AlpError('INVALID_CAPABILITIES', `${adapter.id}: invalid ${key} capability`);
  }
  const required = {
    instructions: Boolean(agent.instructions.project || agent.instructions.agent),
    skills: agent.skills.length > 0,
    hooks: agent.hooks.length > 0,
    mcp: Object.keys(agent.mcp.mcpServers).length > 0,
  };
  for (const [key, present] of Object.entries(required)) {
    if (present && capabilities[key] === 'unsupported') throw new AlpError('UNSUPPORTED_CAPABILITY', `${adapter.id} does not support ${key} required by '${agent.name}'`);
  }
  // Adapters receive their own snapshot; compilation must not mutate the resolved source.
  const compiled = await adapter.compile(structuredClone(agent));
  if (!compiled || compiled.adapterId !== adapter.id || compiled.agentName !== agent.name || compiled.projectRoot !== agent.projectRoot || !Object.hasOwn(compiled, 'material')) {
    throw new AlpError('INVALID_COMPILED_AGENT', `${adapter.id}: invalid compiled agent envelope`);
  }
  return compiled;
}
