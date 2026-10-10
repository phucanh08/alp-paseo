import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../src/core/init.js';
import { getEntry, listEntries, saveEntry } from '../src/core/library-edit.js';
import { testEntry } from '../src/client/library-test.js';
import { diagnose } from '../src/client/doctor.js';
import { acpDecision, acpPermission, createAlpRuntime } from '../dist/runtime/index.js';

const FAKE = fileURLToPath(new URL('./support/fake-acp.js', import.meta.url));

async function until(check, what = 'Expected condition') {
  for (let i = 0; i < 1000; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${what} did not arrive`);
}

/** A project, a library with the fake ACP provider, and a runtime that starts real transports. */
async function setup(t, { env = {}, settings = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-acp-'));
  const root = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const logFile = path.join(dir, 'acp.jsonl');
  await initProject(root);
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'pho', supervisor: false }, ...settings }));
  await saveEntry('providers', 'fake', { provider: { kind: 'acp', label: 'Fake', command: process.execPath, args: [FAKE], env: { FAKE_ACP_LOG: logFile, ...env } } }, { scope: 'library', library: home });
  const runtime = createAlpRuntime({ language: 'English', supervisor: false, libraryDir: home, runLogDir: path.join(dir, 'runs') });
  const events = [];
  runtime.onEvent(envelope => events.push(envelope));
  t.after(async () => { await runtime.shutdown(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const received = async () => (await readFile(logFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  let prompts = 0;
  /** Sends a prompt and waits for its turn to end; returns the turn's end and its assistant text. */
  const turn = async (text, sessionId = 'root') => {
    const id = `m${++prompts}`;
    const start = events.length;
    await runtime.prompt(sessionId, { clientMessageId: id, delivery: 'auto', content: [{ type: 'text', text }] });
    const ended = entry => entry.sessionId === sessionId && (entry.event.type === 'turn.ended' || (entry.event.type === 'prompt.failed' && entry.event.clientMessageId === id));
    await until(() => events.slice(start).some(ended), `the turn of ${text}`);
    const mine = events.slice(start).filter(entry => entry.sessionId === sessionId);
    const said = mine.filter(entry => entry.event.type === 'item' && entry.event.item.kind === 'assistant_message').map(entry => entry.event.item.text);
    return { end: events.slice(start).find(ended).event, text: said.at(-1), events: mine.map(entry => entry.event) };
  };
  const runLog = async () => (await readFile(path.join(dir, 'runs', 'root.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { dir, root, home, runtime, events, received, turn, runLog };
}

test('a provider lives in the library only, names no built-in runtime, and is tried out with initialize', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-acp-lib-'));
  const root = await mkdtemp(path.join(tmpdir(), 'alp-acp-root-'));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]));
  await initProject(root);
  const provider = { kind: 'acp', command: process.execPath, args: [FAKE] };
  await assert.rejects(saveEntry('providers', 'fake', { provider }, { scope: 'project', root, library: home }), { code: 'INVALID_SCOPE' });
  await assert.rejects(saveEntry('providers', 'codex', { provider }, { scope: 'library', library: home }), { code: 'INVALID_PROVIDER' });
  await assert.rejects(saveEntry('providers', 'odd', { provider: { ...provider, kind: 'mcp' } }, { scope: 'library', library: home }), /kind must be "acp"/);
  await assert.rejects(saveEntry('providers', 'odd', { provider: { ...provider, modles: [] } }, { scope: 'library', library: home }), /did you mean 'models'/);
  await saveEntry('providers', 'fake', { provider }, { scope: 'library', library: home });
  // An agent names a provider that exists.
  await assert.rejects(saveEntry('agents', 'scout', { instructions: 'S', config: { provider: 'absent' } }, { scope: 'library', root, library: home }), /provider 'absent' is neither codex, claude nor an ACP provider/);
  await saveEntry('agents', 'scout', { instructions: 'S', config: { provider: 'fake' } }, { scope: 'library', root, library: home });
  assert.deepEqual((await listEntries('providers', { root, library: home })).map(row => [row.name, row.source, row.usedBy]), [['fake', 'library', ['scout']]]);
  assert.deepEqual((await getEntry('providers', 'fake', { root, library: home })).usedBy, ['agent scout']);
  const result = await testEntry('providers', 'fake', { root, library: home });
  assert.deepEqual([result.ok, result.agent, result.loadSession, result.protocolVersion], [true, { name: 'fake-acp', title: 'Fake ACP', version: '1.0.0' }, false, 1]);
  // Doctor warns what ALP cannot do for an ACP agent, and which providers cannot start.
  await saveEntry('providers', 'gone', { provider: { kind: 'acp', command: 'no-such-acp-agent' } }, { scope: 'library', library: home });
  const check = (await diagnose({ home, env: { PATH: path.dirname(process.execPath) } })).find(entry => entry.id === 'providers');
  assert.equal(check.status, 'warn');
  assert.match(check.summary, /^2 ACP providers \(fake, gone\); 1 cannot start$/);
  assert.deepEqual(check.details[0], 'gone: no-such-acp-agent is not found');
  assert.match(check.details[1], /no sandbox around an ACP agent/);
});

test('a session on an ACP agent: instructions in its first prompt, its answer streamed, ALP tools through the bridge', async t => {
  const { root, runtime, received, turn, events } = await setup(t);
  const opened = await runtime.open('root', { cwd: root, model: 'acp:fake' });
  assert.deepEqual([opened.runtime, opened.model, opened.thinking], ['acp', 'fake', 'none']);
  const first = await turn('fake:say hello there');
  assert.equal(first.end.state, 'completed');
  assert.equal(first.text, 'hello there');
  const log = await received();
  const init = log.find(message => message.method === 'initialize').params;
  assert.deepEqual([init.protocolVersion, init.clientCapabilities], [1, { fs: { readTextFile: false, writeTextFile: false }, terminal: false }]);
  const created = log.find(message => message.method === 'session/new').params;
  assert.equal(created.cwd, root);
  assert.deepEqual(created.mcpServers.map(server => server.name), ['alp']);
  const prompts = log.filter(message => message.method === 'session/prompt').map(message => message.params.prompt);
  assert.match(prompts[0][0].text, /^Instructions from ALP, which runs you\.[\s\S]*ALP runtime identity: main\./);
  assert.match(prompts[0][0].text, /ALP's tools \(alp_\*\) come from the MCP server named alp\. ALP answers your permission requests by your full-access mode/);

  // The agent lists and calls ALP's tools through the MCP server ALP gave it.
  const tools = await turn('fake:tools');
  assert.match(tools.text, /^tools: .*\balp_board\b/);
  assert.match(tools.text, /\balp_delegate\b/);
  const called = await turn('fake:tool alp_pin {"kind":"decision","body":"Use ACP"}');
  assert.match(called.text, /^tool alp_pin: \{"pinned":"p-/);
  assert.ok(called.events.some(event => event.type === 'item' && event.item.kind === 'tool_call' && event.item.name === 'alp_pin' && event.item.status === 'completed'));
  // The agent's own call to the bridge does not show twice.
  assert.ok(!called.events.some(event => event.type === 'item' && event.item.name === 'shell'));
  const ran = await turn('fake:exec npm test');
  assert.ok(ran.events.some(event => event.type === 'item' && event.item.name === 'shell' && event.item.status === 'completed' && event.item.detail.output === 'ran npm test'));
  // Instructions go only with the first prompt.
  const later = (await received()).filter(message => message.method === 'session/prompt').slice(1);
  assert.ok(later.every(message => !message.params.prompt.some(block => block.text.startsWith('Instructions from ALP'))));
  assert.ok(events.some(entry => entry.event.type === 'pin'));
});

test('ALP answers the agent\'s permission requests by its mode and profile, and asks the user beyond them', async t => {
  const settings = { permissions: { profiles: { careful: { base: 'workspace-write', allow: ['Bash(npm test:*)'], ask: ['Bash(npm publish:*)'], deny: ['Bash(rm:*)'], beyondMode: 'ask' } }, agents: { main: 'careful' } } };
  const { root, runtime, turn, runLog } = await setup(t, { settings });
  await runtime.open('root', { cwd: root, model: 'acp:fake', mode: 'read-only' });
  assert.equal((await turn('fake:permit read src/index.js')).text, 'permission: yes');
  assert.equal((await turn('fake:permit execute npm test -- --watch')).text, 'permission: yes');
  assert.equal((await turn('fake:permit execute rm -rf build')).text, 'permission: no');
  // Beyond read-only, the profile asks the user.
  const asked = turn(`fake:permit edit ${path.join(root, 'README.md')}`);
  await until(() => runtime.questions().length === 1, 'the question');
  const question = runtime.questions()[0];
  assert.match(question.body, /main wants to edit `.*README\.md`.*Its read-only mode does not allow that\./);
  runtime.answer(question.id, { text: 'Allow once' });
  assert.equal((await asked).text, 'permission: yes');
  const ruled = turn('fake:permit execute npm publish');
  await until(() => runtime.questions().length === 1, 'the second question');
  assert.match(runtime.questions()[0].body, /Its permission profile careful asks you each time/);
  runtime.answer(runtime.questions()[0].id, { text: 'Deny' });
  assert.equal((await ruled).text, 'permission: no');
  // The run log is written in the background.
  const permissions = async () => (await runLog()).filter(entry => entry.event === 'permission');
  await until(async () => (await permissions()).length === 3, 'three permission entries');
  const decisions = (await permissions()).map(entry => [entry.command, entry.decision, entry.asked ?? false]);
  assert.deepEqual(decisions, [['rm -rf build', 'decline', false], [path.join(root, 'README.md'), 'accept', true], ['npm publish', 'decline', true]]);
  // The decision itself, without a session.
  const edit = file => acpPermission({ kind: 'edit', title: 'Edit', locations: [{ path: file }] }, []);
  assert.equal(acpDecision(edit(path.join(root, 'a.js')), 'workspace-write', null, root), 'allow');
  assert.equal(acpDecision(edit('/etc/hosts'), 'workspace-write', null, root), 'mode');
  assert.equal(acpDecision(edit('/etc/hosts'), 'full-access', null, root), 'allow');
  assert.equal(acpDecision(acpPermission({ kind: 'other', title: 'alp: alp_board' }, ['alp_board']), 'read-only', null, root), 'allow');
});

test('a cancelled turn ends as canceled; a failed prompt and a dead agent fail it', async t => {
  const { root, runtime, turn, events } = await setup(t);
  await runtime.open('root', { cwd: root, model: 'acp:fake' });
  const hanging = turn('fake:hang');
  await until(() => events.some(entry => entry.event.type === 'turn.started'), 'the turn');
  // Mail and steering wait for the turn: an ACP agent takes no messages during one.
  await runtime.prompt('root', { clientMessageId: 'steer', delivery: 'steer', content: [{ type: 'text', text: 'also this' }] });
  await until(() => events.some(entry => entry.event.type === 'prompt.failed' && entry.event.clientMessageId === 'steer'), 'the refused steer');
  assert.match(events.find(entry => entry.event.type === 'prompt.failed').event.error.message, /takes no messages during a turn/);
  await runtime.interrupt('root');
  assert.equal((await hanging).end.state, 'canceled');
  const failed = await turn('fake:fail');
  assert.deepEqual([failed.end.state, failed.end.error?.message], ['failed', 'Fake: fake failure']);
  const dead = await turn('fake:exit');
  assert.equal(dead.end.state, 'failed');
  await until(() => events.some(entry => entry.event.type === 'session.failed'), 'the failed session');
  assert.match(events.find(entry => entry.event.type === 'session.failed').event.error.message, /Fake exited \(3\)/);
});

test('models, resuming, and what an ACP session cannot do', async t => {
  const { root, home, runtime, received, turn } = await setup(t, { env: { FAKE_ACP_MODELS: 'small,large', FAKE_ACP_LOAD: '1' } });
  await assert.rejects(runtime.open('missing', { cwd: root, model: 'acp:absent' }), /No ACP provider 'absent': add one to your library with alp provider add absent/);
  await runtime.open('root', { cwd: root, model: 'acp:fake/large' });
  assert.deepEqual((await received()).filter(message => message.method === 'session/set_model').map(message => message.params.modelId), ['large']);
  await turn('fake:say first');
  const sessionId = (await received()).find(message => message.method === 'session/prompt').params.sessionId;
  await runtime.close('root');
  // A provider listing models refuses others.
  await saveEntry('providers', 'listed', { provider: { kind: 'acp', command: process.execPath, args: [FAKE], models: [{ id: 'small' }] } }, { scope: 'library', library: home });
  await assert.rejects(runtime.open('other', { cwd: root, model: 'acp:listed/huge' }), /ACP provider 'listed' lists no model 'huge'/);
  // A resumed session loads the agent's session; the history it replays is not shown again, and the instructions are not sent again.
  const resumed = await runtime.open('again', { cwd: root, restore: { agent: 'main', threadId: sessionId, runtime: 'acp', model: 'fake/large' } });
  assert.equal(resumed.runtime, 'acp');
  const again = await turn('fake:say second', 'again');
  assert.equal(again.text, 'second');
  assert.ok(!again.events.some(event => event.type === 'item' && event.item.text === 'replayed history'));
  const loaded = (await received()).filter(message => message.method === 'session/load');
  assert.deepEqual(loaded.map(message => message.params.sessionId), [sessionId]);
  const last = (await received()).filter(message => message.method === 'session/prompt').at(-1);
  assert.ok(!last.params.prompt.some(block => block.text.startsWith('Instructions from ALP')));
  // A review copy needs a sandbox ALP cannot give an ACP agent.
  await assert.rejects(runtime.open('copy', { cwd: root, model: 'acp:fake', workdir: root, copy: true }), /A review copy cannot run on an ACP agent/);
});
