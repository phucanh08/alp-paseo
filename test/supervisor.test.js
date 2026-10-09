import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { createAlpRuntime, claudeToolShapes } from '../dist/runtime/index.js';

async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

let calls = 0;
function fakeTransport(runtimes) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      kind, calls: [], threadId: `thread-${index}`, turnId: undefined,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      get started() { return this.calls.filter(call => call.method === 'turn/start'); },
      get config() { return this.calls.find(call => call.method === 'thread/start').params; },
      async call(tool, args, callId = `${tool}-${index}-${++calls}`) {
        return JSON.parse((await this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId, namespace: null, tool, arguments: args })).contentItems[0].text);
      },
      shell(command, exitCode = 0) {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'commandExecution', id: `cmd-${++calls}`, command, status: 'completed', exitCode, aggregatedOutput: '' } });
      },
      finish(text = 'done') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `output-${index}-${turns}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function setup(t, settings, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-supervisor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  const library = path.join(directory, 'home');
  await initProject(root);
  if (settings) await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify(settings));
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), libraryDir: library, runLogDir: path.join(directory, 'runs'), ...options });
  t.after(() => runtime.shutdown());
  const prompt = (id, text, session = 'root') => runtime.prompt(session, { clientMessageId: id, delivery: 'auto', content: [{ type: 'text', text }] });
  return { root, library, runtime, runtimes, prompt };
}

test('main starts a supervisor on Sonnet 4.6 that reviews each turn and asks main between turns', async t => {
  const { root, library, runtime, runtimes, prompt } = await setup(t);
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2 && runtimes[1].calls.some(call => call.method === 'thread/start'));
  const [main, supervisor] = runtimes;
  assert.deepEqual([main.kind, main.config.model, main.config.thinking, main.config.sandbox], ['claude', 'claude-opus-5-5', 'high', 'full-access']);
  assert.ok(main.config.dynamicTools.some(tool => tool.name === 'alp_lesson'));
  assert.match(main.config.developerInstructions, /A supervisor reviews your process after each turn/);
  assert.deepEqual([supervisor.kind, supervisor.config.model, supervisor.config.thinking, supervisor.config.sandbox], ['claude', 'claude-sonnet-4-6', 'medium', 'read-only']);
  assert.deepEqual(supervisor.config.dynamicTools.map(tool => tool.name), ['alp_send', 'alp_board']);
  assert.match(supervisor.config.developerInstructions, /Supervisor — process reviewer for main/);
  assert.ok(supervisor.config.developerInstructions.includes(`Lessons main has recorded: ${path.join(root, '.alp/lessons.md')} and ${path.join(library, 'lessons.md')}`));
  for (const tool of [...main.config.dynamicTools, ...supervisor.config.dynamicTools]) {
    assert.deepEqual(Object.keys(claudeToolShapes[tool.name] ?? {}).sort(), Object.keys(tool.inputSchema.properties).sort(), `${tool.name} differs for Claude`);
  }
  assert.ok(['alp_lesson', 'alp_skill', 'alp_issue'].every(name => main.config.dynamicTools.some(tool => tool.name === name)));
  const status = runtime.status('root');
  assert.deepEqual(status.sessions.map(session => session.agent), ['main', 'supervisor']);
  assert.equal(runtime.snapshot('root').busy, false);

  await prompt('m1', 'Fix the login bug');
  main.shell('npm test', 1);
  assert.equal((await main.call('alp_pin', { kind: 'decision', body: 'Keep the session cookie' })).kind, 'decision');
  main.finish('Fixed it, tests pass');
  // Busy from the end of main's turn, so an idle-tree reap cannot close it before the review starts.
  assert.equal(runtime.snapshot('root').busy, true);
  await until(() => supervisor.started.length === 1);
  const digest = supervisor.started[0].params.input.at(-1).text;
  assert.match(digest, /user asked main: Fix the login bug/);
  assert.match(digest, /main shell completed \(exit 1\): npm test/);
  assert.match(digest, /main pinned decision: Keep the session cookie/);
  assert.match(digest, /main final message: Fixed it, tests pass/);
  // The tree stays busy while its supervisor reviews.
  assert.equal(runtime.snapshot('root').busy, true);

  assert.match((await supervisor.call('alp_pin', { kind: 'finding', body: 'x' })).error, /only uses alp_send and alp_board/);
  assert.equal((await supervisor.call('alp_send', { to: 'parent', kind: 'note', body: 'Tests failed with exit 1 but you said they pass. Why, and what will you do from now on?' })).sent.startsWith('#'), true);
  supervisor.finish('Asked about the claimed test result');
  await until(() => main.started.length === 2);
  assert.match(main.started[1].params.input.at(-1).text, /note from supervisor[\s\S]*exit 1 but you said they pass/);

  assert.equal((await main.call('alp_lesson', { scope: 'project', lesson: 'Report the test result the command actually printed.' })).recorded, true);
  assert.equal((await main.call('alp_lesson', { scope: 'user', lesson: 'Never claim checks that did not pass.' })).recorded, true);
  assert.match((await main.call('alp_lesson', { scope: 'team', lesson: 'x' })).error, /scope/);
  main.finish('I misread the output; recorded the lesson');
  await settle();
  // Answering the supervisor is not reviewed again.
  assert.equal(supervisor.started.length, 1);
  assert.equal(runtime.snapshot('root').busy, false);
  assert.match(await readFile(path.join(root, '.alp/lessons.md'), 'utf8'), /# ALP lessons[\s\S]*- \d{4}-\d\d-\d\d: Report the test result the command actually printed\./);
  assert.match(await readFile(path.join(library, 'lessons.md'), 'utf8'), /Never claim checks that did not pass\./);

  // A later session follows the lessons, and so does its supervisor.
  await runtime.open('next', { cwd: root });
  await until(() => runtimes.length === 4 && runtimes[3].calls.some(call => call.method === 'thread/start'));
  for (const later of [runtimes[2], runtimes[3]]) {
    assert.match(later.config.developerInstructions, /For every project:\n# ALP lessons[\s\S]*Never claim checks[\s\S]*For this project:[\s\S]*Report the test result/);
  }
  await runtime.close('root');
  assert.equal(supervisor.closed, true);
});

test('a supervisor note waits for main\'s running turn, and a turn that ends during a review is reviewed next', async t => {
  const { root, runtime, runtimes, prompt } = await setup(t);
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  const [main, supervisor] = runtimes;
  await prompt('m1', 'First task');
  main.finish('First done');
  await until(() => supervisor.started.length === 1);
  await prompt('m2', 'Second task');
  await supervisor.call('alp_send', { to: 'parent', kind: 'note', body: 'Why no reviewer on the first task?' });
  await settle();
  assert.equal(main.calls.some(call => call.method === 'turn/steer'), false);
  // Main's own wait for assignments does not take the note either.
  assert.deepEqual((await main.call('alp_wait', { timeoutMs: 20 })).events, []);
  main.finish('Second done');
  await until(() => main.started.length === 3);
  assert.match(main.started[2].params.input.at(-1).text, /Why no reviewer on the first task\?/);
  // The second turn's digest waited for the first review to end.
  assert.equal(supervisor.started.length, 1);
  supervisor.finish('sound');
  await until(() => supervisor.started.length === 2);
  assert.match(supervisor.started[1].params.input.at(-1).text, /user asked main: Second task[\s\S]*Second done/);
  assert.doesNotMatch(supervisor.started[1].params.input.at(-1).text, /First task/);
});

test('a project from before the supervisor gets only its files, not agents the user deleted', async t => {
  const { root, runtime, runtimes } = await setup(t);
  await rm(path.join(root, '.alp/agents/supervisor'), { recursive: true });
  await rm(path.join(root, '.alp/agents/lead'), { recursive: true });
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2 && runtimes[1].calls.some(call => call.method === 'thread/start'));
  assert.match(await readFile(path.join(root, '.alp/agents/supervisor/AGENT.md'), 'utf8'), /Supervisor — process reviewer/);
  await assert.rejects(readFile(path.join(root, '.alp/agents/lead/AGENT.md'), 'utf8'), { code: 'ENOENT' });
});

test('no supervisor when settings turn it off or the project uses a custom graph', async t => {
  for (const settings of [{ workflow: { mode: 'cafe', supervisor: false } }, { delegation: { main: ['peer'] } }]) {
    const { root, runtime, runtimes, prompt } = await setup(t, settings);
    await runtime.open('root', { cwd: root });
    await settle();
    assert.equal(runtimes.length, 1);
    assert.equal(runtimes[0].config.dynamicTools.some(tool => tool.name === 'alp_lesson'), false);
    await prompt('m1', 'Task');
    assert.match((await runtimes[0].call('alp_lesson', { scope: 'project', lesson: 'x' })).error, /Only a supervised main/);
    await runtime.shutdown();
  }
});

/** Starts the call, waits for its approval question, and answers it. */
async function answered(runtime, pending, reply) {
  await until(() => runtime.questions().length === 1);
  const [question] = runtime.questions();
  if (reply === null) runtime.answer(question.id, { dismiss: true, reason: 'Not now' });
  else runtime.answer(question.id, { text: reply });
  return { question, result: await pending };
}

test('main distills lessons into a skill scoped to the roles it picks, saved only after the user approves', async t => {
  const { root, library, runtime, runtimes, prompt } = await setup(t);
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  const main = runtimes[0];
  assert.ok(main.config.dynamicTools.some(tool => tool.name === 'alp_skill'));
  await prompt('m1', 'Work');
  const lessons = ['Run the command before reporting its result.', 'Quote the exit code in the handoff.', 'Keep briefs short.'];
  for (const lesson of lessons) await main.call('alp_lesson', { scope: lesson.startsWith('Keep') ? 'user' : 'project', lesson });
  const skill = { name: 'verify-claims', description: 'Use before reporting any check: run it and quote what it printed.', body: '# Verify claims\n\n1. Run the check.\n2. Quote its output.', roles: ['main', 'peer', 'oracle'], lessons: lessons.slice(0, 2) };
  assert.match((await main.call('alp_skill', { ...skill, roles: ['main', 'tester'] })).error, /Unknown roles: tester/);

  const rejected = await answered(runtime, main.call('alp_skill', skill), 'Make it shorter');
  assert.deepEqual(rejected.question.options, ['Approve', 'Reject']);
  assert.match(rejected.question.body, /Roles that get it: main, peer, oracle\.[\s\S]*- Run the command before reporting its result\.[\s\S]*name: verify-claims\ndescription: "Use before reporting/);
  assert.deepEqual([rejected.result.approved, rejected.result.feedback], [false, 'Make it shorter']);
  await assert.rejects(readFile(path.join(library, 'skills/verify-claims/SKILL.md'), 'utf8'), { code: 'ENOENT' });
  assert.equal((await answered(runtime, main.call('alp_skill', skill), null)).result.approved, false);

  const { result } = await answered(runtime, main.call('alp_skill', skill), 'Approve');
  assert.equal(result.approved, true);
  assert.deepEqual(result.lessonsRemoved.sort(), lessons.slice(0, 2).sort());
  assert.match(await readFile(path.join(library, 'skills/verify-claims/SKILL.md'), 'utf8'), /^---\nname: verify-claims\n[\s\S]*1\. Run the check\./);
  const roles = JSON.parse(await readFile(path.join(library, 'role-skills.json'), 'utf8'));
  for (const role of ['main', 'peer', 'oracle']) assert.ok(roles[role].includes('verify-claims'), role);
  assert.equal(roles.lead.includes('verify-claims'), false);
  assert.ok(roles.main.includes('xia'), 'the shipped assignments stay');
  assert.doesNotMatch(await readFile(path.join(root, '.alp/lessons.md'), 'utf8'), /Run the command|exit code/);
  assert.match(await readFile(path.join(library, 'lessons.md'), 'utf8'), /Keep briefs short/);
  assert.match((await main.call('alp_skill', skill)).error, /already has a skill named verify-claims/);
  main.finish();

  // Later sessions of those roles list it.
  await runtime.open('next', { cwd: root });
  await until(() => runtimes.length === 4);
  assert.ok(runtimes[2].config.developerInstructions.includes(JSON.stringify(path.join(library, 'skills/verify-claims/SKILL.md'))));
});

test('main searches, then opens or comments on GitHub issues only with the user\'s approval', async t => {
  const calls = [];
  const github = async (args, { input }) => {
    calls.push({ args, input });
    return args[1] === 'list' ? JSON.stringify([{ number: 7, title: 'Login fails', state: 'OPEN', url: 'https://github.com/acme/widgets/issues/7' }]) : `https://github.com/${args[args.indexOf('-R') + 1]}/issues/${args[1] === 'create' ? 8 : 7}\n`;
  };
  const { root, runtime, runtimes, prompt } = await setup(t, undefined, { github });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: root });
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  const main = runtimes[0];
  assert.ok(main.config.dynamicTools.some(tool => tool.name === 'alp_issue'));
  await prompt('m1', 'Work');

  const found = await main.call('alp_issue', { action: 'search', target: 'project', query: 'login' });
  assert.equal(found.repo, 'acme/widgets');
  assert.equal(found.issues[0].number, 7);
  assert.deepEqual(calls[0].args.slice(0, 4), ['issue', 'list', '-R', 'acme/widgets']);

  const draft = { action: 'create', target: 'alp', title: 'Supervisor misses lead routing', body: 'Steps: ...' };
  const declined = await answered(runtime, main.call('alp_issue', draft), 'Reject');
  assert.match(declined.question.body, /open an issue in phucanh08\/alp-paseo \(ALP itself\)[\s\S]*Title: Supervisor misses lead routing\n\nSteps: \.\.\./);
  assert.equal(declined.result.approved, false);
  assert.equal(calls.length, 1);
  const created = (await answered(runtime, main.call('alp_issue', draft), 'Approve')).result;
  assert.deepEqual([created.posted, created.url], [true, 'https://github.com/phucanh08/alp-paseo/issues/8']);
  assert.deepEqual(calls[1].args, ['issue', 'create', '-R', 'phucanh08/alp-paseo', '--title', 'Supervisor misses lead routing', '--body-file', '-']);
  assert.match(calls[1].input, /^Steps: \.\.\.\n\n---\n_Drafted by an ALP agent and posted with the user's approval\._$/);
  const commented = (await answered(runtime, main.call('alp_issue', { action: 'comment', target: 'project', issue: 7, body: 'Also fails on Safari.' }), 'đồng ý')).result;
  assert.equal(commented.url, 'https://github.com/acme/widgets/issues/7');
  assert.deepEqual(calls[2].args, ['issue', 'comment', '7', '-R', 'acme/widgets', '--body-file', '-']);

  // Assignments report problems to their requester instead.
  const delegated = await main.call('alp_delegate', { agent: 'peer', task: 'Look', wait: false });
  await until(() => runtimes.length === 3 && runtimes[2].started.length === 1);
  assert.match((await runtimes[2].call('alp_issue', { action: 'search', target: 'alp', query: 'x' })).error, /Only main files issues/);
  assert.equal(delegated.status, 'running');
  execFileSync('git', ['remote', 'set-url', 'origin', 'https://gitlab.com/acme/widgets.git'], { cwd: root });
  assert.match((await main.call('alp_issue', { action: 'search', target: 'project', query: 'x' })).error, /not on GitHub/);
});
