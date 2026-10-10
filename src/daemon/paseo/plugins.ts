import { createHash } from 'node:crypto';
import type { SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import plugin from 'alp:plugin-client';
import { registerLibraryRpc } from '../../../plugins/paseo/server/library.js';
import { registerTaskRpc } from '../../../plugins/paseo/server/tasks.js';
import type { PluginServerContext } from '../../../plugins/paseo/server/compat.js';
import type { Handler } from './gateway.js';

/**
 * ALP's own panels in the web app (D31 step 7, ALPD §62): the Paseo plugin ALP ships for Paseo's
 * desktop app (plugins/paseo: the Tasks panel and screen, the ALP project panel, the ALP settings
 * screen) runs in the web app too. Its client code is compiled into alpd as Paseo compiles a
 * plugin's client bundle and served at /alp-plugins.js, a same-origin script the app's patch 8
 * runs instead of evaluating code from the catalog, so the page keeps a CSP without
 * 'unsafe-eval'. Its RPCs run here, in alpd, through the plugin's own handlers.
 */

type Inbound<T extends SessionInboundMessage['type']> = Extract<SessionInboundMessage, { type: T }>;
type Outbound = SessionOutboundMessage;
type Contract = { name: string; input: { parseAsync(value: unknown): Promise<unknown> }; output: { parseAsync(value: unknown): Promise<unknown> } };

const digest = createHash('sha256').update(plugin.factory).digest('hex').slice(0, 16);

/** The script the page loads before the app: each plugin's factory by id. */
export const pluginScript = `window.__ALP_PLUGINS__ = Object.assign(window.__ALP_PLUGINS__ || {}, { ${JSON.stringify(plugin.id)}: ${plugin.factory} });\n`;

export function createPlugins({ log = () => {} }: { log?: (message: string) => void } = {}) {
  const methods = new Map<string, { contract: Contract; run: (input: any) => Promise<unknown> }>();
  const server = { handle: (contract: Contract, run: (input: any) => Promise<unknown>) => { methods.set(contract.name, { contract, run }); } } as unknown as PluginServerContext;
  registerTaskRpc(server);
  registerLibraryRpc(server);

  const handlers: Record<string, Handler> = {
    'plugin.catalog.get.request': (message: Inbound<'plugin.catalog.get.request'>) =>
      ({ type: 'plugin.catalog.get.response', payload: { requestId: message.requestId, plugins: [{ id: plugin.id, clientBundle: `alp-preloaded:${plugin.id}:${digest}`, requirements: plugin.requirements }] } }) satisfies Outbound,

    // Settings → the host → Plugins lists it, and its menu opens the ALP settings screen.
    'plugin.list.request': (message: Inbound<'plugin.list.request'>) =>
      ({ type: 'plugin.list.response', payload: { requestId: message.requestId, plugins: [{ id: plugin.id, name: 'ALP', description: 'ALP tasks, project and settings', path: 'alpd', enabled: true, status: 'running' }] } }) satisfies Outbound,

    /** A panel's call: checked against the plugin's contract going in and coming out, as Paseo's daemon checks it. */
    async 'plugin.rpc.invoke.request'(message: Inbound<'plugin.rpc.invoke.request'>) {
      if (message.pluginId !== plugin.id) throw Object.assign(new Error(`No plugin ${message.pluginId}`), { code: 'plugin_not_found' });
      const method = methods.get(message.method);
      if (!method) throw Object.assign(new Error(`No method ${message.method}`), { code: 'method_not_found' });
      try {
        const output = await method.contract.output.parseAsync(await method.run(await method.contract.input.parseAsync(message.input)));
        return { type: 'plugin.rpc.invoke.response', payload: { requestId: message.requestId, output } } satisfies Outbound;
      } catch (error: any) {
        log(`plugin ${message.method} failed: ${error?.message ?? error}`);
        throw Object.assign(new Error(error?.message ?? String(error)), { code: 'handler_error' });
      }
    },
  };

  return { handlers, features: { plugins: true, pluginSettings: true, pluginManagement: true }, script: pluginScript };
}
