import type { PluginServerContext } from './compat.js';
import { createProvider } from './provider.js';
export { createProvider } from './provider.js';
export { mapSession, toSessionSpec, PaseoAdapter } from './mapping.js';
export { ClaudeTransport, claudePermissions, CodexTransport } from '../../../src/runtime/index.js';
export default function contribute(server: PluginServerContext) {
  // Sessions run in the user's alpd, which keeps assignment logs outside the project (~/.alp/runs).
  server.registerProvider(createProvider());
  return () => {};
}
