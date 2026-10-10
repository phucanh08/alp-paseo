import { existsSync } from 'node:fs';
import path from 'node:path';
import { createPaseoGateway, type Handler } from './gateway.js';
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
 */
export function createPaseoBridge({ version, token, serverId, log }: {
  daemon: DaemonServer;
  version: string;
  token: () => string;
  serverId: () => string;
  log?: (message: string) => void;
}) {
  const handlers: Record<string, Handler> = {};
  const features: Record<string, boolean> = {};
  return createPaseoGateway({ token, serverId, version, handlers, features, log });
}
