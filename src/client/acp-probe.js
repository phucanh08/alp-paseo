import { stdioSession } from './mcp-probe.js';

/**
 * Starts an ACP provider once and runs initialize (ALPD §46), for `alp provider test`
 * and the settings screen. It reports who the agent says it is and what it supports;
 * a provider that needs a login usually says so here, in authMethods.
 * @returns {Promise<{ protocolVersion: number, agent?: { name?: string, title?: string, version?: string }, loadSession: boolean, mcpHttp: boolean, authMethods: string[] }>}
 */
export async function probeAcp(provider, { cwd, timeoutMs = 20_000 } = {}) {
  const session = stdioSession({ command: provider.command, args: provider.args ?? [], env: provider.env ?? {} }, cwd, timeoutMs);
  try {
    const result = await session.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'alp', title: 'ALP', version: '1' },
    });
    if (result.protocolVersion !== 1) throw new Error(`${provider.label ?? provider.id} speaks ACP version ${result.protocolVersion}; ALP speaks version 1`);
    const info = result.agentInfo;
    return {
      protocolVersion: result.protocolVersion,
      ...(info ? { agent: { ...(info.name ? { name: info.name } : {}), ...(info.title ? { title: info.title } : {}), ...(info.version ? { version: info.version } : {}) } } : {}),
      loadSession: Boolean(result.agentCapabilities?.loadSession),
      mcpHttp: Boolean(result.agentCapabilities?.mcpCapabilities?.http),
      authMethods: (result.authMethods ?? []).map(method => method?.name ?? method?.id).filter(Boolean),
    };
  } finally {
    await session.close();
  }
}
