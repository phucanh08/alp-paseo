import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderLog, renderPs } from '../src/client/render.js';
import { epicReport } from '../src/core/tasks.js';
import { tree, until } from './support/fake-agent.js';

/**
 * Golden output of `alp log`, `alp ps` and `alp task report` (ALPD §39). A change to
 * what users read shows up as a diff of test/golden/*.txt; after checking it, run
 * ALP_UPDATE_GOLDEN=1 node --test test/golden.test.js to accept it.
 */
async function golden(name, text) {
  const file = fileURLToPath(new URL(`./golden/${name}.txt`, import.meta.url));
  if (process.env.ALP_UPDATE_GOLDEN === '1') { await writeFile(file, text); return; }
  const expected = await readFile(file, 'utf8').catch(() => assert.fail(`No ${file}; run with ALP_UPDATE_GOLDEN=1 to create it`));
  assert.equal(text, expected, `${name} differs from test/golden/${name}.txt; if the change is intended, run with ALP_UPDATE_GOLDEN=1`);
}

/** The run log with what differs between runs replaced: times, ids, paths, digests and durations. */
function normalize(entries, project) {
  const ids = new Map();
  const stable = (value, prefix) => {
    if (!ids.has(value)) ids.set(value, `${prefix}${[...ids.values()].filter(id => id.startsWith(prefix)).length + 1}`);
    return ids.get(value);
  };
  let text = JSON.stringify(entries);
  for (const id of new Set(text.match(/alp-child-[0-9a-f-]{36}/g))) text = text.replaceAll(id, stable(id, 'a'));
  for (const id of new Set(text.match(/p-[0-9a-f]{8}/g))) text = text.replaceAll(id, stable(id, 'p'));
  text = text.replaceAll(project, '/work/project');
  return JSON.parse(text).map((entry, index) => ({
    ...entry,
    ts: `2026-01-01T10:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
    ...(entry.event === 'instructions' ? { sha: `${entry.agent}-sha`, chars: 1000, parts: { project: 'alp-md', agent: `${entry.agent}-md` } } : {}),
    ...(entry.durationMs !== undefined ? { durationMs: 65_000 } : {}),
  }));
}

test('alp log of a tree whose agents are slow, crash mid-turn and hit a usage limit', async t => {
  const { root, main, agents, runtime, runLog } = await tree(t, { prefix: 'alp-golden-', open: { model: 'codex:gpt-5.6-sol' }, options: directory => ({ language: 'English', pauseFile: `${directory}/pause.json` }) });
  const finished = id => until(async () => (await runLog()).some(entry => entry.event === 'assignment.finished' && entry.assignmentId === id), `${id} to finish`);

  // A writer that pins a decision, fills its context and is slow to hand off.
  const writer = await main.call('alp_delegate', { agent: 'peer', task: 'Write the parser', wait: false });
  await until(() => agents[1]?.started.length === 1);
  await agents[1].call('alp_pin', { kind: 'decision', body: 'Parse with a state machine' });
  agents[1].usage(85_000);
  await agents[1].slowHandoff(20, { outcome: 'complete', summary: 'Parser written', verification: ['npm test: 12 passed'] }, 'Done');
  await finished(writer.assignmentId);
  await main.call('alp_wait', {});

  // A reviewer with a failing verdict.
  const review = await main.call('alp_delegate', { agent: 'reviewer', task: 'Review the parser', wait: false });
  await until(() => agents[2]?.started.length === 1);
  await agents[2].call('alp_handoff', { outcome: 'complete', summary: 'One blocker', verdict: { result: 'fail', criteria: [{ criterion: 'Rejects bad input', result: 'fail', evidence: 'parser.ts:12 accepts ""' }] } });
  agents[2].finish('Reviewed');
  await finished(review.assignmentId);
  await main.call('alp_wait', {});

  // A fixer whose process dies mid-turn; ALP restarts it and it finishes.
  const fix = await main.call('alp_delegate', { agent: 'peer', task: 'Fix empty input', wait: false });
  await until(() => agents[3]?.started.length === 1);
  agents[3].crash();
  await until(() => agents[4]?.started.length === 1, 'the restarted process');
  await agents[4].call('alp_handoff', { outcome: 'complete', summary: 'Empty input rejected' });
  agents[4].finish('Fixed');
  await finished(fix.assignmentId);
  await main.call('alp_wait', {});

  // A writer that hits the Codex usage limit and is parked.
  await main.call('alp_delegate', { agent: 'peer', task: 'Document the parser', model: 'codex:gpt-5.6-sol', wait: false });
  await until(() => agents[5]?.started.length === 1);
  agents[5].limit(4_102_444_800);
  await until(async () => (await runLog()).some(entry => entry.event === 'notice'), 'the limit notice');

  const entries = normalize(await runLog(), root);
  await golden('log', renderLog('root', entries).join('\n') + '\n');
  assert.ok(runtime.pauses().runtimes.codex);
});

test('alp ps of live trees: running, waiting, parked, failed and idle sessions', async () => {
  const session = (id, agent, extra = {}) => ({ id, agent, runtime: 'codex', model: 'gpt-5.6-sol', mode: 'workspace-write', status: 'running', projectRoot: '/work/project', ...extra });
  const sessions = [
    session('root', 'main', { activeTurnId: 'turn-1', title: 'Parser' }),
    session('a1', 'lead', { parentId: 'root', busy: true }),
    session('a2', 'peer', { parentId: 'a1', activeTurnId: 'turn-2', runtime: 'claude', model: 'claude-sonnet-5-5' }),
    session('a3', 'peer', { parentId: 'a1', parked: 'the Codex usage limit was reached' }),
    session('a4', 'reviewer', { parentId: 'root', mode: 'read-only', status: 'failed', lastError: { code: 'runtime_exited' } }),
    session('other', 'main', { status: 'idle', projectRoot: '/work/other' }),
  ];
  await golden('ps', renderPs(sessions).join('\n') + '\n');
});

test('alp task report of a landed epic with rework, a handback and mixed verification', async () => {
  const at = minutes => new Date(Date.UTC(2026, 0, 1, 9, minutes)).toISOString();
  const task = (id, title, extra = {}) => ({ id, title, type: 'task', status: 'closed', priority: 2, parent: 'e-1', blockedBy: [], related: [], labels: [], paths: [], gates: [], log: [], createdAt: at(0), verified: null, closed: { reason: 'done', by: 'main', at: at(30) }, ...extra });
  const tasks = [
    task('e-1', 'Parser', { type: 'epic', parent: null, closed: { reason: 'done', by: 'main', at: at(130), summary: 'The parser landed with tests.' } }),
    task('t-1', 'Tokenizer', { verified: { passed: true, commands: [] }, closed: { reason: 'done', by: 'main', at: at(40), summary: 'Tokenizer with 30 cases' } }),
    task('t-2', 'Grammar', { log: [{ event: 'reworked' }, { event: 'reworked' }], verified: { passed: false, commands: [] }, closed: { reason: 'done', by: 'main', at: at(90), summary: 'Grammar after two rounds', unverified: 'flaky CI' } }),
    task('t-3', 'Errors', { type: 'epic' }),
    task('t-4', 'Error messages', { parent: 't-3', log: [{ event: 'released' }], verified: { skipped: 'no tests yet', commands: [] } }),
    task('t-5', 'Recovery', { parent: 't-3', closed: { reason: 'wontfix', by: 'main', at: at(100), summary: 'Out of scope' } }),
  ];
  await golden('task-report', epicReport('e-1', tasks).text + '\n');
});
