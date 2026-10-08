import type { PluginServerContext } from './compat.js';
import { createProvider } from './provider.js';
export { createProvider } from './provider.js';
export { mapSession, PaseoAdapter } from './mapping.js';
export { ClaudeTransport, claudePermissions } from './claude-transport.js';
export { CodexTransport } from './transport.js';
export default function contribute(server: PluginServerContext) {
  server.registerProvider(createProvider());
  return () => {};
}
