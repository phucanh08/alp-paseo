#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { initProject } from './core/init.js';
import { upgradeProject } from './core/upgrade.js';
import { seedLibrary } from './core/library.js';
import { exportBeads, importBeads, parseJsonl } from './core/beads.js';
import { findFormula, formulaDirs, listFormulas, pourFormula } from './core/formulas.js';
import { commandDecision, profileFor } from './core/permissions.js';
import { describeVerification, runVerify, verifyConfig } from './core/verify.js';
import { diagnose, repair } from './client/doctor.js';
import { ago, duration, renderLog, renderPs } from './client/render.js';
import { installedProgram, installService, serviceFor, startService, uninstallService } from './client/service.js';
import { discoverAgents } from './core/resolver.js';
import { parse as toml } from 'smol-toml';
import { addGate, blockersOf, checkGates, childrenOf, closeTask, compactTasks, createTask, describeGate, gateOpen, epicReport, gatesOf, getTask, isTaskId, linkTask, recordVerification, listTasks, loadTasks, readyTasks, reopenTask, resolveGate, summarize, TASKS_DIR, updateTask } from './core/tasks.js';
import { alpHome, connect, ensureDaemon, lockAlive, readLock } from './client/index.js';

const USAGE = `Usage:
  alp <init|upgrade> [directory]
  alp daemon <start|stop|status|restart>
  alp daemon <install|uninstall>         run alpd as a login service that restarts after a crash
  alp doctor [--project DIR] [--fix] [--json]   check this machine and project; --fix repairs what is safe to
  alp run [--agent A] [--profile pho|cafe] [--model M] [--mode read-only|workspace-write|full-access] [--thinking T] [--project DIR] [--json] <prompt>
  alp ps [--all]
  alp top [session] [--once]
  alp attach <session> [--json]
  alp send <session> [--json] <text>
  alp questions [--json]
  alp answer <question> <text> | alp answer <question> --dismiss [--reason R]
  alp log <session> [--json]
  alp board [--project DIR] [--json]
  alp permissions [--project DIR] [--json]   each agent's permission profile
  alp permissions check <agent> "<command>"  what that agent's profile says about a command
  alp tasks [ready] [--all] [--status S] [--label L] [--project DIR] [--json]
  alp tasks gates [--json]                 open gates; checks GitHub ones
  alp tasks compact [--days 30] [--dry-run]
  alp tasks export [-o file.jsonl]          as beads JSONL
  alp tasks import [file.jsonl] [--dry-run]  beads JSONL; default .beads/issues.jsonl
  alp formula list | show <name> | pour <name> [--var k=v]... [--parent ID] [--dry-run]
  alp task add <title> [-d text] [-p 0-4] [-t task|bug|feature|chore|epic] [--parent ID] [--after ID]... [-l label]... [--path P]... [--from ID]
  alp task show <id> [--json]
  alp task report <epic> [--json]           what an epic came to: tasks, time, rework, verification
  alp task edit <id> [--title T] [-d text] [-p N] [-t type] [-l label]... [--path P]... [-m note]
  alp task close <id> [--reason done|wontfix|duplicate|superseded] [-m summary] [--unverified "why"]
  alp verify [--project DIR] [--task ID] [--json]   run the project's verify commands; --task records the result
  alp task reopen <id> [-m note]
  alp task dep <add|rm> <id> [--after ID]... [--parent ID] [--related ID]...
  alp task gate add <id> --human "question" | --timer +2h|ISO | --pr N|owner/repo#N | --run N|owner/repo#N
  alp task gate <clear|rm> <id> <gate> [-m note]
  alp pause [codex|claude] [--now] [-m reason] | alp pause status   hold delegation; --now parks running assignments
  alp resume [codex|claude]                  lift a pause; parked assignments continue
  alp recall <assignment|task> [--project DIR] [--json] <question>   ask a finished assignment about its work
  alp interrupt <session>`;

const DAEMON_ENTRY = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));

class UsageError extends Error {}

async function project(command, args) {
  if (args.length > 1) throw new UsageError();
  try {
    const result = await (command === 'upgrade' ? upgradeProject : initProject)(args[0] ?? process.cwd());
    console.log(`ALP initialized: ${result.created.length} files created, ${result.preserved.length} existing files preserved.`);
    const library = await seedLibrary(alpHome());
    if (library.created.length || library.updated.length) console.log(`Skill library ${alpHome()}: ${library.created.length} files added, ${library.updated.length} unchanged files updated.`);
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

async function built() {
  try {
    await access(DAEMON_ENTRY);
  } catch {
    throw new Error(`alpd is not built (${DAEMON_ENTRY}); run npm run build`);
  }
}

/** Waits until an alpd for this home is ready; returns its socket. */
async function ready(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = await readLock(alpHome());
    if (lockAlive(lock) && lock.ready) return lock.socket;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`alpd did not become ready within ${timeoutMs / 1000} s; see ${path.join(alpHome(), 'logs')}`);
}

/** The installed service for this ALP_HOME, if any. */
async function installed() {
  const service = serviceFor({ home: alpHome() });
  return service && await installedProgram(service) ? service : undefined;
}

/** Starts alpd: through its service when installed, so the service keeps it running; else detached. */
async function start() {
  await built();
  const service = await installed();
  const lock = await readLock(alpHome());
  if (!service || lockAlive(lock)) return ensureDaemon({ entry: DAEMON_ENTRY });
  await startService(service);
  return ready();
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
    console.log(await stop() ? `alpd stopped${await installed() ? '; its service starts it again at login, or with alp daemon start' : ''}` : 'alpd is not running');
  } else if (action === 'restart') {
    const client = await running().catch(() => undefined);
    const status = client && await client.request('daemon.status').finally(() => client.close());
    await stop();
    await daemon(['start']);
    // Running work is kept on stop and continued at start (ALPD §31).
    if (status?.sessions) console.log(`${status.sessions} live sessions were open; alpd reopens what was still working`);
  } else if (action === 'install') {
    await built();
    const service = serviceFor({ home: alpHome() });
    if (!service) throw new Error(`alp daemon install supports macOS (launchd) and Linux (systemd), not ${process.platform}`);
    // The service's alpd takes over; running work continues in it (ALPD §31).
    const replaced = await stop();
    await installService(service, { home: alpHome(), entry: DAEMON_ENTRY });
    await ready();
    const lock = await readLock(alpHome());
    console.log(`alpd installed as ${service.kind === 'launchd' ? 'a LaunchAgent' : 'a systemd user service'} (${service.name}, ${service.file})`);
    console.log(`alpd ${lock.version} running (pid ${lock.pid}); it starts at login and again after a crash${replaced ? '; the alpd that ran before handed its work over' : ''}`);
  } else if (action === 'uninstall') {
    const service = serviceFor({ home: alpHome() });
    if (!service || !await uninstallService(service)) {
      console.log('alpd is not installed as a service');
      return;
    }
    // Unloading stops alpd cleanly; wait for it to let go of its lock.
    for (let i = 0; i < 150 && lockAlive(await readLock(alpHome())); i++) await new Promise(resolve => setTimeout(resolve, 100));
    console.log(`alpd service ${service.name} removed and alpd stopped; alp daemon start runs it without a service`);
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
    if (status.previousExit?.kind === 'crash') console.log(`the alpd before it stopped unexpectedly${status.previousExit.at ? ` around ${status.previousExit.at}` : ''}`);
    const service = await installed();
    if (service) console.log(`managed by ${service.kind} as ${service.name}`);
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
      if (item.kind === 'notice') line(sessionId, `  ${item.level === 'error' ? '‼' : item.level === 'warning' ? '!' : 'ℹ'} ${item.text}`);
      if (item.kind === 'todo') {
        line(sessionId, '  tasks:');
        for (const entry of item.items) line(sessionId, `    ${entry.status === 'completed' ? '☑' : entry.status === 'in_progress' ? '◐' : '☐'} ${entry.text}`);
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
    let rootEnded = false;
    client.onEvent(envelope => {
      print(envelope);
      answering?.accept(envelope.event);
      const { sessionId, event } = envelope;
      if (event.type === 'turn.ended') {
        if (sessionId === rootId) {
          failed = event.state !== 'completed';
          rootEnded = true;
        }
        if (!untilIdle || !rootEnded) return;
        // The root may still have assignments, mail, or a supervisor review; it is done
        // only when idle, so any turn that ends in the tree checks again.
        setTimeout(() => {
          client.request('session.get', { sessionId: rootId }).then(({ session }) => { if (!session.busy) finish(); }, finish);
        }, 50);
        return;
      }
      if (sessionId !== rootId) return;
      if (event.type === 'turn.started') {
        rootEnded = false;
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
    agent: { type: 'string' }, profile: { type: 'string' }, workflow: { type: 'string' }, model: { type: 'string' }, mode: { type: 'string' },
    thinking: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' },
  } });
  const text = positionals.join(' ').trim();
  if (!text) throw new UsageError();
  // --workflow is the option's name before profiles.
  if (values.profile && values.workflow && values.profile !== values.workflow) throw new UsageError();
  const client = await connect(await start(), { name: 'alp-cli', version: '1' });
  try {
    const spec = { cwd: path.resolve(values.project ?? process.cwd()), persist: true, agent: values.agent, workflow: values.profile ?? values.workflow, model: values.model, mode: values.mode, thinking: values.thinking };
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
  const [{ sessions }, pauses] = await Promise.all([client.request('session.list', { includeClosed: values.all }), client.request('daemon.pauses')]).finally(() => client.close());
  printPauses(pauses, false);
  if (!sessions.length) { console.log(values.all ? 'No sessions' : 'No live sessions'); return; }
  for (const line of renderPs(sessions)) console.log(line);
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
  for (const claim of status.claims ?? []) lines.push(`  ⚑ ${claim.agent} claims ${claim.paths.join(', ')}${claim.task ? ` for ${claim.task}` : ''}: ${claim.body.split('\n')[0].slice(0, 100)}`);
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
  for (const line of renderLog(rootId, entries)) console.log(line);
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

const STATUS_MARK = { open: '○', in_progress: '◐', review: '◑', closed: '●' };

/** The ALP project a task command works on: --project, or the current directory. */
/** alp permissions: the profile each agent runs with, from .alp/settings.json and $ALP_HOME/settings.json. */
async function permissionsCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean' } } });
  const root = await taskProject(values.project);
  if (positionals[0] === 'check') {
    if (positionals.length !== 3) throw new UsageError();
    const profile = await profileFor(root, alpHome(), positionals[1]);
    const decision = profile ? commandDecision(profile, positionals[2]) : undefined;
    const result = { agent: positionals[1], profile: profile?.name ?? null, base: profile?.base ?? null, decision: decision ?? 'mode' };
    if (values.json) { console.log(JSON.stringify(result)); return; }
    console.log(decision === 'deny' ? `deny: a deny rule of profile ${profile.name} covers it`
      : decision === 'ask' ? `ask: profile ${profile.name} asks the user each time`
      : decision === 'allow' ? `allow: profile ${profile.name} lets ${result.agent} run it, even beyond its ${profile.base} mode`
      : `no rule covers it: ${result.agent}'s mode decides${profile ? ` (at most ${profile.base})` : ''}`);
    return;
  }
  if (positionals.length) throw new UsageError();
  const rows = [];
  for (const agent of await discoverAgents(root)) rows.push({ agent, profile: await profileFor(root, alpHome(), agent) });
  if (values.json) { console.log(JSON.stringify(rows)); return; }
  for (const { agent, profile } of rows) {
    console.log(profile ? `${agent}  profile ${profile.name}, at most ${profile.base}${profile.beyondMode === 'ask' ? '; asks the user beyond it' : ''}` : `${agent}  no profile: the mode its requester or the user chooses`);
    if (profile?.allow.length) console.log(`  allow: ${profile.allow.join(', ')}`);
    if (profile?.ask.length) console.log(`  ask:   ${profile.ask.join(', ')}`);
    if (profile?.deny.length) console.log(`  deny:  ${profile.deny.join(', ')}`);
  }
}

async function taskProject(directory) {
  const root = path.resolve(directory ?? process.cwd());
  try { await access(path.join(root, '.alp')); }
  catch { throw new Error(`${root} is not an ALP project (no .alp directory); run alp init, or pass --project`); }
  return root;
}

function taskRow(task, tasks) {
  const row = summarize(task, tasks);
  const extra = [
    row.blockedBy ? `blocked by ${row.blockedBy.join(', ')}` : '',
    row.gates ? `waits on ${row.gates.join('; ')}` : '',
    row.assignee ? `@${row.assignee}` : '',
    row.labels ? row.labels.map(label => `#${label}`).join(' ') : '',
  ].filter(Boolean).join('  ');
  return `${STATUS_MARK[task.status]} ${task.id.padEnd(10)} P${task.priority} ${task.type.padEnd(7)} ${task.status.padEnd(11)} ${task.title}${extra ? `  ${extra}` : ''}`;
}

function warnUnreadable(errors) {
  for (const { file, error } of errors) console.error(`alp: skipped ${file}: ${error}`);
}

/** The project's tasks: open, in progress and in review by default; ready lists what nothing blocks. */
async function tasksCommand(args) {
  if (args[0] === 'gates' || args[0] === 'compact') return taskMaintenance([args[0]], args.slice(1));
  if (args[0] === 'export' || args[0] === 'import') return beads(args[0], args.slice(1));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    all: { type: 'boolean' }, status: { type: 'string' }, label: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' },
  } });
  if (positionals.length > 1 || (positionals.length && positionals[0] !== 'ready')) throw new UsageError();
  const root = await taskProject(values.project);
  const { tasks, errors } = await loadTasks(root);
  warnUnreadable(errors);
  const rows = positionals[0] === 'ready' ? readyTasks(tasks) : listTasks(tasks, { status: values.status, label: values.label, all: values.all });
  if (values.json) { console.log(JSON.stringify(rows)); return; }
  if (!rows.length) { console.log(positionals[0] === 'ready' ? 'No task is ready' : `No tasks in ${path.join(root, TASKS_DIR)}`); return; }
  for (const task of rows) console.log(taskRow(task, tasks));
}

/** The GitHub CLI, for gh:pr and gh:run gates. */
const gh = (args, { cwd }) => new Promise((resolve, reject) => {
  const child = spawn(process.env.ALP_GH_BIN ?? 'gh', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => reject(error.code === 'ENOENT' ? new Error('gh is not installed or not on PATH') : error));
  child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `gh exited with ${code}`)));
});

/** alp tasks gates: clears GitHub gates that are done and lists the open ones. alp tasks compact: shrinks old closed tasks. */
async function taskMaintenance([command], args) {
  const { values, positionals: rest } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, json: { type: 'boolean' }, days: { type: 'string' }, 'dry-run': { type: 'boolean' },
  } });
  if (rest.length) throw new UsageError();
  const root = await taskProject(values.project);
  if (command === 'compact') {
    const days = values.days === undefined ? 30 : Number(values.days);
    const changed = await compactTasks(root, { days, dryRun: values['dry-run'] }, 'user');
    if (values.json) { console.log(JSON.stringify(changed)); return; }
    if (!changed.length) { console.log(`No task closed more than ${days} days ago is left to compact`); return; }
    for (const { id, before, after } of changed) console.log(`${id}  ${before} → ${after} characters`);
    console.log(`${values['dry-run'] ? 'Would compact' : 'Compacted'} ${changed.length} closed ${changed.length === 1 ? 'task' : 'tasks'}`);
    return;
  }
  const checked = await checkGates(root, gh);
  const { tasks } = await loadTasks(root);
  const open = tasks.filter(task => task.status !== 'closed').flatMap(task => task.gates.filter(gate => gateOpen(gate)).map(gate => ({ task, gate })));
  if (values.json) { console.log(JSON.stringify({ ...checked, open: open.map(({ task, gate }) => ({ task: task.id, ...gate })) })); return; }
  for (const { task, gate, detail } of checked.cleared) console.log(`✓ ${task} ${gate} cleared: ${detail}`);
  for (const { task, gate, error } of checked.errors) console.error(`alp: could not check ${task} ${gate}: ${error}`);
  if (!open.length) { console.log('No open gates'); return; }
  for (const { task, gate } of open) {
    const state = checked.pending.find(entry => entry.task === task.id && entry.gate === gate.id)?.detail;
    console.log(`⏸ ${task.id} ${describeGate(gate)}${state ? ` (${state})` : ''}  ${task.title}`);
  }
}

/** alp tasks export / import: interchange with beads through its JSONL issue format. */
async function beads(command, args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, output: { type: 'string', short: 'o' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
  } });
  const root = await taskProject(values.project);
  if (command === 'export') {
    if (positionals.length || values['dry-run']) throw new UsageError();
    const { tasks, errors } = await loadTasks(root);
    warnUnreadable(errors);
    const text = exportBeads(tasks).map(record => JSON.stringify(record)).join('\n') + (tasks.length ? '\n' : '');
    if (values.output) {
      await writeFile(values.output, text);
      console.error(`Exported ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} to ${values.output}`);
    } else {
      process.stdout.write(text);
    }
    return;
  }
  if (positionals.length > 1 || values.output) throw new UsageError();
  const file = positionals[0] ?? path.join(root, '.beads', 'issues.jsonl');
  const { records, errors } = parseJsonl(await readFile(file, 'utf8'));
  const report = await importBeads(root, records, { dryRun: values['dry-run'], by: 'user' });
  report.skipped.push(...errors);
  if (values.json) { console.log(JSON.stringify(report)); return; }
  const verb = values['dry-run'] ? 'Would import' : 'Imported';
  for (const { id, from } of report.created) console.log(`+ ${id}${id !== from ? ` (from ${from})` : ''}`);
  for (const { id, from } of report.updated) console.log(`~ ${id}${id !== from ? ` (from ${from})` : ''}`);
  for (const { line, reason } of report.skipped.sort((a, b) => a.line - b.line)) console.error(`alp: skipped line ${line}: ${reason}`);
  for (const warning of report.warnings) console.error(`alp: ${warning}`);
  console.log(`${verb} ${file}: ${report.created.length} created, ${report.updated.length} updated, ${report.skipped.length} skipped`);
}

/** alp formula: workflow templates that pour into an epic with a task per step. */
async function formulaCommand([action, ...args]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, var: { type: 'string', multiple: true }, parent: { type: 'string' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
  } });
  const root = await taskProject(values.project);
  const home = alpHome();
  if (action === 'list') {
    if (positionals.length) throw new UsageError();
    const found = await listFormulas(root, home, { toml });
    if (values.json) { console.log(JSON.stringify(found)); return; }
    if (!found.length) { console.log(`No formulas in ${formulaDirs(root, home).join(', ')}`); return; }
    for (const entry of found) console.log(entry.error ? `✗ ${entry.name}  ${entry.file}: ${entry.error}` : `${entry.name}  ${entry.formula.steps.length} steps${entry.formula.description ? `  ${entry.formula.description.split('\n')[0]}` : ''}`);
    return;
  }
  if (positionals.length !== 1) throw new UsageError();
  const { formula, file } = await findFormula(root, home, positionals[0], { toml });
  if (action === 'show') {
    if (values.json) { console.log(JSON.stringify(formula)); return; }
    console.log(`${formula.formula}${formula.version ? ` v${formula.version}` : ''}  ${file}`);
    if (formula.description) console.log(`  ${formula.description}`);
    for (const [name, spec] of Object.entries(formula.vars)) console.log(`  --var ${name}=…${spec.required ? ' (required)' : spec.default !== undefined ? ` (default ${spec.default})` : ''}${spec.description ? `  ${spec.description}` : ''}`);
    for (const step of formula.steps) console.log(`  ${step.id}${step.type === 'human' ? ' [you]' : step.type !== 'task' ? ` [${step.type}]` : ''}: ${step.title}${step.needs.length ? `  after ${step.needs.join(', ')}` : ''}`);
    return;
  }
  if (action !== 'pour') throw new UsageError();
  const given = {};
  for (const entry of values.var ?? []) {
    const at = entry.indexOf('=');
    if (at < 1) throw new UsageError();
    given[entry.slice(0, at)] = entry.slice(at + 1);
  }
  const { epic, tasks } = await pourFormula(root, formula, given, 'user', { dryRun: values['dry-run'], ...(values.parent ? { parent: values.parent } : {}) });
  if (values.json) { console.log(JSON.stringify({ epic, tasks })); return; }
  console.log(`${values['dry-run'] ? 'Would pour' : 'Poured'} ${formula.formula} as ${epic.id}  ${epic.title}`);
  const all = [epic, ...tasks];
  for (const task of tasks) console.log(`  ${taskRow(task, all)}`);
}

const repeated = { type: 'string', multiple: true };

async function taskCommand([action, ...args]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    description: { type: 'string', short: 'd' }, priority: { type: 'string', short: 'p' }, type: { type: 'string', short: 't' },
    label: { ...repeated, short: 'l' }, path: repeated, parent: { type: 'string' }, after: repeated, related: repeated, from: { type: 'string' },
    title: { type: 'string' }, message: { type: 'string', short: 'm' }, reason: { type: 'string' }, unverified: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' },
    human: { type: 'string' }, timer: { type: 'string' }, pr: { type: 'string' }, run: { type: 'string' },
  } });
  const root = await taskProject(values.project);
  const fields = {
    ...(values.description !== undefined ? { description: values.description } : {}),
    ...(values.priority !== undefined ? { priority: values.priority } : {}),
    ...(values.type !== undefined ? { type: values.type } : {}),
    ...(values.label ? { labels: values.label } : {}),
    ...(values.path ? { paths: values.path } : {}),
  };
  let task;
  if (action === 'add') {
    const title = positionals.join(' ').trim();
    if (!title) throw new UsageError();
    task = await createTask(root, { title, ...fields, parent: values.parent, blockedBy: values.after, related: values.related, discoveredFrom: values.from }, 'user');
  } else if (action === 'show') {
    if (positionals.length !== 1) throw new UsageError();
    const { tasks, errors } = await loadTasks(root);
    warnUnreadable(errors);
    task = tasks.find(candidate => candidate.id === positionals[0]);
    if (!task) throw new Error(`No task ${positionals[0]} in ${path.join(root, TASKS_DIR)}`);
    if (values.json) { console.log(JSON.stringify(task)); return; }
    printTask(task, tasks);
    return;
  } else if (action === 'report') {
    if (positionals.length !== 1) throw new UsageError();
    const { tasks, errors } = await loadTasks(root);
    warnUnreadable(errors);
    const report = epicReport(positionals[0], tasks);
    console.log(values.json ? JSON.stringify(report) : report.text);
    return;
  } else if (action === 'edit') {
    if (positionals.length !== 1) throw new UsageError();
    task = await updateTask(root, positionals[0], { ...fields, ...(values.title !== undefined ? { title: values.title } : {}), note: values.message }, 'user');
  } else if (action === 'close') {
    if (positionals.length !== 1) throw new UsageError();
    task = await closeTask(root, positionals[0], { reason: values.reason, summary: values.message, unverified: values.unverified }, 'user');
  } else if (action === 'reopen') {
    if (positionals.length !== 1) throw new UsageError();
    task = await reopenTask(root, positionals[0], { note: values.message }, 'user');
  } else if (action === 'dep') {
    const [change, id, ...rest] = positionals;
    if (!['add', 'rm'].includes(change) || !id || rest.length || !(values.after || values.parent || values.related)) throw new UsageError();
    const links = { ...(values.after ? { blockedBy: values.after } : {}), ...(values.parent ? { parent: values.parent } : {}), ...(values.related ? { related: values.related } : {}) };
    task = await linkTask(root, id, change === 'add' ? { add: links } : { remove: links }, 'user');
  } else if (action === 'gate') {
    const [change, id, gate, ...rest] = positionals;
    const kinds = ['human', 'timer', 'pr', 'run'].filter(kind => values[kind] !== undefined);
    if (change === 'add' && id && !gate && kinds.length === 1) {
      const kind = kinds[0];
      task = await addGate(root, id, kind === 'human' ? { kind, note: values.human } : kind === 'timer' ? { kind, until: values.timer } : { kind: `gh:${kind}`, ref: values[kind] }, 'user');
    } else if ((change === 'clear' || change === 'rm') && id && gate && !rest.length && !kinds.length) {
      task = await resolveGate(root, id, gate, { by: 'user', note: values.message, remove: change === 'rm' });
    } else {
      throw new UsageError();
    }
  } else {
    throw new UsageError();
  }
  if (values.json) { console.log(JSON.stringify(task)); return; }
  const { tasks } = await loadTasks(root);
  console.log(`${{ add: 'Created', close: 'Closed', reopen: 'Reopened' }[action] ?? 'Updated'} ${path.join(TASKS_DIR, `${task.id}.json`)}`);
  if (action === 'gate') for (const gate of task.gates.filter(entry => gateOpen(entry))) console.log(`  ⏸ ${describeGate(gate)}`);
  console.log(taskRow(task, tasks));
  if (action === 'close' && tasks.some(entry => entry.parent === task.id)) console.log(`\n${epicReport(task.id, tasks).text}`);
}

function printTask(task, tasks) {
  console.log(`${STATUS_MARK[task.status]} ${task.id}  ${task.title}`);
  console.log(`  ${task.type}, P${task.priority}, ${task.status}${task.assignee ? ` with ${task.assignee.agent}` : ''}; created by ${task.createdBy} ${ago(task.createdAt)} ago, rev ${task.rev}`);
  if (task.description) console.log(`\n  ${task.description.replace(/\n/g, '\n  ')}\n`);
  const blockers = task.status === 'closed' ? [] : blockersOf(task, tasks);
  const relations = [
    task.parent && `parent ${task.parent}`,
    task.blockedBy.length && `after ${task.blockedBy.join(', ')}${blockers.length ? ` (open: ${blockers.join(', ')})` : ''}`,
    task.discoveredFrom && `found during ${task.discoveredFrom}`,
    task.related.length && `related ${task.related.join(', ')}`,
  ].filter(Boolean);
  if (relations.length) console.log(`  ${relations.join('; ')}`);
  for (const gate of task.gates) console.log(`  ${gateOpen(gate) ? '⏸' : '✓'} gate ${describeGate(gate)}${gate.resolved ? ` (cleared by ${gate.resolved.by}${gate.resolved.note ? `: ${gate.resolved.note}` : ''})` : ''}`);
  const inherited = gatesOf(task, tasks).filter(label => label.startsWith('t-'));
  if (task.status !== 'closed' && inherited.length) console.log(`  waits on its parent's gates: ${inherited.join('; ')}`);
  if (task.compacted) console.log(`  compacted ${task.compacted.at.slice(0, 10)} from ${task.compacted.chars} characters`);
  if (task.labels.length) console.log(`  labels: ${task.labels.join(', ')}`);
  if (task.paths.length) console.log(`  paths: ${task.paths.join(', ')}`);
  for (const child of childrenOf(task.id, tasks)) console.log(`  ${taskRow(child, tasks)}`);
  if (task.verified) console.log(`  ${task.verified.skipped ? '–' : task.verified.passed ? '✓' : '✗'} ${describeVerification(task.verified)}${task.verified.where ? ` in the ${task.verified.where}` : ''}, ${ago(task.verified.at)} ago`);
  if (task.closed) console.log(`  closed ${task.closed.reason} by ${task.closed.by}${task.closed.summary ? `: ${task.closed.summary}` : ''}${task.closed.unverified ? ` (unverified: ${task.closed.unverified})` : ''}`);
  for (const entry of task.log.slice(-10)) {
    const { at, by, event, ...detail } = entry;
    const text = Object.entries(detail).map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(', ') : value}`).join('; ');
    console.log(`  ${at.slice(0, 16).replace('T', ' ')}  ${by} ${event}${text ? `: ${text}` : ''}`);
  }
}

/** Pauses and parked assignments, one line each; `always` also says when nothing is paused. */
function printPauses({ all, runtimes, parked }, always = true) {
  const line = (name, pause) => console.log(`⏸ ${name} paused since ${pause.since.slice(0, 16).replace('T', ' ')} by ${pause.by}: ${pause.reason}${pause.resetsAt ? `; the limit resets ${pause.resetsAt}` : ''}`);
  if (all) line('ALP', all);
  for (const [kind, pause] of Object.entries(runtimes)) line(kind, pause);
  for (const entry of parked) console.log(`  parked ${entry.agent} ${entry.assignmentId} (${entry.runtime}): ${entry.reason}`);
  if (always && !all && !Object.keys(runtimes).length) console.log('Nothing is paused');
}

/** alp pause: hold delegation and wakes on one runtime, or all; --now also parks running assignments. */
async function pause(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { now: { type: 'boolean' }, message: { type: 'string', short: 'm' }, json: { type: 'boolean' } } });
  if (positionals.length > 1 || (positionals[0] && !['codex', 'claude', 'status'].includes(positionals[0]))) throw new UsageError();
  const client = await running();
  const state = await (positionals[0] === 'status'
    ? client.request('daemon.pauses')
    : client.request('daemon.pause', { ...(positionals[0] ? { runtime: positionals[0] } : {}), now: !!values.now, ...(values.message ? { reason: values.message } : {}) })).finally(() => client.close());
  if (values.json) console.log(JSON.stringify(state));
  else printPauses(state);
}

/** alp resume: lift a pause; parked assignments continue where they stopped. */
async function resume(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length > 1 || (positionals[0] && !['codex', 'claude'].includes(positionals[0]))) throw new UsageError();
  const client = await running();
  const state = await client.request('daemon.resume', positionals[0] ? { runtime: positionals[0] } : {}).finally(() => client.close());
  if (values.json) console.log(JSON.stringify(state));
  else printPauses(state);
}

/** alp verify: run the project's verify commands here, in the project root. */
async function verify(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, task: { type: 'string' }, json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const root = await taskProject(values.project);
  const config = await verifyConfig(root);
  if (!config) throw new Error(`${root} has no verify commands; add "verify": { "test": "npm test" } to .alp/settings.json`);
  if (values.task) await getTask(root, values.task);
  const verification = await runVerify(root, config);
  if (values.task) await recordVerification(root, values.task, { ...verification, where: 'checkout' }, 'user');
  if (values.json) console.log(JSON.stringify(verification));
  else {
    for (const command of verification.commands) {
      console.log(`${command.exitCode === 0 ? '✓' : '✗'} ${command.step}: ${command.command}  (${(command.ms / 1000).toFixed(1)} s${command.timedOut ? ', timed out' : command.exitCode ? `, exit ${command.exitCode}` : ''})`);
      if (command.exitCode !== 0 && command.output) console.log(`  ${command.output.trimEnd().split('\n').slice(-30).join('\n  ')}`);
    }
    console.log(`${describeVerification(verification)}${values.task ? `; recorded on ${values.task}` : ''}`);
  }
  if (!verification.passed) process.exitCode = 1;
}

const DOCTOR_MARK = { ok: '✓', info: '·', warn: '!', fail: '✗' };

/** alp doctor: what ALP needs here and what earlier runs left behind (ALPD §36). */
async function doctor(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, fix: { type: 'boolean' }, json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const project = values.project ? await taskProject(values.project) : await taskProject(undefined).catch(() => undefined);
  const sandbox = await import('../dist/runtime/index.js').then(runtime => runtime.claudeSandboxAvailable(), () => undefined);
  const options = { home: alpHome(), project, sandbox, daemonEntry: DAEMON_ENTRY };
  let checks = await diagnose(options);
  const fixed = values.fix ? await repair(checks) : [];
  if (fixed.length) checks = await diagnose(options);
  if (values.json) {
    console.log(JSON.stringify({ project: project ?? null, checks: checks.map(({ fix, ...check }) => ({ ...check, ...(fix ? { fix: fix.describe } : {}) })), fixed }));
  } else {
    for (const { id, result } of fixed) console.log(`fixed ${id}: ${result}`);
    if (fixed.length) console.log('');
    for (const check of checks) {
      console.log(`${DOCTOR_MARK[check.status]} ${check.id.padEnd(13)} ${check.summary}`);
      for (const detail of check.details ?? []) console.log(`    ${detail}`);
      if (check.fix) console.log(`    --fix: ${check.fix.describe}`);
      if (check.hint) console.log(`    ${check.hint}`);
    }
    const failed = checks.filter(check => check.status === 'fail').length;
    const warned = checks.filter(check => check.status === 'warn').length;
    const fixable = checks.filter(check => check.fix).length;
    console.log(`\n${failed || warned ? `${failed} failed, ${warned} to look at` : 'All good'}${project ? '' : ' (no ALP project here; pass --project to check one)'}${fixable ? `; alp doctor --fix repairs ${fixable}` : ''}`);
  }
  if (checks.some(check => check.status === 'fail')) process.exitCode = 1;
}

/** alp recall: ask a finished assignment, or the last one on a task, what it did and why. */
async function recall(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean' } } });
  const [target, ...words] = positionals;
  const question = words.join(' ').trim();
  if (!target || !question) throw new UsageError();
  const byTask = isTaskId(target);
  const client = await running();
  const answer = await client.request('assignment.recall', {
    ...(byTask ? { taskId: target, projectRoot: await taskProject(values.project) } : { assignmentId: target }),
    question,
  }).finally(() => client.close());
  if (values.json) { console.log(JSON.stringify(answer)); return; }
  console.log(`${answer.agent} (assignment ${answer.assignmentId}${answer.taskId ? `, task ${answer.taskId}` : ''}, finished ${ago(answer.finishedAt)} ago):`);
  console.log(answer.answer);
}

async function interrupt(args) {
  if (args.length !== 1) throw new UsageError();
  const client = await running();
  await client.request('session.interrupt', { sessionId: args[0] }).finally(() => client.close());
  console.log('Interrupted');
}

const commands = { init: args => project('init', args), upgrade: args => project('upgrade', args), daemon, doctor, run, ps, top, attach, send, questions, answer, log, board, tasks: tasksCommand, task: taskCommand, formula: formulaCommand, permissions: permissionsCommand, verify, recall, pause, resume, interrupt };
const [command, ...args] = process.argv.slice(2);
try {
  if (!Object.hasOwn(commands, command)) throw new UsageError();
  await commands[command](args);
} catch (error) {
  if (error instanceof UsageError || error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') console.error(USAGE);
  else console.error(`alp: ${error.message}`);
  process.exitCode = 1;
}
