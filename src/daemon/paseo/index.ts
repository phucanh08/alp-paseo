import { existsSync } from 'node:fs';
import path from 'node:path';
import { createAgents } from './agents.js';
import { createPaseoGateway, type Handler } from './gateway.js';
import { quietHandlers } from './quiet.js';
import type { DaemonServer } from '../server.js';

export { createPaseoGateway, NOT_IMPLEMENTED, PASEO_PROTOCOL_VERSION } from './gateway.js';
export type { PaseoGateway } from './gateway.js';

/** Where the built app sits: beside alpd.js (dist/web-app), unless settings or the environment say. */
export function webAppDir(alpdFile: string, configured?: string) {
  const dir = path.resolve(configured ?? process.env.ALP_WEB_APP ?? path.join(path.dirname(alpdFile), 'web-app'));
  return existsSync(path.join(dir, 'index.html')) ? dir : undefined;
}

/**
 * The daemon side of the ALP web app (ALPD §62): Paseo's protocol over alpd. The handlers and the
 * features they light up grow step by step (D31); everything else answers "in development".
 * ALP's state is read on the first client's hello, not at alpd's start.
 */
export function createPaseoBridge({ daemon, version, token, serverId, log }: {
  daemon: DaemonServer;
  version: string;
  token: () => string;
  serverId: () => string;
  log?: (message: string) => void;
}) {
  const handlers: Record<string, Handler> = {};
  const features: Record<string, boolean> = {};
  const gateway = createPaseoGateway({
    token, serverId, version, handlers, features, log,
    onClient: () => { void agents.start().catch(error => log?.(`agents failed to start: ${error?.message ?? error}`)); return () => {}; },
  });
  const agents = createAgents({ daemon, broadcast: message => gateway.broadcast(message), log });
  Object.assign(handlers, quietHandlers, agents.handlers);
  Object.assign(features, agents.features);
  return Object.assign(gateway, { close: () => agents.close() });
}
