import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { ClaudeTransport, createAlpRuntime } from '../dist/runtime/index.js';
import { fakeTransport, until } from './support/fake-agent.js';

test('an assignment hears about its context only past 60% and 80%, once each until the context empties again', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-context-'));
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
  await main.call('alp_delegate', { agent: 'peer', task: 'Long work', wait: false });
  const peer = runtimes[1];
  await until(() => peer.started.length === 1);

  peer.usage(30_000);
  peer.usage(59_000);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(peer.steered, []);
  peer.usage(65_000);
  await until(() => peer.steered.length === 1, 'the plan advisory');
  assert.match(peer.steered[0], /Your context is about 65% full\. Plan how you finish: if much remains, prepare to file alp_handoff with outcome partial/);
  peer.usage(72_000);
  peer.usage(85_000);
  await until(() => peer.steered.length === 2, 'the hand-off advisory');
  assert.match(peer.steered[1], /Your context is about 85% full; the runtime will compact it soon and lose detail\. Finish the step you are on, then file alp_handoff with outcome partial/);
  peer.usage(90_000);
  // A compaction empties it; the advisory starts over.
  peer.usage(20_000);
  peer.usage(62_000);
  await until(() => peer.steered.length === 3, 'the advisory after compaction');
  assert.match(peer.steered[2], /about 62% full/);
  const contextLog = async () => (await readFile(path.join(runs, 'root.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.event === 'context');
  await until(async () => (await contextLog()).length === 3, 'the context entries in the run log');
  const logged = await contextLog();
  assert.deepEqual(logged.map(entry => [entry.agent, entry.percent, entry.level]), [['peer', 65, 'plan'], ['peer', 85, 'now'], ['peer', 62, 'plan']]);

  // Main is told between turns, without a turn started for it.
  main.finish('waiting');
  await until(() => !runtime.snapshot('root').activeTurnId);
  main.usage(82_000);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(main.started.length, 1);
  await runtime.prompt('root', { clientMessageId: 'm2', delivery: 'auto', content: [{ type: 'text', text: 'Next' }] });
  assert.match(main.started[1].params.input.at(-1).text, /about 82% full[\s\S]*pin decisions and findings with alp_pin/);
});

test('Claude reports its context fill as Codex does, with the window from the last result', () => {
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
  assert.deepEqual(seen.map(usage => [usage.last.totalTokens, usage.modelContextWindow]), [[100_000, 200_000], [20, 1_000_000]]);
});
