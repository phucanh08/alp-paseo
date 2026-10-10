// alpd's building blocks, for embedding and tests; src/daemon/main.ts is the daemon itself.
export { createDaemonServer, ERROR } from './server.js';
export type { DaemonConnection, DaemonServer, SessionSummary } from './server.js';
export { createStore } from './store.js';
export { createWebServer, DEFAULT_WEB_PORT, webFile } from './web.js';
export type { WebApp, WebAssets, WebInfo } from './web.js';
export { createPaseoBridge, NOT_IMPLEMENTED, PASEO_PROTOCOL_VERSION, webAppDir } from './paseo/index.js';
export type { SessionRecord, SessionStatus, Store } from './store.js';
