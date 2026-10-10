import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { validateAgentConfig } from '../src/core/validation.js';
import { ClaudeTransport, createAlpRuntime } from '../dist/runtime/index.js';
import { fakeTransport, until } from './support/fake-agent.js';

async function project(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-context-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await initProject(root);
  return { directory, root, runs: path.join(directory, 'runs') };
}

const logOf = runs => async event => (await readFile(path.join(runs, 'root.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.event === event);

test('an assignment hears once that its context nears compaction, with no push to hand off, and gets its brief again after it', async t => {
  const { directory, root, runs } = await project(t);
  const runtimes = [];
  const events = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: runs });
  t.after(() => runtime.shutdown());
  runtime.onEvent(envelope => events.push([envelope.sessionId, envelope.event]));
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
  const main = runtimes[0];
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Long work on the parser', wait: false });
  const peer = runtimes[1];
  await until(() => peer.started.length === 1);

  // The window is 100k and the runtime does not say where it compacts: at 90% of it, 90k.
  peer.usage(30_000);
  peer.usage(60_000);
  peer.usage(80_000);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(peer.steered, []);
  peer.usage(82_000);
  await until(() => peer.steered.length === 1, 'the advisory');
  assert.match(peer.steered[0], /Your context holds about 82k tokens; the runtime compacts it at about 90k and keeps going\. No handoff is needed for that: keep working\./);
  assert.doesNotMatch(peer.steered[0], /alp_handoff/);
  peer.usage(88_000);

  // The compaction: shown as it runs and when done, logged, and the brief comes back.
  peer.compact(89_000, 12_000);
  await until(() => peer.steered.length === 2, 'what ALP holds after the compaction');
  assert.match(peer.steered[1], /Your context was just compacted\.[\s\S]*Your assignment from main, as it was given:\nLong work on the parser/);
  const log = logOf(runs);
  await until(async () => (await log('compacted')).length === 1, 'the compaction in the run log');
  assert.deepEqual((await log('compacted')).map(entry => [entry.agent, entry.trigger, entry.preTokens, entry.postTokens]), [['peer', 'auto', 89_000, 12_000]]);
  assert.deepEqual((await log('context')).map(entry => [entry.agent, entry.tokens, entry.compactAt, entry.level]), [['peer', 82_000, 90_000, 'soon']]);
  const shown = events.filter(([id, event]) => id === assignmentId && event.type === 'item' && event.item.kind === 'compaction').map(([, event]) => event.item.status);
  assert.deepEqual(shown, ['running', 'completed']);

  // A compaction empties the context, so the advisory may come again, against where the runtime says it compacts.
  peer.usage(185_000, 1_000_000, 200_000);
  await until(() => peer.steered.length === 3, 'the advisory after the compaction');
  assert.match(peer.steered[2], /about 185k tokens; the runtime compacts it at about 200k/);
  assert.equal(peer.steered.length, 3);

  // A failed compaction is logged and changes nothing else.
  peer.compact(0, 0, { failed: true });
  await until(async () => (await log('compacted')).length === 2, 'the failed compaction');
  assert.equal((await log('compacted'))[1].failed, true);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(peer.steered.length, 3);
});

test('main is told between turns without a turn, and after a compaction gets its open assignments and tasks again', async t => {
  const { directory, root, runs } = await project(t);
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: runs });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
  const main = runtimes[0];
  await main.call('alp_task', { action: 'create', title: 'Write the parser' });
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Write the parser', wait: false });
  await until(() => runtimes[1]?.started.length === 1);

  main.compact(170_000, 14_000);
  await until(() => main.steered.length === 1, 'what ALP holds after the compaction');
  assert.match(main.steered[0], new RegExp(`Your assignments still open:\\n- ${assignmentId}: peer, running for`));
  assert.match(main.steered[0], /Write the parser/);
  assert.doesNotMatch(main.steered[0], /Your assignment from/);

  main.finish('waiting');
  await until(() => !runtime.snapshot('root').activeTurnId);
  main.usage(82_000);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(main.started.length, 1);
  await runtime.prompt('root', { clientMessageId: 'm2', delivery: 'auto', content: [{ type: 'text', text: 'Next' }] });
  assert.match(main.started[1].params.input.at(-1).text, /holds about 82k tokens[\s\S]*pinned with alp_pin/);
});

test('an agent\'s context setting reaches the runtime that compacts: a window for Claude, a compaction limit for Codex', async t => {
  const { directory, root } = await project(t);
  const agents = path.join(root, '.alp', 'agents');
  await mkdir(path.join(agents, 'main'), { recursive: true });
  await writeFile(path.join(agents, 'main', 'AGENT.md'), 'You are main.\n');
  await writeFile(path.join(agents, 'main', 'agent.json'), JSON.stringify({ context: 400_000 }));
  for (const [model, expected] of [['claude:claude-opus-5-5', { context: 400_000 }], ['codex:gpt-5.6-sol', { config: { model_auto_compact_token_limit: 360_000 } }]]) {
    const runtimes = [];
    const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), supervisor: false, libraryDir: path.join(directory, 'home') });
    await runtime.open(model, { cwd: root, model });
    const config = runtimes[0].config;
    await runtime.shutdown();
    assert.deepEqual({ ...(config.context ? { context: config.context } : {}), ...(config.config ? { config: config.config } : {}) }, expected, model);
  }

  assert.throws(() => validateAgentConfig({ context: 50_000 }, 'agent.json'), /context must be "auto" or a number of tokens from 100000 to 1000000/);
  assert.throws(() => validateAgentConfig({ context: '400k' }, 'agent.json'), /context must be/);
  validateAgentConfig({ context: 'auto' }, 'agent.json');
  validateAgentConfig({ context: 1_000_000 }, 'agent.json');
});

test('Claude reports the window and compaction point it resolved, and no guessed window before', async () => {
  const transport = new ClaudeTransport(process.execPath, tmpdir(), process.env);
  const seen = [];
  transport.onNotification((method, params) => method === 'thread/tokenUsage/updated' && seen.push(params.tokenUsage));
  transport.activeTurn = 'turn-1';
  const assistant = usage => ({ type: 'assistant', parent_tool_use_id: null, message: { id: `m${seen.length}`, content: [], usage } });
  transport.handle(assistant({ input_tokens: 1000, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 4000, output_tokens: 5000 }));
  transport.handle({ type: 'result', subtype: 'success', is_error: false, modelUsage: { 'claude-opus-5-5': { contextWindow: 1_000_000 } } });
  transport.handle(assistant({ input_tokens: 10, output_tokens: 10 }));
  // Sub-agent messages are not the session's own context.
  transport.handle({ ...assistant({ input_tokens: 500_000, output_tokens: 1 }), parent_tool_use_id: 'tool-1' });
  assert.deepEqual(seen.map(usage => [usage.last.totalTokens, usage.modelContextWindow, usage.autoCompactTokens]), [[100_000, null, undefined], [20, 1_000_000, undefined]]);

  // What getContextUsage says wins over a result's window: the setting may make it smaller.
  transport.query = { getContextUsage: async () => ({ rawMaxTokens: 400_000, maxTokens: 400_000, autoCompactThreshold: 367_000, isAutoCompactEnabled: true }) };
  await transport.measureContext();
  transport.handle({ type: 'result', subtype: 'success', is_error: false, modelUsage: { 'claude-opus-5-5': { contextWindow: 1_000_000 } } });
  transport.handle(assistant({ input_tokens: 10, output_tokens: 10 }));
  assert.deepEqual(seen.at(-1).modelContextWindow, 400_000);
  assert.equal(seen.at(-1).autoCompactTokens, 367_000);
});

test('Claude reports a compaction as Codex does, from its start to its boundary', () => {
  const transport = new ClaudeTransport(process.execPath, tmpdir(), process.env);
  const seen = [];
  transport.onNotification((method, params) => params.item?.type === 'contextCompaction' && seen.push([method, params.item]));
  transport.activeTurn = 'turn-1';
  transport.handle({ type: 'system', subtype: 'status', status: 'compacting' });
  transport.handle({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 170_552, post_tokens: 14_738 } });
  transport.handle({ type: 'system', subtype: 'status', status: 'compacting' });
  transport.handle({ type: 'system', subtype: 'status', status: null, compact_result: 'failed', compact_error: 'prompt too long' });
  assert.deepEqual(seen.map(([method, item]) => [method, item.status ?? null, item.preTokens ?? null, item.postTokens ?? null]),
    [['item/started', null, null, null], ['item/completed', 'completed', 170_552, 14_738], ['item/started', null, null, null], ['item/completed', 'failed', null, null]]);
  assert.equal(seen[0][1].id, seen[1][1].id);
  assert.equal(seen[2][1].id, seen[3][1].id);
  assert.notEqual(seen[0][1].id, seen[2][1].id);
});
