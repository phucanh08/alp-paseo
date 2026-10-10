import type { PluginServerContext } from './compat.js';
import { createProvider, daemonEntry } from './provider.js';
import { registerTaskRpc } from './tasks.js';
import { registerLibraryRpc } from './library.js';
import { alpHome } from '../../../src/client/index.js';
import { superviseDaemon } from '../../../src/client/supervise.js';
export { createProvider } from './provider.js';
export { sessionTasks } from './session-tasks.js';
export { mapSession, toSessionSpec, PaseoAdapter } from './mapping.js';
export { ClaudeTransport, claudePermissions, CodexTransport } from '../../../src/runtime/index.js';
export default function contribute(server: PluginServerContext) {
  // Sessions run in the user's alpd, which keeps assignment logs outside the project (~/.alp/runs).
  server.registerProvider(createProvider());
  // The Tasks panel (index.client.tsx) reads and changes the project's tasks through these.
  registerTaskRpc(server);
  // The ALP settings screen edits agents, skills, MCP servers, hooks and teams through these.
  registerLibraryRpc(server);
  // While Paseo runs, alpd runs: started now, and again whenever it goes down, unless the user stopped it (ALPD §40).
  const stop = process.env.ALP_SUPERVISE === '0'
    ? async () => {}
    : superviseDaemon({ home: alpHome(), entry: () => daemonEntry(), log: message => console.error(`alp: ${message}`) });
  return () => stop();
}
