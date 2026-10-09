import path from 'node:path';
import { AlpError } from '../core/errors.js';
import { getEntry } from '../core/library-edit.js';
import { runHook, samplePayload } from '../core/hook-run.js';
import { normalizeMcp } from '../core/validation.js';
import { probeMcp } from './mcp-probe.js';
import { probeAcp } from './acp-probe.js';
import { loadProvider } from '../core/providers.js';

/**
 * Tries an MCP server, a hook or an ACP provider out (ALPD §43, §46). An MCP server is
 * started and its tools listed; a provider is started and initialized; a hook runs once with a sample payload for its event, in the project (or the
 * library when there is none), with the variables ALP gives hooks.
 */
export async function testEntry(kind, name, { root, library, templates, scope, timeoutMs } = {}) {
  const entry = await getEntry(kind, name, { root, library, templates, scope });
  const home = entry.source === 'project' ? path.join(path.resolve(root), '.alp') : library;
  if (kind === 'mcp') {
    const server = normalizeMcp({ mcpServers: { [name]: entry.content.server } }, path.join(home, 'mcp'), `${name}.json`).mcpServers[name];
    const result = await probeMcp(server, { cwd: root ? path.resolve(root) : library, ...(timeoutMs ? { timeoutMs } : {}) });
    return { kind, name, source: entry.source, ok: true, ...result };
  }
  if (kind === 'hooks') {
    const hook = entry.content.hook;
    const project = root ? path.resolve(root) : undefined;
    const payload = samplePayload(hook.event, { project, agent: hook.match?.agent ?? 'main' });
    const env = { ALP_EVENT: hook.event, ALP_SESSION: payload.session, ALP_AGENT: payload.agent, ALP_PROJECT: project ?? '', ALP_TASK: payload.task ?? '' };
    const result = await runHook(hook, payload, { cwd: project ?? library, env, ...(timeoutMs ? { timeoutMs } : {}) });
    const ok = result.exitCode === 0 && !result.timedOut;
    return { kind, name, source: entry.source, ok, ...(hook.blocking && !ok ? { wouldBlock: true } : {}), payload, ...result };
  }
  if (kind === 'providers') {
    const provider = await loadProvider(library, name);
    const result = await probeAcp(provider, { cwd: root ? path.resolve(root) : library, ...(timeoutMs ? { timeoutMs } : {}) });
    return { kind, name, source: entry.source, ok: true, ...result };
  }
  throw new AlpError('INVALID_KIND', `Only mcp servers, hooks and providers can be tested, not ${kind}`);
}
