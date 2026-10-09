import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initProject } from '../src/core/init.js';
import { listTeams, resolveTeam } from '../src/core/teams.js';
import { createAlpRuntime } from '../dist/runtime/index.js';
import { createProvider } from '../plugins/paseo/server/dist/index.js';
import { PROVIDER_CAPABILITIES } from '@getpaseo/plugin/server/provider';

// The coordination text the runtime held before teams; Phở and Cafe's house rules are this text, moved.
const BEFORE_TEAMS = mode => `Profile: ${mode}; fixed for this session. In Phở (pho), main implements or directly delegates to peer; do not create lead. In Cafe (cafe), main supervises lead; lead may implement or delegate to peer. The technical coordinator chooses each peer's model and effort. Use oracle for significant uncertainty; use reviewer for logic changes and risky changes, not mandatory for typo/format fixes. Advisors return only to their requesting coordinator.`;

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-teams-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function files(root, entries) {
  for (const [name, content] of Object.entries(entries)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
}
async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}
function fakeTransport(runtimes) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    const runtime = {
      kind, calls: [], threadId: `thread-${index}`,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') return { turn: { id: `turn-${index}` } };
        return {};
      },
      get config() { return this.calls.find(call => call.method === 'thread/start').params; },
    };
    runtimes.push(runtime);
    return runtime;
  };
}
async function session(t, root, spec, options = {}) {
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), runLogDir: path.join(root, '.runs'), ...options });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, ...spec });
  return { runtime, runtimes };
}

const docsTeam = {
  label: 'Docs', description: 'An architect plans; writers write.', main: 'architect',
  members: { architect: { model: 'claude:claude-sonnet-5-5', thinking: 'low' }, writer: { role: 'peer' }, reviewer: { role: 'reviewer' } },
  delegation: { architect: ['writer', 'reviewer'] }, maxPeers: 3,
  supervisor: { agent: 'watcher', model: 'codex:gpt-6-sol', thinking: 'low' },
};

test('Phở and Cafe give main the coordination text it had before teams, and a custom graph keeps it too', async t => {
  for (const mode of ['pho', 'cafe', undefined]) {
    const root = await fixture(t);
    await initProject(root);
    if (!mode) await files(root, { '.alp/settings.json': { delegation: { main: ['peer'] } } });
    const { runtimes } = await session(t, root, mode ? { workflow: mode } : {}, { supervisor: false });
    const instructions = runtimes[0].config.developerInstructions;
    assert.ok(instructions.includes(`\n\n${BEFORE_TEAMS(mode ?? 'custom')}\n\n`), instructions);
    // Main still runs on Opus 5.5 with high effort, in a team or a custom graph.
    assert.deepEqual([runtimes[0].kind, runtimes[0].config.model, runtimes[0].config.thinking], ['claude', 'claude-opus-5-5', 'high']);
  }
});

test('teams come from the built-ins, then the library, then the project, and are checked', async t => {
  const [root, library] = [await fixture(t), await fixture(t)];
  await files(library, { 'teams/pho/team.json': { ...docsTeam, label: 'My Phở' }, 'teams/pho/HOUSE_RULES.md': 'Library rules\n', 'teams/docs/team.json': docsTeam, 'teams/draft/notes.md': 'not a team' });
  await files(root, { '.alp/teams/docs/team.json': { ...docsTeam, label: 'Project docs' } });
  assert.deepEqual((await listTeams(root, { library })).map(row => [row.id, row.source, row.label, row.overrides]), [
    ['cafe', 'builtin', 'Cafe', undefined], ['pho', 'library', 'My Phở', 'builtin'], ['docs', 'project', 'Project docs', 'library'],
  ]);
  assert.deepEqual((await listTeams(undefined, {})).map(row => row.id), ['pho', 'cafe']);
  const pho = await resolveTeam(root, 'smart', { library });
  assert.deepEqual([pho.id, pho.main, pho.houseRules], ['pho', 'architect', 'Library rules']);
  await assert.rejects(resolveTeam(root, 'absent', { library }), /Team 'absent' not found; teams: pho, cafe, docs/);
  const broken = async (change, pattern) => {
    await files(root, { '.alp/teams/bad/team.json': { ...docsTeam, ...change } });
    await assert.rejects(resolveTeam(root, 'bad'), error => error.code === 'INVALID_TEAM' && pattern.test(error.message) && error.message.includes(path.join('.alp', 'teams', 'bad', 'team.json')));
  };
  await broken({ delegation: { architect: ['writer'], writer: ['reviewer'], reviewer: ['writer'] } }, /delegation cycle/);
  await broken({ delegation: { architect: ['stranger'] } }, /stranger is not a member/);
  await broken({ delegation: { writer: ['architect'] } }, /architect is not a member main can be assigned to/);
  await broken({ main: 'boss' }, /members must include main \(boss\)/);
  await broken({ members: { ...docsTeam.members, writer: { role: 'coder' } } }, /members\.writer\.role must be one of lead, peer, advisor, reviewer/);
  await broken({ members: { ...docsTeam.members, writer: { role: 'peer', thinkng: 'x' } } }, /members\.writer: unknown setting 'thinkng'; did you mean 'thinking'\?/);
  await broken({ supervisor: { agent: 'writer' } }, /cannot be a member/);
  await broken({ maxPers: 2 }, /did you mean 'maxPeers'/);
  await files(root, { '.alp/teams/bad/team.json': '{' });
  await assert.rejects(resolveTeam(root, 'bad'), { code: 'INVALID_TEAM' });
});

test('a team of your own: its main leads with the team graph, models and house rules, and its supervisor watches', async t => {
  const root = await fixture(t);
  await initProject(root);
  await files(root, {
    '.alp/teams/docs/team.json': docsTeam,
    '.alp/teams/docs/HOUSE_RULES.md': 'Docs rules: every page gets a reviewer.\n',
    '.alp/agents/architect/AGENT.md': 'Architect',
    // The team chooses the architect's model over its own.
    '.alp/agents/architect/agent.json': { provider: 'codex', model: 'gpt-6-sol', thinking: 'max' },
    '.alp/agents/writer/AGENT.md': 'Writer',
    '.alp/agents/watcher/AGENT.md': 'Watcher',
  });
  const { runtimes } = await session(t, root, { workflow: 'docs', agent: 'architect' });
  const main = runtimes[0].config;
  assert.deepEqual([runtimes[0].kind, main.model, main.thinking, main.sandbox], ['claude', 'claude-sonnet-5-5', 'low', 'full-access']);
  assert.match(main.developerInstructions, /Profile: docs; fixed for this session\. Docs rules: every page gets a reviewer\./);
  assert.match(main.developerInstructions, /ALP runtime identity: architect\. Use alp_delegate to assign bounded work to: writer, reviewer\./);
  assert.match(main.developerInstructions, /At most 3 peers may run concurrently/);
  // As the team's main, the architect manages tasks and files issues.
  assert.ok(main.dynamicTools.some(tool => tool.name === 'alp_issue'));
  assert.ok(main.dynamicTools.find(tool => tool.name === 'alp_task').inputSchema.properties.action.enum.includes('create'));
  await until(() => runtimes.length === 2 && runtimes[1].calls.some(call => call.method === 'thread/start'));
  const watcher = runtimes[1].config;
  assert.deepEqual([runtimes[1].kind, watcher.model, watcher.thinking, watcher.sandbox], ['codex', 'gpt-6-sol', 'low', 'read-only']);
  assert.match(watcher.developerInstructions, /Watcher[\s\S]*supervisor of architect/);
});

test('settings.json runtime still comes before a team, and the caller before both', async t => {
  const root = await fixture(t);
  await initProject(root);
  await files(root, { '.alp/settings.json': { workflow: { mode: 'pho', supervisor: false }, runtime: { provider: 'codex', model: 'gpt-6-sol', reasoning: 'low' } } });
  let { runtimes } = await session(t, root, {});
  assert.deepEqual([runtimes[0].kind, runtimes[0].config.model, runtimes[0].config.thinking], ['codex', 'gpt-6-sol', 'low']);
  await files(root, { '.alp/settings.json': { workflow: { mode: 'pho', supervisor: false } } });
  ({ runtimes } = await session(t, root, { model: 'codex:gpt-6.1-sol', thinking: 'medium' }));
  assert.deepEqual([runtimes[0].kind, runtimes[0].config.model, runtimes[0].config.thinking], ['codex', 'gpt-6.1-sol', 'medium']);
});

test('Paseo offers every team the project can use, and alp teams lists them', async t => {
  const [root, home] = [await fixture(t), await fixture(t)];
  await initProject(root);
  await files(home, { 'teams/review/team.json': { ...docsTeam, label: 'Review' } });
  await files(root, { '.alp/teams/docs/team.json': docsTeam, '.alp/teams/broken/team.json': '{' });
  const previous = process.env.ALP_HOME;
  process.env.ALP_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.ALP_HOME; else process.env.ALP_HOME = previous; });
  const conn = await createProvider({ transport: fakeTransport([]) }).connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  t.after(() => conn.close());
  const events = [];
  conn.onEvent(event => events.push(event));
  await conn.send({ type: 'catalog', requestId: 'c', cwd: root });
  assert.deepEqual(events[0].catalog.models.map(model => [model.id, model.label]), [['pho', 'Phở'], ['cafe', 'Cafe'], ['review', 'Review'], ['docs', 'Docs']]);
  assert.equal(events[0].catalog.defaultModel, 'pho');
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const listed = spawnSync(process.execPath, [cli, 'teams', '--project', root], { encoding: 'utf8', env: { ...process.env, ALP_HOME: home } });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^docs {2}Docs {2}project$/m);
  assert.match(listed.stdout, /members: architect \(main\) on claude:claude-sonnet-5-5, low, writer \(peer\), reviewer \(reviewer\)/);
  assert.match(listed.stdout, /delegation: architect → writer, reviewer/);
  assert.match(listed.stdout, /^broken {2} {2}project\n {2}error: /m);
});
