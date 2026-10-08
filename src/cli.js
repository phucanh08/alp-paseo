#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { initProject } from './core/init.js';
import { upgradeProject } from './core/upgrade.js';
import { alpHome, connect, ensureDaemon, lockAlive, readLock } from './client/index.js';

const USAGE = `Usage:
  alp <init|upgrade> [directory]
  alp daemon <start|stop|status|restart>
  alp run [--agent A] [--workflow smart|supervised] [--model M] [--mode read-only|workspace-write] [--thinking T] [--project DIR] [--json] <prompt>
  alp ps [--all]
  alp attach <session> [--json]
  alp send <session> [--json] <text>
  alp interrupt <session>`;

const DAEMON_ENTRY = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));

class UsageError extends Error {}

async function project(command, args) {
  if (args.length > 1) throw new UsageError();
  try {
    const result = await (command === 'upgrade' ? upgradeProject : initProject)(args[0] ?? process.cwd());
    console.log(`ALP initialized: ${result.created.length} files created, ${result.preserved.length} existing files preserved.`);
    if ('updated' in result) {
      console.log(`ALP upgraded: ${result.updated.length} files updated.${result.backup ? ` Backup: ${result.backup}` : ''}`);
      if (result.customInstructions.length) console.log(`Custom instructions preserved; reconcile with templates if needed: ${result.customInstructions.join(', ')}`);
      if (result.removed.length) console.log(`Retired skills archived: ${result.removed.join(', ')}`);
      if (result.customSkills.length) console.log(`Customized retired skills preserved for review: ${result.customSkills.join(', ')}`);
    }
  } catch (error) {
    console.error(`ALP initialization failed: ${error.message}`);
    process.exitCode = 1;
  }
}

async function start() {
  try {
    await access(DAEMON_ENTRY);
  } catch {
    throw new Error(`alpd is not built (${DAEMON_ENTRY}); run npm run build`);
  }
  return ensureDaemon({ entry: DAEMON_ENTRY });
}

/** Connects to a running daemon without starting one. */
async function running() {
  const lock = await readLock(alpHome());
  if (!lockAlive(lock) || !lock.ready) throw new Error('alpd is not running; start it with: alp daemon start');
  return connect(lock.socket, { name: 'alp-cli', version: '1' });
}

async function stop() {
  const home = alpHome();
  const lock = await readLock(home);
  if (!lockAlive(lock)) return false;
  const client = await connect(lock.socket, { name: 'alp-cli', version: '1' });
  await client.request('daemon.shutdown').finally(() => client.close());
  for (let i = 0; i < 150 && lockAlive(await readLock(home)); i++) await new Promise(resolve => setTimeout(resolve, 100));
  return true;
}

async function daemon([action, ...rest]) {
  if (rest.length) throw new UsageError();
  if (action === 'start') {
    const socket = await start();
    const lock = await readLock(alpHome());
    console.log(`alpd ${lock.version} running (pid ${lock.pid}) on ${socket}`);
  } else if (action === 'stop') {
    console.log(await stop() ? 'alpd stopped' : 'alpd is not running');
  } else if (action === 'restart') {
    const client = await running().catch(() => undefined);
    const status = client && await client.request('daemon.status').finally(() => client.close());
    if (status?.sessions) throw new Error(`alpd has ${status.sessions} live sessions; interrupt them before restarting`);
    await stop();
    await daemon(['start']);
  } else if (action === 'status') {
    const lock = await readLock(alpHome());
    if (!lockAlive(lock)) {
      console.log('alpd is not running');
      process.exitCode = 3;
      return;
    }
    const client = await connect(lock.socket, { name: 'alp-cli', version: '1' });
    const status = await client.request('daemon.status').finally(() => client.close());
    console.log(`alpd ${status.version} running (pid ${status.pid}) since ${status.startedAt}; ${status.sessions} live sessions; socket ${lock.socket}`);
  } else {
    throw new UsageError();
  }
}

/** Human-readable event stream; one line per finished item, indented by tree depth. */
function printer(json) {
  const depth = new Map();
  const agents = new Map();
  const printed = new Set();
  const latest = new Map();
  const line = (sessionId, text) => console.log(`${'  '.repeat(depth.get(sessionId) ?? 0)}${text}`);
  return envelope => {
    if (json) { console.log(JSON.stringify(envelope)); return; }
    const { sessionId, event } = envelope;
    if (event.type === 'session.opened') {
      const { session } = event;
      depth.set(sessionId, session.parentId ? (depth.get(session.parentId) ?? 0) + 1 : 0);
      agents.set(sessionId, session.agent);
      line(sessionId, `▸ ${session.agent} (${session.runtime}:${session.model}, ${session.mode}) ${sessionId}`);
    } else if (event.type === 'item') {
      const { item } = event;
      latest.set(item.id, { sessionId, item });
      if (item.kind === 'tool_call' && item.status !== 'running' && !printed.has(item.id)) {
        printed.add(item.id);
        const detail = item.detail.type === 'shell' ? item.detail.command : item.name === 'alp_delegate' ? `delegate → ${item.detail.input?.agent}` : item.name;
        line(sessionId, `  ${item.status === 'failed' ? '✗' : '✓'} ${detail}`);
      }
    } else if (event.type === 'mail') {
      line(sessionId, `  ✉ ${event.mail.kind} from ${event.mail.from}`);
    } else if (event.type === 'turn.ended') {
      for (const [id, entry] of latest) {
        if (entry.sessionId !== sessionId || printed.has(id) || entry.item.kind !== 'assistant_message') continue;
        printed.add(id);
        line(sessionId, `  ${agents.get(sessionId) ?? 'agent'}: ${entry.item.text.replace(/\n/g, `\n${'  '.repeat((depth.get(sessionId) ?? 0) + 2)}`)}`);
      }
      if (event.state !== 'completed') line(sessionId, `  turn ${event.state}${event.error ? `: ${event.error.message}` : ''}`);
    } else if (event.type === 'prompt.failed') {
      line(sessionId, `  prompt failed: ${event.error.message}`);
    } else if (event.type === 'session.failed') {
      line(sessionId, `  runtime failed: ${event.error.message}`);
    }
  };
}

/** Streams a tree until its root is idle; the first Ctrl-C interrupts it, the second detaches. */
function follow(client, rootId, print, { untilIdle }) {
  return new Promise((resolve, reject) => {
    let failed = false;
    let interrupted = false;
    const finish = () => { process.off('SIGINT', onSignal); resolve(!failed); };
    const onSignal = () => {
      if (interrupted) { finish(); return; }
      interrupted = true;
      console.error('Interrupting… press Ctrl-C again to detach.');
      client.request('session.interrupt', { sessionId: rootId }).catch(() => {});
    };
    process.on('SIGINT', onSignal);
    client.onClose(error => { process.off('SIGINT', onSignal); reject(error); });
    client.onEvent(envelope => {
      print(envelope);
      const { sessionId, event } = envelope;
      if (sessionId !== rootId) return;
      if (event.type === 'turn.ended') {
        failed = event.state !== 'completed';
        if (!untilIdle) return;
        // The root may still have assignments or mail; it is done only when idle.
        setTimeout(() => {
          client.request('session.get', { sessionId: rootId }).then(({ session }) => { if (!session.busy) finish(); }, finish);
        }, 50);
      } else if (event.type === 'session.closed' || event.type === 'session.failed' || event.type === 'prompt.failed') {
        failed ||= event.type !== 'session.closed';
        finish();
      }
    });
  });
}

async function run(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    agent: { type: 'string' }, workflow: { type: 'string' }, model: { type: 'string' }, mode: { type: 'string' },
    thinking: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' },
  } });
  const text = positionals.join(' ').trim();
  if (!text) throw new UsageError();
  const client = await connect(await start(), { name: 'alp-cli', version: '1' });
  try {
    const spec = { cwd: path.resolve(values.project ?? process.cwd()), persist: true, agent: values.agent, workflow: values.workflow, model: values.model, mode: values.mode, thinking: values.thinking };
    const sessionId = `cli-${randomUUID()}`;
    const done = follow(client, sessionId, printer(values.json), { untilIdle: true });
    await client.request('session.create', { sessionId, spec });
    await client.request('session.prompt', { sessionId, clientMessageId: randomUUID(), content: [{ type: 'text', text }] });
    if (!await done) process.exitCode = 1;
    await client.request('session.release', { sessionId }).catch(() => {});
  } finally {
    client.close();
  }
}

async function ps(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { all: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const client = await running();
  const { sessions } = await client.request('session.list', { includeClosed: values.all }).finally(() => client.close());
  if (!sessions.length) { console.log(values.all ? 'No sessions' : 'No live sessions'); return; }
  const children = new Map();
  for (const session of sessions) {
    const key = session.parentId ?? '';
    children.set(key, [...(children.get(key) ?? []), session]);
  }
  const print = (session, depth) => {
    const status = session.status === 'running' || session.status === 'idle' ? (session.activeTurnId ? 'running' : session.busy ? 'waiting' : 'idle') : session.lastError?.code ?? session.status;
    console.log(`${'  '.repeat(depth)}${session.id}  ${session.agent}  ${session.runtime}:${session.model}  ${session.mode}  ${status}${depth ? '' : `  ${session.projectRoot}${session.title ? `  "${session.title}"` : ''}`}`);
    for (const child of children.get(session.id) ?? []) print(child, depth + 1);
  };
  for (const root of children.get('') ?? []) print(root, 0);
}

async function attach(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length !== 1) throw new UsageError();
  const client = await running();
  try {
    const done = follow(client, positionals[0], printer(values.json), { untilIdle: false });
    const { session } = await client.request('session.attach', { sessionId: positionals[0] });
    if (session.id !== positionals[0]) console.error(`Following root ${session.id}`);
    // A closed session has only history; resume it with alp send.
    if (session.status === 'idle' || session.status === 'running') await done;
    else console.error(`Session is ${session.lastError?.code ?? session.status}; resume it with: alp send ${session.id} <text>`);
  } finally {
    client.close();
  }
}

/** Steers a running root, prompts an idle one, or resumes a closed one; then follows it until idle. */
async function send(args) {
  const { values, positionals: [sessionId, ...words] } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  const text = words.join(' ').trim();
  if (!sessionId || !text) throw new UsageError();
  const client = await connect(await start(), { name: 'alp-cli', version: '1' });
  try {
    const { session } = await client.request('session.get', { sessionId });
    if (session.parentId) throw new Error('Send to the root session; assignments are reached through their requester');
    const done = follow(client, sessionId, printer(values.json), { untilIdle: true });
    const live = session.status === 'idle' || session.status === 'running';
    if (live) await client.request('session.attach', { sessionId, replay: false });
    else await client.request('session.create', { sessionId, spec: { cwd: session.projectRoot } });
    const steer = live && !!session.activeTurnId;
    await client.request('session.prompt', { sessionId, clientMessageId: randomUUID(), delivery: steer ? 'steer' : 'auto', content: [{ type: 'text', text }] });
    if (!values.json) console.error(steer ? 'Steered the running turn' : live ? 'Started a turn' : 'Resumed the session');
    if (!await done) process.exitCode = 1;
    await client.request('session.release', { sessionId }).catch(() => {});
  } finally {
    client.close();
  }
}

async function interrupt(args) {
  if (args.length !== 1) throw new UsageError();
  const client = await running();
  await client.request('session.interrupt', { sessionId: args[0] }).finally(() => client.close());
  console.log('Interrupted');
}

const commands = { init: args => project('init', args), upgrade: args => project('upgrade', args), daemon, run, ps, attach, send, interrupt };
const [command, ...args] = process.argv.slice(2);
try {
  if (!Object.hasOwn(commands, command)) throw new UsageError();
  await commands[command](args);
} catch (error) {
  if (error instanceof UsageError || error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') console.error(USAGE);
  else console.error(`alp: ${error.message}`);
  process.exitCode = 1;
}
