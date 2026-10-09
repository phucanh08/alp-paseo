#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { initProject } from './core/init.js';
import { upgradeProject } from './core/upgrade.js';
import { alpHome, connect, ensureDaemon, lockAlive, readLock } from './client/index.js';

const USAGE = `Usage:
  alp <init|upgrade> [directory]
  alp daemon <start|stop|status|restart>
  alp run [--agent A] [--workflow smart|supervised] [--model M] [--mode read-only|workspace-write] [--thinking T] [--project DIR] [--json] <prompt>
  alp ps [--all]
  alp top [session] [--once]
  alp attach <session> [--json]
  alp send <session> [--json] <text>
  alp questions [--json]
  alp answer <question> <text> | alp answer <question> --dismiss [--reason R]
  alp log <session> [--json]
  alp board [--project DIR] [--json]
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
    } else if (event.type === 'question') {
      const { question } = event;
      line(sessionId, `  ? ${question.agent} asks you [${question.id}]: ${question.body}${question.options?.length ? ` (${question.options.join(' | ')})` : ''}`);
      line(sessionId, `    answer here, or with: alp answer ${question.id} <text>`);
    } else if (event.type === 'question.resolved') {
      line(sessionId, `  ↳ ${event.questionId} ${event.outcome}${event.answer !== undefined ? `: ${event.answer}` : ''}`);
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

/** Reads answers to questions for the user from the terminal, one question at a time. */
function answerer(client) {
  const waiting = [];
  let rl;
  const ask = () => {
    if (rl || !waiting.length) return;
    const question = waiting[0];
    rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(`answer ${question.id}> `, text => {
      rl.close();
      rl = undefined;
      waiting.shift();
      // An empty line leaves the question for another client, such as Paseo or alp answer.
      if (text.trim()) client.request('question.answer', { questionId: question.id, text }).catch(error => console.error(`alp: ${error.message}`));
      ask();
    });
  };
  return {
    accept(event) {
      if (event.type === 'question') { waiting.push(event.question); ask(); }
      if (event.type === 'question.resolved') {
        const index = waiting.findIndex(question => question.id === event.questionId);
        if (index === 0 && rl) { rl.close(); rl = undefined; console.error(''); }
        if (index >= 0) waiting.splice(index, 1);
        ask();
      }
    },
    close() { rl?.close(); rl = undefined; },
  };
}

/** Streams a tree until its root is idle; the first Ctrl-C interrupts it, the second detaches. */
function follow(client, rootId, print, { untilIdle, interactive = false }) {
  const answering = interactive ? answerer(client) : undefined;
  const done = new Promise((resolve, reject) => {
    let failed = false;
    let interrupted = false;
    const finish = () => { process.off('SIGINT', onSignal); answering?.close(); resolve(!failed); };
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
      answering?.accept(envelope.event);
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
  // A request can fail before the caller awaits this; closing the client must not crash the CLI then.
  done.catch(() => {});
  return done;
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
    const done = follow(client, sessionId, printer(values.json), { untilIdle: true, interactive: !values.json && process.stdin.isTTY });
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
    const done = follow(client, positionals[0], printer(values.json), { untilIdle: false, interactive: !values.json && process.stdin.isTTY });
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
    if (session.parentId) {
      // An assignment gets the text as mail from the user, in its running turn.
      await client.request('session.message', { sessionId, text });
      if (!values.json) console.error(`Sent to ${session.agent} as mail from the user`);
      return;
    }
    const done = follow(client, sessionId, printer(values.json), { untilIdle: true, interactive: !values.json && process.stdin.isTTY });
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

async function questions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const client = await running();
  const { questions: pending } = await client.request('question.list').finally(() => client.close());
  if (values.json) { console.log(JSON.stringify(pending)); return; }
  if (!pending.length) { console.log('No questions wait for you'); return; }
  for (const question of pending) {
    console.log(`${question.id}  ${question.agent}  ${ago(question.askedAt)} ago  root ${question.rootId}`);
    console.log(`  ${question.body.replace(/\n/g, '\n  ')}`);
    if (question.options?.length) console.log(`  options: ${question.options.join(' | ')}`);
  }
}

async function answer(args) {
  const { values, positionals: [questionId, ...words] } = parseArgs({ args, allowPositionals: true, options: { dismiss: { type: 'boolean' }, reason: { type: 'string' } } });
  const text = words.join(' ').trim();
  if (!questionId || (values.dismiss ? text : !text)) throw new UsageError();
  const client = await running();
  const result = await client.request('question.answer', values.dismiss ? { questionId, dismiss: true, reason: values.reason } : { questionId, text }).finally(() => client.close());
  console.log(`${values.dismiss ? 'Dismissed' : 'Answered'} ${result.questionId}`);
}

const ago = (since) => {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(seconds / 3600)}h${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}m`;
};
const duration = ms => ago(new Date(Date.now() - ms).toISOString());

/** One tree as text: sessions by depth, then questions, unmerged worktrees and leases. */
function renderStatus(status, root) {
  const lines = [`${root?.title ? `"${root.title}"  ` : ''}${status.rootId}  ${status.sessions[0]?.projectRoot ?? ''}`];
  const depth = new Map();
  const assignments = new Map(status.assignments.map(assignment => [assignment.id, assignment]));
  for (const session of status.sessions) {
    depth.set(session.id, session.parentId ? (depth.get(session.parentId) ?? 0) + 1 : 0);
    const assignment = assignments.get(session.id);
    const where = assignment?.worktree ? `  worktree ${assignment.worktree.branch}` : '';
    const mail = session.unreadMail ? `  ✉${session.unreadMail}` : '';
    lines.push(`${'  '.repeat(depth.get(session.id) + 1)}${session.agent.padEnd(9)} ${session.state.padEnd(14)} idle ${duration(session.idleMs).padEnd(7)} ${session.runtime}:${session.model}  ${session.mode}${where}${mail}`);
  }
  for (const question of status.questions) lines.push(`  ? ${question.id} ${question.agent} asks (${ago(question.askedAt)}): ${question.body.split('\n')[0]}`);
  for (const worktree of status.worktrees) lines.push(`  ⎇ unmerged ${worktree.branch} from ${worktree.agent}: ${worktree.files.length} files${worktree.stat ? ` (${worktree.stat.trim()})` : ''}`);
  for (const lease of status.leases) lines.push(`  ⚿ ${lease.agent} holds the write lease on ${lease.checkout}`);
  for (const claim of status.claims ?? []) lines.push(`  ⚑ ${claim.agent} claims ${claim.paths.join(', ')}: ${claim.body.split('\n')[0].slice(0, 100)}`);
  return lines.join('\n');
}

/** A live dashboard of every tree, or of one, refreshed every second. */
async function top(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { once: { type: 'boolean' } } });
  if (positionals.length > 1) throw new UsageError();
  const client = await running();
  const frame = async () => {
    const { sessions } = await client.request('session.list', { rootsOnly: true });
    const roots = positionals.length ? sessions.filter(session => session.id === positionals[0]) : sessions;
    if (positionals.length && !roots.length) throw new Error(`Session ${positionals[0]} is not a live root`);
    const blocks = [];
    for (const root of roots) {
      const { status } = await client.request('session.status', { sessionId: root.id }).catch(() => ({}));
      if (status) blocks.push(renderStatus(status, root));
    }
    return `alp top  ${new Date().toLocaleTimeString()}  ${roots.length} live ${roots.length === 1 ? 'tree' : 'trees'}\n\n${blocks.join('\n\n') || 'No live sessions'}`;
  };
  try {
    if (values.once || !process.stdout.isTTY) { console.log(await frame()); return; }
    let stop = false;
    process.once('SIGINT', () => { stop = true; });
    while (!stop) {
      const text = await frame();
      process.stdout.write(`\x1b[2J\x1b[H${text}\n\n(Ctrl-C to exit)\n`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally {
    client.close();
  }
}

/** The tree's assignment log: delegations, mail, handoffs, worktrees and questions to the user. */
async function log(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length !== 1) throw new UsageError();
  const client = await running();
  const { rootId, entries } = await client.request('session.log', { sessionId: positionals[0] }).finally(() => client.close());
  if (values.json) { for (const entry of entries) console.log(JSON.stringify(entry)); return; }
  if (!entries.length) { console.log(`No assignment log for ${rootId}`); return; }
  const agents = new Map();
  for (const entry of entries) {
    const time = entry.ts.slice(11, 19);
    let text;
    switch (entry.event) {
      case 'assignment.started':
        agents.set(entry.assignmentId, entry.agent);
        text = `${entry.parentAgent} → ${entry.agent} (${entry.mode}${entry.isolation === 'worktree' ? ', worktree' : ''}, ${entry.model}${entry.wait === false ? ', async' : ''}): ${entry.task.split('\n')[0].slice(0, 120)}`;
        break;
      case 'assignment.finished':
        text = `${entry.agent} ${entry.status} after ${duration(entry.durationMs ?? 0)}${entry.handoff ? `, handoff ${entry.handoff.outcome}: ${entry.handoff.summary.split('\n')[0].slice(0, 120)}` : ''}${entry.error ? `: ${entry.error}` : ''}${entry.reconciled ? ' (after a restart)' : ''}`;
        break;
      case 'mail':
        // Board pins are logged once, as board.pin, not per reader.
        if (entry.kind === 'board') continue;
        text = `✉ ${entry.kind} ${entry.from} → ${entry.to === rootId ? 'main' : agents.get(entry.to) ?? entry.to}${entry.body ? `: ${entry.body.split('\n')[0].slice(0, 120)}` : ''}`;
        break;
      case 'board.pin':
        text = `${entry.kind === 'claim' ? '⚑' : entry.kind === 'decision' ? '◆' : '•'} ${entry.agent} pins ${entry.kind} ${entry.pinId}${entry.paths ? ` [${entry.paths.join(', ')}]` : ''}: ${entry.body.split('\n')[0].slice(0, 120)}`;
        break;
      case 'board.unpin':
        text = `⚐ ${entry.pinId} by ${entry.agent} ${entry.reason === 'session_ended' ? 'released when its session ended' : 'taken down'}`;
        break;
      case 'human.question':
        text = `? ${entry.agent} asks the user [${entry.questionId}]: ${entry.body.split('\n')[0].slice(0, 120)}`;
        break;
      case 'human.answer':
        text = `↳ ${entry.questionId} ${entry.outcome}${entry.answer !== undefined ? `: ${entry.answer.split('\n')[0].slice(0, 120)}` : ''}`;
        break;
      default:
        text = `${entry.event}${entry.branch ? ` ${entry.branch}` : ''}${entry.status ? ` ${entry.status}` : ''}`;
    }
    console.log(`${time}  ${text}`);
  }
}

/** The project board every agent on the project shares: live claims, then decisions and findings. */
async function board(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const projectRoot = path.resolve(values.project ?? process.cwd());
  const client = await running();
  const { pins } = await client.request('board.list', { projectRoot }).finally(() => client.close());
  if (values.json) { console.log(JSON.stringify(pins)); return; }
  if (!pins.length) { console.log(`The board for ${projectRoot} is empty`); return; }
  console.log(`Project board  ${projectRoot}`);
  for (const pin of pins) {
    const mark = pin.kind === 'claim' ? '⚑' : pin.kind === 'decision' ? '◆' : '•';
    console.log(`${mark} ${pin.kind.padEnd(8)} ${pin.id}  ${pin.agent}  ${ago(pin.at)} ago${pin.paths ? `  [${pin.paths.join(', ')}]` : ''}`);
    console.log(`  ${pin.body.replace(/\n/g, '\n  ')}`);
  }
}

async function interrupt(args) {
  if (args.length !== 1) throw new UsageError();
  const client = await running();
  await client.request('session.interrupt', { sessionId: args[0] }).finally(() => client.close());
  console.log('Interrupted');
}

const commands = { init: args => project('init', args), upgrade: args => project('upgrade', args), daemon, run, ps, top, attach, send, questions, answer, log, board, interrupt };
const [command, ...args] = process.argv.slice(2);
try {
  if (!Object.hasOwn(commands, command)) throw new UsageError();
  await commands[command](args);
} catch (error) {
  if (error instanceof UsageError || error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') console.error(USAGE);
  else console.error(`alp: ${error.message}`);
  process.exitCode = 1;
}
