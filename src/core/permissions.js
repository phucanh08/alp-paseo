import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { AlpError } from './errors.js';

/**
 * Permission profiles: what an agent may do beyond, or never do within, its
 * base mode. Rules use Claude Code's syntax, `Tool` or `Tool(specifier)`, such as
 * `Bash(npm test:*)` (a command prefix), `Bash(git status)` (one exact command),
 * `Edit(src/**)` or `WebFetch(domain:example.com)`.
 *
 * Profiles and the agents they apply to come from `permissions` in the project's
 * .alp/settings.json and the user's $ALP_HOME/settings.json. A profile defined in
 * both takes its base from the project and the rules of both. An agent's entry in
 * the project wins over the user's. Deny wins over ask, and ask over allow: an ask
 * rule makes ALP ask the user every time. With `beyondMode: "ask"`, what the mode
 * refuses and no rule covers is asked too, and the user may allow it always.
 *
 * ALP enforces rules natively where it can: Claude receives them as its own
 * allowed and disallowed tools, which hold in every permission mode. Codex runs
 * commands inside its sandbox without asking, so for Codex an allow rule lets a
 * command leave the sandbox when Codex asks to, and a deny rule refuses that.
 */

export const BASES = ['read-only', 'workspace-write', 'full-access'];
const RANK = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
/** Agents that advise, review or watch: their profiles stay read-only. */
export const ADVISORS = ['oracle', 'reviewer', 'supervisor'];
export const MAX_RULES = 200;
const NAME = /^[\w.-]{1,64}$/;
const RULE = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/s;
/** Tools a rule may name; a misspelt one would silently match nothing. MCP tools are mcp__<server>__<tool>. */
export const TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Skill'];

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (source, message) => { throw new AlpError('INVALID_SETTINGS', `${source}: ${message}`); };

/** Parses one rule; returns { tool, specifier? } or throws. */
export function parseRule(rule, source = 'rule') {
  if (typeof rule !== 'string' || rule.length > 500) fail(source, 'a rule is text of at most 500 characters');
  const match = RULE.exec(rule.trim());
  if (!match) fail(source, `${JSON.stringify(rule)} is not Tool or Tool(specifier)`);
  const [, tool, specifier] = match;
  if (!TOOLS.includes(tool) && !/^mcp__[\w-]+(__[\w-]+)?$/.test(tool)) fail(source, `${JSON.stringify(rule)} names unknown tool ${tool}; use ${TOOLS.join(', ')} or mcp__<server>__<tool>`);
  if (specifier !== undefined && !specifier.trim()) fail(source, `${JSON.stringify(rule)} has an empty specifier`);
  return { tool, ...(specifier !== undefined && specifier.trim() !== '*' ? { specifier: specifier.trim() } : {}) };
}

/** Checks the `permissions` field of a settings file. */
export function validatePermissions(value, source) {
  if (value === undefined) return { profiles: {}, agents: {} };
  if (!object(value)) fail(source, 'permissions must be an object');
  for (const key of Object.keys(value)) if (!['profiles', 'agents'].includes(key)) fail(source, `unsupported permissions field '${key}'`);
  const profiles = {};
  if (value.profiles !== undefined) {
    if (!object(value.profiles)) fail(source, 'permissions.profiles must be an object');
    for (const [name, profile] of Object.entries(value.profiles)) {
      const where = `permissions.profiles.${name}`;
      if (!NAME.test(name)) fail(source, `${where}: a profile name has letters, digits, dots, dashes and underscores`);
      if (!object(profile)) fail(source, `${where} must be an object`);
      for (const key of Object.keys(profile)) if (!['base', 'allow', 'ask', 'deny', 'beyondMode'].includes(key)) fail(source, `${where}: unsupported field '${key}'`);
      if (profile.base !== undefined && !BASES.includes(profile.base)) fail(source, `${where}.base must be ${BASES.join(', ')}`);
      if (profile.beyondMode !== undefined && !['refuse', 'ask'].includes(profile.beyondMode)) fail(source, `${where}.beyondMode must be refuse or ask`);
      const rules = {};
      for (const kind of ['allow', 'ask', 'deny']) {
        const list = profile[kind] ?? [];
        if (!Array.isArray(list) || list.length > MAX_RULES) fail(source, `${where}.${kind} must list at most ${MAX_RULES} rules`);
        for (const rule of list) parseRule(rule, `${source}: ${where}.${kind}`);
        rules[kind] = list.map(rule => rule.trim());
      }
      profiles[name] = { ...(profile.base ? { base: profile.base } : {}), ...(profile.beyondMode ? { beyondMode: profile.beyondMode } : {}), ...rules };
    }
  }
  const agents = {};
  if (value.agents !== undefined) {
    if (!object(value.agents)) fail(source, 'permissions.agents must be an object');
    for (const [agent, profile] of Object.entries(value.agents)) {
      if (typeof profile !== 'string' || !NAME.test(profile)) fail(source, `permissions.agents.${agent} must name a profile`);
      agents[agent] = profile;
    }
  }
  return { profiles, agents };
}

async function settingsPermissions(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { profiles: {}, agents: {} }; throw error; }
  let settings;
  try { settings = JSON.parse(text); } catch (error) { fail(file, `invalid JSON: ${error.message}`); }
  if (!object(settings)) fail(file, 'expected an object');
  return validatePermissions(settings.permissions, file);
}

/**
 * The permission profile of an agent, or null when none applies: then the agent
 * keeps the runtime's defaults. Advisors without a profile get a read-only one.
 * @returns {Promise<{ name: string, base: string, allow: string[], ask: string[], deny: string[], beyondMode: 'refuse' | 'ask' } | null>}
 */
export async function profileFor(projectRoot, home, agent) {
  const project = await settingsPermissions(path.join(projectRoot, '.alp', 'settings.json'));
  const user = home ? await settingsPermissions(path.join(home, 'settings.json')) : { profiles: {}, agents: {} };
  const name = project.agents[agent] ?? user.agents[agent];
  const advisor = ADVISORS.includes(agent);
  if (!name) return advisor ? { name: 'read-only', base: 'read-only', allow: [], ask: [], deny: [], beyondMode: 'refuse' } : null;
  const defined = [project.profiles[name], user.profiles[name]].filter(Boolean);
  if (!defined.length && !BASES.includes(name)) {
    throw new AlpError('INVALID_SETTINGS', `permissions.agents.${agent} names profile '${name}', which no settings file defines`);
  }
  // A bare base name is a profile with no rules.
  const base = defined.find(profile => profile.base)?.base ?? (BASES.includes(name) ? name : advisor ? 'read-only' : 'full-access');
  if (advisor && base !== 'read-only') throw new AlpError('INVALID_SETTINGS', `${agent} is an advisor; its profile '${name}' must have base read-only`);
  return {
    name, base,
    allow: [...new Set(defined.flatMap(profile => profile.allow ?? []))],
    ask: [...new Set(defined.flatMap(profile => profile.ask ?? []))],
    deny: [...new Set(defined.flatMap(profile => profile.deny ?? []))],
    beyondMode: defined.find(profile => profile.beyondMode)?.beyondMode ?? 'refuse',
  };
}

/**
 * Adds an allow rule to a profile, in the settings file that defines it (the
 * project's first), when the user allows something always. Returns the file.
 */
export async function addAllowRule(projectRoot, home, profileName, rule) {
  parseRule(rule);
  for (const file of [path.join(projectRoot, '.alp', 'settings.json'), ...(home ? [path.join(home, 'settings.json')] : [])]) {
    let settings;
    try { settings = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const profile = settings?.permissions?.profiles?.[profileName];
    if (!object(profile)) continue;
    profile.allow = [...new Set([...(profile.allow ?? []), rule])];
    validatePermissions(settings.permissions, file);
    const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`);
    await rename(temporary, file);
    return file;
  }
  throw new AlpError('INVALID_SETTINGS', `No settings file defines profile ${profileName}`);
}

/** The lower of two modes. */
export const capMode = (mode, base) => (RANK[mode] ?? 0) <= (RANK[base] ?? 0) ? mode : base;

// --- commands --------------------------------------------------------------------

/** Removes a shell wrapper such as `/bin/zsh -lc '...'` that Codex puts around a command. */
export function unwrapShell(command) {
  const match = /^(?:\/\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command.trim());
  if (!match) return command.trim();
  return match[1] === "'" ? match[2].replace(/'\\''/g, "'") : match[2].replace(/\\(["\\$`])/g, '$1');
}

/**
 * Splits a command line into its simple commands at `&&`, `||`, `;`, `|` and new
 * lines, outside quotes. Returns null when the line substitutes commands or
 * processes, or its quotes do not close: no rule can vouch for it.
 */
export function simpleCommands(line) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === '\\' && quote === '"') { current += char + (line[++i] ?? ''); continue; }
      if (char === quote) quote = null;
      if (quote === '"' && (char === '`' || (char === '$' && line[i + 1] === '('))) return null;
      current += char;
      continue;
    }
    if (char === '\\') { current += char + (line[++i] ?? ''); continue; }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === '`' || (char === '$' && line[i + 1] === '(') || ((char === '<' || char === '>') && line[i + 1] === '(')) return null;
    const two = line.slice(i, i + 2);
    // 2>&1 and &>file redirect; they do not end a command.
    if (two === '>&' || two === '<&' || two === '&>') { current += two; i++; continue; }
    if (two === '&&' || two === '||') { parts.push(current); current = ''; i++; continue; }
    if (char === ';' || char === '|' || char === '\n' || char === '&') { parts.push(current); current = ''; continue; }
    current += char;
  }
  if (quote) return null;
  parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
}

/** Whether a Bash rule's specifier covers one simple command. */
function covers(specifier, command) {
  if (specifier === undefined) return true;
  const normalized = command.replace(/\s+/g, ' ');
  // `npm test:*` and `npm test *` both cover npm test and anything after it.
  if (specifier.endsWith(':*') || specifier.endsWith(' *')) {
    const prefix = specifier.slice(0, -2).trim().replace(/\s+/g, ' ');
    return normalized === prefix || normalized.startsWith(`${prefix} `);
  }
  if (specifier.endsWith('*')) return normalized.startsWith(specifier.slice(0, -1).replace(/\s+/g, ' '));
  return normalized === specifier.replace(/\s+/g, ' ');
}

/** Whether a simple command writes a file through a redirect (not a descriptor or /dev/null). */
function redirects(command) {
  const unquoted = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');
  for (const match of unquoted.matchAll(/(?:\d*|&)>>?\s*(&?)(\S*)/g)) {
    if (match[1] === '&' && /^\d+$/.test(match[2])) continue;
    if (match[2] === '/dev/null') continue;
    return true;
  }
  return false;
}

const bashRules = rules => rules.map(rule => parseRule(rule)).filter(rule => rule.tool === 'Bash');

/**
 * What a profile says about running a command: 'deny' when a deny rule covers any
 * of its simple commands, 'ask' when an ask rule covers any, 'allow' when allow
 * rules cover every one of them and none writes through a redirect, otherwise
 * undefined (the base mode decides).
 */
export function commandDecision(profile, command) {
  const line = unwrapShell(command);
  const parts = simpleCommands(line);
  const deny = bashRules(profile.deny);
  if (deny.some(rule => rule.specifier === undefined)) return 'deny';
  // A command ALP cannot split may hide anything a deny rule names.
  if (!parts) return deny.length ? 'deny' : (profile.ask ?? []).length ? 'ask' : undefined;
  if (parts.some(part => deny.some(rule => covers(rule.specifier, part)))) return 'deny';
  const ask = bashRules(profile.ask ?? []);
  if (ask.some(rule => rule.specifier === undefined) || parts.some(part => ask.some(rule => covers(rule.specifier, part)))) return 'ask';
  const allow = bashRules(profile.allow);
  if (parts.every(part => !redirects(part) && allow.some(rule => covers(rule.specifier, part)))) return 'allow';
  return undefined;
}
