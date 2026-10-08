import { homedir } from 'node:os';
import path from 'node:path';
import type { PluginServerContext } from './compat.js';
import { createProvider } from './provider.js';
export { createProvider } from './provider.js';
export { mapSession, toSessionSpec, PaseoAdapter } from './mapping.js';
export { ClaudeTransport, claudePermissions, CodexTransport } from '../../../src/runtime/index.js';
export default function contribute(server: PluginServerContext) {
  // Outside the project: assignment logs must not dirty the user's checkout.
  server.registerProvider(createProvider({ runLogDir: process.env.ALP_RUN_LOG_DIR || path.join(homedir(), '.alp', 'runs') }));
  return () => {};
}
