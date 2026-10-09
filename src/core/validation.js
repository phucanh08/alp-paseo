import path from 'node:path';
import { AlpError } from './errors.js';
import { validatePermissions } from './permissions.js';
import { validateVerify } from './verify.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const stringMap = value => object(value) && Object.values(value).every(v => typeof v === 'string');
function requireValue(condition, code, source, message) {
  if (!condition) throw new AlpError(code, `${source}: ${message}`);
}

/** Top-level keys of a project's .alp/settings.json. */
export const PROJECT_SETTINGS = ['$schema', 'defaultAgent', 'workflow', 'runtime', 'permissions', 'verify', 'delegation'];
/** Top-level keys of the user's $ALP_HOME/settings.json. */
export const USER_SETTINGS = ['$schema', 'permissions', 'limits', 'recovery'];
/**
 * Top-level keys ALP no longer reads, with what to use instead. They warn rather than
 * fail, so settings written for an older ALP keep working.
 */
export const RETIRED_SETTINGS = { project: {}, user: {} };

/** The edit distance of two short keys, for suggestions. */
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const kept = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
      previous = kept;
    }
  }
  return row[b.length];
}

/**
 * Sorts a settings object's top-level keys: unknown ones, with the closest known key
 * when it is near, and retired ones, with what replaced them.
 */
export function settingsKeys(settings, known, retired = {}) {
  const unknown = [];
  const old = [];
  for (const key of Object.keys(object(settings) ? settings : {})) {
    if (known.includes(key)) continue;
    if (Object.hasOwn(retired, key)) { old.push({ key, instead: retired[key] }); continue; }
    const near = known.filter(candidate => !candidate.startsWith('$')).map(candidate => ({ candidate, d: distance(key, candidate) })).sort((a, b) => a.d - b.d)[0];
    unknown.push({ key, ...(near && near.d <= 2 ? { suggestion: near.candidate } : {}) });
  }
  return { unknown, retired: old };
}

const unknownMessage = (unknown, known) => `unknown setting '${unknown.key}'${unknown.suggestion ? `; did you mean '${unknown.suggestion}'?` : `; known settings are ${known.filter(key => !key.startsWith('$')).join(', ')}`}`;

/** Warnings for retired keys of a settings object; unknown keys are errors instead. */
export function settingsWarnings(settings, scope) {
  return settingsKeys(settings, scope === 'user' ? USER_SETTINGS : PROJECT_SETTINGS, RETIRED_SETTINGS[scope]).retired
    .map(({ key, instead }) => `setting '${key}' is no longer read; ${instead}`);
}

export function validateSettings(settings, source) {
  const check = (ok, message) => requireValue(ok, 'INVALID_SETTINGS', source, message);
  check(object(settings), 'expected an object');
  const { unknown } = settingsKeys(settings, PROJECT_SETTINGS, RETIRED_SETTINGS.project);
  check(!unknown.length, unknown.length ? unknownMessage(unknown[0], PROJECT_SETTINGS) : '');
  if (settings.defaultAgent !== undefined) check(nonempty(settings.defaultAgent), 'defaultAgent must be a nonempty string');
  if (settings.workflow !== undefined) {
    check(object(settings.workflow), 'workflow must be an object');
    check(Object.keys(settings.workflow).every(key => ['mode', 'maxPeers', 'supervisor'].includes(key)), 'unsupported workflow field');
    // smart and supervised are the profiles' names before 0.4.
    if (settings.workflow.mode !== undefined) check(['pho', 'cafe', 'smart', 'supervised'].includes(settings.workflow.mode), 'workflow.mode must be pho or cafe');
    if (settings.workflow.maxPeers !== undefined) check(Number.isSafeInteger(settings.workflow.maxPeers) && settings.workflow.maxPeers > 0, 'workflow.maxPeers must be a positive integer');
    if (settings.workflow.supervisor !== undefined) check(typeof settings.workflow.supervisor === 'boolean', 'workflow.supervisor must be true or false');
  }
  validatePermissions(settings.permissions, source);
  validateVerify(settings.verify, source);
  const runtime = settings.runtime ?? {};
  if (settings.runtime !== undefined) check(object(settings.runtime), 'runtime must be an object');
  for (const key of Object.keys(runtime)) {
    check(['provider', 'model', 'reasoning'].includes(key), `unsupported runtime field '${key}'`);
    check(nonempty(runtime[key]), `runtime.${key} must be a nonempty string`);
  }
  return { ...runtime };
}

/** Checks the user's $ALP_HOME/settings.json; returns it. */
export function validateUserSettings(settings, source) {
  const check = (ok, message) => requireValue(ok, 'INVALID_SETTINGS', source, message);
  check(object(settings), 'expected an object');
  const { unknown } = settingsKeys(settings, USER_SETTINGS, RETIRED_SETTINGS.user);
  check(!unknown.length, unknown.length ? unknownMessage(unknown[0], USER_SETTINGS) : '');
  for (const key of ['limits', 'recovery']) {
    if (settings[key] === undefined) continue;
    check(object(settings[key]), `${key} must be an object`);
    const extra = Object.keys(settings[key]).find(field => field !== 'autoResume');
    check(!extra, `unsupported ${key} field '${extra}'; use autoResume`);
    if (settings[key].autoResume !== undefined) check(typeof settings[key].autoResume === 'boolean', `${key}.autoResume must be true or false`);
  }
  validatePermissions(settings.permissions, source);
  return settings;
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
