// alpd's building blocks, for embedding and tests; src/daemon/main.ts is the daemon itself.
export { createDaemonServer, ERROR } from './server.js';
export type { DaemonConnection, DaemonServer, SessionSummary } from './server.js';
export { createStore } from './store.js';
export type { SessionRecord, SessionStatus, Store } from './store.js';
