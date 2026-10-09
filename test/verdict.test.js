import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { createTask, getTask, loadTasks, startTask, submitTask, taskDigest } from '../src/core/tasks.js';
import { createAlpRuntime } from '../dist/runtime/index.js';
import { fakeTransport, until } from './support/fake-agent.js';

const criterion = (result, text = 'Retries stop after three attempts') => ({ criterion: text, result, evidence: `src/retry.ts:40 ${result}` });

test('a reviewer files a verdict whose result follows from its criteria and findings', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-verdict-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await initProject(root);
  const runs = path.join(directory, 'runs');
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: runs });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
  const main = runtimes[0];
  const { assignmentId } = await main.call('alp_delegate', { agent: 'reviewer', task: 'Review the retry change', wait: false });
  const reviewer = runtimes[1];
  await until(() => reviewer.started.length === 1);
  assert.match(reviewer.calls.find(call => call.method === 'thread/start').params.developerInstructions, /## Verdict[\s\S]*`pass_with_findings`: only medium or low findings/);

  const refused = async (args, pattern) => {
    const answer = await reviewer.call('alp_handoff', { outcome: 'complete', summary: 'Reviewed', ...args });
    assert.match(answer.error ?? '', pattern);
  };
  await refused({}, /A complete review needs a verdict/);
  await refused({ verdict: { result: 'pass', criteria: [] } }, /1 to 50 criteria/);
  await refused({ verdict: { result: 'pass', criteria: [criterion('fail')] } }, /verdict pass cannot have a failed criterion; the result is fail/);
  await refused({ verdict: { result: 'pass_with_findings', criteria: [criterion('pass')], findings: [{ severity: 'high', where: 'src/retry.ts:41', problem: 'Off by one' }] } }, /cannot have a critical or high finding/);
  await refused({ verdict: { result: 'fail', criteria: [criterion('pass')] } }, /fail needs a failed criterion or a critical or high finding/);
  await refused({ verdict: { result: 'pass', criteria: [criterion('pass')], findings: [{ severity: 'low', where: 'a:1', problem: 'Name' }] } }, /use pass_with_findings/);
  await refused({ verdict: { result: 'pass', criteria: [{ criterion: 'x', result: 'maybe', evidence: 'y' }] } }, /each verdict criterion needs/);
  // A review that stops short may hand off without one.
  assert.deepEqual(await reviewer.call('alp_handoff', { outcome: 'partial', summary: 'Half way' }), { recorded: true, to: 'main', next: 'End your turn with a one-line final message.' });

  const verdict = {
    result: 'fail',
    criteria: [criterion('fail'), criterion('not_checked', 'Works offline')],
    findings: [{ severity: 'high', where: 'src/retry.ts:41', problem: 'Retries forever', fix: 'Count attempts' }],
  };
  assert.equal((await reviewer.call('alp_handoff', { outcome: 'complete', summary: 'One blocker', verdict })).recorded, true);
  reviewer.finish('Reviewed');
  const waited = await main.call('alp_wait', { assignments: [assignmentId] });
  assert.deepEqual(waited.events[0].result.handoff.verdict, verdict);
  const finished = async () => (await readFile(path.join(runs, 'root.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).find(entry => entry.event === 'assignment.finished');
  await until(finished, 'the finished entry');
  assert.deepEqual((await finished()).handoff.verdict.result, 'fail');
  main.finish('ok');
});

test('a task keeps the verdict of the handoff that submitted it, and main sees it among tasks to accept', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-verdict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const task = await createTask(root, { title: 'Review retries' }, 'main');
  await startTask(root, task.id, { agent: 'reviewer', assignment: 'a1' }, 'main');
  const verdict = { result: 'pass_with_findings', criteria: [criterion('pass')], findings: [{ severity: 'low', where: 'a:1', problem: 'Name' }] };
  await submitTask(root, task.id, { assignment: 'a1', agent: 'reviewer', handoff: { outcome: 'complete', summary: 'Fine', verdict } }, 'alpd');
  assert.deepEqual((await getTask(root, task.id)).handoff.verdict, verdict);
  assert.match(taskDigest((await loadTasks(root)).tasks), new RegExp(`review: ${task.id} .* handoff complete, verdict pass_with_findings`));
});
