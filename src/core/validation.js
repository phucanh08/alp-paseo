import path from 'node:path';
import { AlpError } from './errors.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const stringMap = value => object(value) && Object.values(value).every(v => typeof v === 'string');
function requireValue(condition, code, source, message) {
  if (!condition) throw new AlpError(code, `${source}: ${message}`);
}

export function validateSettings(settings, source) {
  const check = (ok, message) => requireValue(ok, 'INVALID_SETTINGS', source, message);
  check(object(settings), 'expected an object');
  if (settings.defaultAgent !== undefined) check(nonempty(settings.defaultAgent), 'defaultAgent must be a nonempty string');
  if (settings.workflow !== undefined) {
    check(object(settings.workflow), 'workflow must be an object');
    check(Object.keys(settings.workflow).every(key => ['mode', 'maxPeers'].includes(key)), 'unsupported workflow field');
    if (settings.workflow.mode !== undefined) check(['smart', 'supervised'].includes(settings.workflow.mode), 'workflow.mode must be smart or supervised');
    if (settings.workflow.maxPeers !== undefined) check(Number.isSafeInteger(settings.workflow.maxPeers) && settings.workflow.maxPeers > 0, 'workflow.maxPeers must be a positive integer');
  }
  const runtime = settings.runtime ?? {};
  if (settings.runtime !== undefined) check(object(settings.runtime), 'runtime must be an object');
  for (const key of Object.keys(runtime)) {
    check(['provider', 'model', 'reasoning'].includes(key), `unsupported runtime field '${key}'`);
    check(nonempty(runtime[key]), `runtime.${key} must be a nonempty string`);
  }
  return { ...runtime };
}

export function normalizeMcp(raw, directory, source) {
  const check = (ok, message) => requireValue(ok, 'INVALID_MCP', source, message);
  check(object(raw), 'expected an object');
  check(Object.keys(raw).every(k => k === 'mcpServers'), 'only mcpServers is supported');
  const servers = raw.mcpServers === undefined ? {} : raw.mcpServers;
  check(object(servers), 'mcpServers must be an object');
  const normalized = [];
  for (const [name, server] of Object.entries(servers)) {
    check(nonempty(name) && object(server), `invalid server '${name}'`);
    check(Object.keys(server).every(k => ['command', 'args', 'cwd', 'env', 'url', 'headers'].includes(k)), `${name}: unsupported server field`);
    check(nonempty(server.command) !== nonempty(server.url), `${name}: specify exactly one of command or url`);
    const result = { ...server };
    if (server.command !== undefined) check(nonempty(server.command), `${name}.command must be nonempty`);
    if (server.url !== undefined) {
      check(nonempty(server.url), `${name}.url must be nonempty`);
      let url; try { url = new URL(server.url); } catch { /* validation below */ }
      check(url && ['https:', 'http:'].includes(url.protocol), `${name}.url must be an HTTP(S) URL`);
      check(server.args === undefined && server.cwd === undefined && server.env === undefined, `${name}: args/cwd/env require command`);
    }
    if (server.args !== undefined) check(Array.isArray(server.args) && server.args.every(v => typeof v === 'string'), `${name}.args must be strings`);
    for (const key of ['env', 'headers']) if (server[key] !== undefined) check(stringMap(server[key]), `${name}.${key} must map strings to strings`);
    if (server.command !== undefined) check(server.headers === undefined, `${name}: headers require url`);
    if (server.cwd !== undefined) {
      check(nonempty(server.cwd), `${name}.cwd must be nonempty`);
      result.cwd = path.resolve(directory, server.cwd);
    }
    // Bare executables remain PATH lookups; explicit relative command paths are agent-relative.
    if (server.command && /[\\/]/.test(server.command)) result.command = path.resolve(directory, server.command);
    normalized.push([name, result]);
  }
  return { mcpServers: Object.fromEntries(normalized) };
}

export function validateResolvedAgent(agent) {
  const check = (ok, message) => requireValue(ok, 'INVALID_RESOLVED_AGENT', 'ResolvedAgent', message);
  check(object(agent), 'expected an object');
  check(nonempty(agent.name), 'name is required');
  check(typeof agent.projectRoot === 'string' && path.isAbsolute(agent.projectRoot), 'projectRoot must be absolute');
  check(object(agent.instructions) && typeof agent.instructions.project === 'string' && typeof agent.instructions.agent === 'string', 'instructions must contain project and agent strings');
  for (const key of ['skills', 'hooks']) {
    check(Array.isArray(agent[key]), `${key} must be an array`);
    for (const resource of agent[key]) check(object(resource) && nonempty(resource.name) && typeof resource.path === 'string' && path.isAbsolute(resource.path), `${key} must contain named absolute paths`);
  }
  check(object(agent.runtime), 'runtime must be an object');
  validateSettings({ runtime: agent.runtime }, 'ResolvedAgent.runtime');
  normalizeMcp(agent.mcp, agent.projectRoot, 'ResolvedAgent.mcp');
  check(object(agent.mcp.mcpServers), 'MCP must contain a normalized mcpServers map');
  for (const server of Object.values(agent.mcp.mcpServers)) {
    if (server.cwd !== undefined) check(path.isAbsolute(server.cwd), 'MCP cwd must already be absolute');
    if (server.command && /[\\/]/.test(server.command)) check(path.isAbsolute(server.command), 'MCP command paths must already be absolute');
  }
  return agent;
}
