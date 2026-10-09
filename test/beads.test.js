import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as toml } from 'smol-toml';
import { initProject } from '../src/core/init.js';
import { exportBeads, importBeads, parseJsonl } from '../src/core/beads.js';
import { findFormula, listFormulas, pourFormula, validateFormula } from '../src/core/formulas.js';
import { addGate, closeTask, createTask, getTask, linkTask, loadTasks, readyTasks, resolveGate, startTask, submitTask } from '../src/core/tasks.js';
import { createAlpRuntime } from '../dist/runtime/index.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function project(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-beads-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  await mkdir(path.join(root, '.alp'), { recursive: true });
  return { directory, root };
}

const jsonl = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';
const strip = ({ rev: _rev, log: _log, updatedAt: _updatedAt, ...task }) => task;

// --- beads JSONL -----------------------------------------------------------------

test('export writes beads issues, and importing them into another project gives the same tasks back', async t => {
  const { directory, root } = await project(t);
  const epic = await createTask(root, { title: 'Status for scripts', type: 'epic', description: 'Why', labels: ['cli'] }, 'user');
  const first = await createTask(root, { title: 'Normalize', parent: epic.id, priority: 1, paths: ['src/status.js'] }, 'main');
  const second = await createTask(root, { title: 'Add --json', parent: epic.id, blockedBy: [first.id] }, 'main');
  const found = await createTask(root, { title: 'Flaky test', type: 'bug', discoveredFrom: first.id }, 'main');
  await linkTask(root, found.id, { add: { related: [second.id] } }, 'main');
  await startTask(root, first.id, { agent: 'peer', assignment: 'a1' }, 'main');
  await submitTask(root, first.id, { assignment: 'a1', handoff: { outcome: 'complete', summary: 'Done; npm test passed' }, agent: 'peer' }, 'peer');
  await addGate(root, second.id, { kind: 'human', note: 'Wait for me' }, 'main');
  const until = new Date(Date.now() + 3_600_000).toISOString();
  await addGate(root, second.id, { kind: 'timer', until }, 'main');
  await closeTask(root, found.id, { reason: 'wontfix', summary: 'Not ours' }, 'main');

  const { tasks } = await loadTasks(root);
  const issues = exportBeads(tasks);
  assert.deepEqual(issues.map(issue => issue.id), [epic.id, first.id, second.id, found.id].sort());
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  assert.deepEqual(byId.get(first.id).dependencies, [{ issue_id: first.id, depends_on_id: epic.id, type: 'parent-child' }]);
  assert.deepEqual(byId.get(second.id).dependencies.map(dep => [dep.depends_on_id, dep.type]), [[first.id, 'blocks'], [epic.id, 'parent-child']]);
  assert.deepEqual(byId.get(found.id).dependencies.map(dep => [dep.depends_on_id, dep.type]), [[first.id, 'discovered-from'], [second.id, 'related']]);
  // beads has no review: it is in progress there, and the metadata keeps the rest.
  assert.deepEqual([byId.get(first.id).status, byId.get(first.id).assignee, byId.get(first.id).metadata.alp.status], ['in_progress', 'peer', 'review']);
  assert.equal(byId.get(second.id).defer_until, until);
  assert.deepEqual([byId.get(found.id).status, byId.get(found.id).close_reason, byId.get(found.id).issue_type], ['closed', 'Not ours', 'bug']);

  const other = path.join(directory, 'other');
  await mkdir(path.join(other, '.alp'), { recursive: true });
  const { records, errors } = parseJsonl(jsonl(issues));
  assert.deepEqual(errors, []);
  const report = await importBeads(other, records);
  assert.deepEqual([report.created.length, report.updated.length, report.skipped, report.warnings], [4, 0, [], []]);
  const copied = (await loadTasks(other)).tasks;
  for (const task of tasks) {
    const copy = copied.find(entry => entry.id === task.id);
    // Nobody holds the copy of a task in review, so it has no assignee.
    assert.deepEqual({ ...strip(copy), assignee: null }, { ...strip(task), assignee: null }, task.id);
  }
  assert.deepEqual(readyTasks(copied).map(task => task.id), []);

  // Importing the same file again changes nothing.
  const again = await importBeads(other, parseJsonl(jsonl(issues)).records);
  assert.deepEqual([again.created, again.updated], [[], []]);
  // So does the file bd export writes after importing it: whole-second times, _type, metadata as JSON text.
  const viaBd = issues.map(issue => ({ _type: 'issue', ...issue, ...(issue.defer_until ? { defer_until: issue.defer_until.replace(/\.\d+Z$/, 'Z') } : {}), ...(issue.metadata ? { metadata: JSON.stringify(issue.metadata) } : {}) }));
  const throughBd = await importBeads(other, parseJsonl(jsonl(viaBd)).records);
  assert.deepEqual([throughBd.created, throughBd.updated, throughBd.warnings], [[], [], []]);
});

test('import takes beads-native issues: new ids, dependencies after the fact, and what it cannot keep reported', async t => {
  const { root } = await project(t);
  const later = new Date(Date.now() + 86_400_000).toISOString();
  const text = [
    jsonl([
      { id: 'bd-a1b2.1', title: 'Child before its parent', status: 'open', priority: 1, issue_type: 'task', dependencies: [{ issue_id: 'bd-a1b2.1', depends_on_id: 'bd-a1b2', type: 'parent-child' }] },
      { id: 'bd-a1b2', title: 'Release 0.4', issue_type: 'epic', status: 'open', design: 'Ship in two steps', acceptance_criteria: 'npm test passes' },
      { id: 'bd-c3d4', title: 'Write notes', issue_type: 'chore', status: 'in_progress', assignee: 'alice', defer_until: later, labels: ['docs', 'bad label!'],
        dependencies: [{ issue_id: 'bd-c3d4', depends_on_id: 'bd-a1b2.1', type: 'blocks' }, { issue_id: 'bd-c3d4', depends_on_id: 'bd-zzzz', type: 'blocks' }, { issue_id: 'bd-c3d4', depends_on_id: 'bd-a1b2', type: 'waits-for' }] },
      { id: 'bd-e5f6', title: 'Gone', status: 'tombstone' },
      { id: 'bd-wisp', title: 'Scratch', ephemeral: true },
      { id: 'bd-0000', title: 'Old', status: 'closed', closed_at: '2026-01-01T00:00:00Z', close_reason: 'Shipped', issue_type: 'message' },
      { id: 'bd-0001' },
      { _type: 'memory', id: 'bd-m1', title: 'Remember this' },
    ]).trim(),
    'not json',
  ].join('\n');
  const { records, errors } = parseJsonl(text);
  assert.deepEqual(errors.map(error => error.line), [9]);

  const dry = await importBeads(root, records, { dryRun: true });
  assert.equal(dry.created.length, 4);
  assert.deepEqual((await loadTasks(root)).tasks, []);

  const report = await importBeads(root, records);
  assert.deepEqual(report.skipped.map(entry => [entry.line, entry.reason]), [[4, 'bd-e5f6 is deleted (tombstone)'], [5, 'bd-wisp is ephemeral'], [7, 'no title'], [8, 'memory record, not an issue']]);
  const made = Object.fromEntries(report.created.map(entry => [entry.from, entry.id]));
  assert.deepEqual(Object.keys(made).sort(), ['bd-0000', 'bd-a1b2', 'bd-a1b2.1', 'bd-c3d4']);
  // beads ids are not ALP ids: tasks get new ones, the child numbered under its parent.
  assert.equal(made['bd-a1b2.1'], `${made['bd-a1b2']}.1`);
  const epic = await getTask(root, made['bd-a1b2']);
  assert.deepEqual(epic.external, { system: 'beads', id: 'bd-a1b2' });
  assert.equal(epic.description, '## Design\n\nShip in two steps\n\n## Acceptance criteria\n\nnpm test passes');
  const notes = await getTask(root, made['bd-c3d4']);
  assert.deepEqual([notes.type, notes.status, notes.labels, notes.blockedBy], ['chore', 'open', ['docs'], [made['bd-a1b2.1']]]);
  assert.deepEqual(notes.gates.map(gate => [gate.kind, gate.until]), [['timer', later]]);
  const old = await getTask(root, made['bd-0000']);
  assert.deepEqual([old.type, old.labels, old.status, old.closed.summary, old.closed.at], ['task', ['beads:message'], 'closed', 'Shipped', '2026-01-01T00:00:00Z']);
  assert.deepEqual(report.warnings, [
    'bd-c3d4: was in progress with alice in beads; imported as open',
    'bd-c3d4: blocks bd-zzzz is not in the file or the project; skipped',
    'bd-c3d4: dependency type waits-for has no ALP relation; skipped',
  ]);

  // An upsert finds the tasks it made by their beads ids.
  const changed = records.map(({ line, record }) => ({ line, record: record.id === 'bd-c3d4' ? { ...record, title: 'Write the notes', status: 'closed' } : record }));
  const update = await importBeads(root, changed);
  assert.deepEqual([update.created, update.updated], [[], [{ id: made['bd-c3d4'], from: 'bd-c3d4' }]]);
  const closed = await getTask(root, made['bd-c3d4']);
  assert.deepEqual([closed.title, closed.status, closed.closed.by, closed.log.at(-1).event], ['Write the notes', 'closed', 'beads', 'imported']);
});

// --- formulas --------------------------------------------------------------------

const RELEASE = `formula = "release"
description = "Ship {{version}}"
version = 2

[vars.version]
description = "The version to ship"
required = true

[vars.branch]
default = "main"

[[steps]]
id = "changelog"
title = "Write the changelog for {{version}}"
paths = ["CHANGELOG.md"]

[[steps]]
id = "approve"
title = "Approve the {{version}} changelog"
type = "human"
needs = ["changelog"]

[[steps]]
id = "publish"
title = "Publish {{version}} from {{branch}}"
type = "chore"
needs = ["approve"]
`;

test('formulas are found by name, checked, and poured into an epic with a task per step', async t => {
  const { directory, root } = await project(t);
  const home = path.join(directory, 'home');
  await mkdir(path.join(root, '.alp', 'formulas'), { recursive: true });
  await mkdir(path.join(home, 'formulas'), { recursive: true });
  await mkdir(path.join(root, '.beads', 'formulas'), { recursive: true });
  await writeFile(path.join(root, '.alp', 'formulas', 'release.formula.toml'), RELEASE);
  // The project's own formula wins over the user's of the same name.
  await writeFile(path.join(home, 'formulas', 'release.formula.json'), JSON.stringify({ formula: 'release', steps: [{ id: 'x', title: 'Other' }] }));
  await writeFile(path.join(home, 'formulas', 'review.formula.json'), JSON.stringify({ formula: 'review', steps: [{ id: 'read', title: 'Read it' }] }));
  await writeFile(path.join(root, '.beads', 'formulas', 'broken.formula.toml'), 'formula = "broken"\n[[steps]]\nid = "a"\ntitle = "A"\nneeds = ["b"]\n');
  assert.deepEqual((await listFormulas(root, home)).map(entry => entry.error ?? entry.formula.formula), ['reading TOML formulas needs a TOML parser', 'review', 'reading TOML formulas needs a TOML parser']);
  const found = await listFormulas(root, home, { toml });
  assert.deepEqual(found.map(entry => [entry.name, entry.error ?? entry.formula.steps.length]), [['release', 3], ['review', 1], ['broken', 'Step a needs unknown step b']]);
  await assert.rejects(findFormula(root, home, 'broken', { toml }), /broken\.formula\.toml: Step a needs unknown step b/);
  await assert.rejects(findFormula(root, home, 'nope', { toml }), /No formula nope in/);

  assert.throws(() => validateFormula({ formula: 'x', steps: [{ id: 'a', title: 'A', needs: ['b'] }, { id: 'b', title: 'B', needs: ['a'] }] }), /Steps form a cycle: a → b → a/);
  assert.throws(() => validateFormula({ formula: 'x', steps: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] }), /Two steps have id a/);
  assert.throws(() => validateFormula({ formula: 'x', steps: [] }), /steps must list 1 to 50 steps/);

  const { formula } = await findFormula(root, home, 'release', { toml });
  await assert.rejects(pourFormula(root, formula, {}, 'user'), /release needs --var version=… \(The version to ship\)/);
  await assert.rejects(pourFormula(root, formula, { version: '1', colour: 'red' }, 'user'), /release has no variable colour; it takes version, branch/);
  const dry = await pourFormula(root, formula, { version: '0.4.0' }, 'user', { dryRun: true });
  assert.equal(dry.tasks.length, 3);
  assert.deepEqual((await loadTasks(root)).tasks, []);

  const { epic, tasks } = await pourFormula(root, formula, { version: '0.4.0' }, 'main');
  assert.deepEqual([epic.title, epic.description, epic.type, epic.labels, epic.formula], ['release (version=0.4.0, branch=main)', 'Ship 0.4.0', 'epic', ['formula:release'], { name: 'release', version: 2, vars: { version: '0.4.0', branch: 'main' } }]);
  const [changelog, approve, publish] = tasks;
  assert.deepEqual(tasks.map(task => task.id), [1, 2, 3].map(n => `${epic.id}.${n}`));
  assert.deepEqual([changelog.title, changelog.paths, changelog.step], ['Write the changelog for 0.4.0', ['CHANGELOG.md'], { formula: 'release', id: 'changelog' }]);
  assert.deepEqual([approve.blockedBy, approve.step.human, approve.gates.map(gate => [gate.kind, gate.note])], [[changelog.id], true, [['human', 'Your step: Approve the 0.4.0 changelog']]]);
  assert.deepEqual([publish.title, publish.type, publish.blockedBy], ['Publish 0.4.0 from main', 'chore', [approve.id]]);
  assert.deepEqual(readyTasks((await loadTasks(root)).tasks).map(task => task.id), [changelog.id]);

  // The user approving a human step completes it, and the next step is ready.
  await closeTask(root, changelog.id, { summary: 'Written' }, 'main');
  const approved = await resolveGate(root, approve.id, 'g1', { by: 'user', note: 'Looks right' });
  assert.deepEqual([approved.status, approved.closed.by, approved.closed.summary], ['closed', 'user', 'Approved by user: Looks right']);
  assert.deepEqual(readyTasks((await loadTasks(root)).tasks).map(task => task.id), [publish.id]);
});

test('main lists and pours formulas with alp_task; the CLI pours, exports and imports', async t => {
  const { directory, root } = await project(t);
  await initProject(root);
  const home = path.join(directory, 'home');
  await mkdir(path.join(root, '.alp', 'formulas'), { recursive: true });
  await writeFile(path.join(root, '.alp', 'formulas', 'release.formula.toml'), RELEASE);

  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs') });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  const [main] = runtimes;
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Release 0.4.0' }] });
  const listed = await main.call('alp_task', { action: 'formulas' });
  assert.deepEqual(listed.formulas[0].steps, ['changelog: Write the changelog for {{version}}', 'approve (the user): Approve the {{version}} changelog', 'publish: Publish {{version}} from {{branch}}']);
  assert.ok(listed.searched.includes(path.join(home, 'formulas')));
  assert.match((await main.call('alp_task', { action: 'pour', formula: 'release' })).error, /release needs --var version/);
  assert.match((await main.call('alp_task', { action: 'pour', formula: 'release', vars: { version: 4 } })).error, /pour needs formula, and vars as an object of text values/);
  const poured = await main.call('alp_task', { action: 'pour', formula: 'release', vars: { version: '0.4.0' } });
  assert.deepEqual([poured.task.type, poured.steps.map(step => step.title)], ['epic', ['Write the changelog for 0.4.0', 'Approve the 0.4.0 changelog', 'Publish 0.4.0 from main']]);
  assert.equal((await getTask(root, poured.task.id)).createdBy, 'main');
  assert.match((await main.call('alp_task', { action: 'clear', id: poured.steps[1].id, gate: 'g1' })).error, /Only the user clears a human gate/);
  main.finish('Poured');

  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ALP_HOME: home } });
  assert.match(run('formula', 'list').stdout, /^release {2}3 steps {2}Ship \{\{version\}\}$/m);
  assert.match(run('formula', 'show', 'release').stdout, /--var version=… \(required\) {2}The version to ship\n {2}--var branch=… \(default main\)\n {2}changelog: Write the changelog for \{\{version\}\}\n {2}approve \[you\]: Approve the \{\{version\}\} changelog {2}after changelog/);
  const missing = run('formula', 'pour', 'release');
  assert.deepEqual([missing.status, missing.stderr.trim()], [1, 'alp: release needs --var version=… (The version to ship)']);
  assert.match(run('formula', 'pour', 'release', '--var', 'version=0.5.0', '--dry-run').stdout, /^Would pour release as t-[0-9a-f]{4} {2}release \(version=0\.5\.0, branch=main\)$/m);
  assert.match(run('formula', 'pour', 'release', '--var', 'version=0.5.0', '--var', 'branch=next').stdout, /Poured release[\s\S]*Publish 0\.5\.0 from next/);
  assert.equal((await loadTasks(root)).tasks.length, 8);

  const file = path.join(directory, 'issues.jsonl');
  assert.match(run('tasks', 'export', '-o', file).stderr, /Exported 8 tasks to/);
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 8);
  assert.equal(run('tasks', 'export').stdout, await readFile(file, 'utf8'));
  // The default file is the project's .beads/issues.jsonl, as bd writes it.
  await mkdir(path.join(root, '.beads'));
  await writeFile(path.join(root, '.beads', 'issues.jsonl'), jsonl([{ id: 'bd-9999', title: 'From beads' }]) + 'oops\n');
  const dry = run('tasks', 'import', '--dry-run');
  assert.match(dry.stdout, /^\+ t-[0-9a-f]{4} \(from bd-9999\)\nWould import .*issues\.jsonl: 1 created, 0 updated, 1 skipped\n$/);
  assert.match(dry.stderr, /skipped line 2: /);
  assert.equal((await loadTasks(root)).tasks.length, 8);
  assert.match(run('tasks', 'import').stdout, /Imported .*: 1 created, 0 updated, 1 skipped/);
  assert.match(run('tasks', 'import', file).stdout, /: 0 created, 0 updated, 0 skipped/);
  assert.equal((await loadTasks(root)).tasks.length, 9);
});

// --- helpers ------------------------------------------------------------------------

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
      async call(tool, args) {
        return JSON.parse((await this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId: `${tool}-${index}-${++calls}`, namespace: null, tool, arguments: args })).contentItems[0].text);
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

async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}
