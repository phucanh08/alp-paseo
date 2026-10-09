import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { createAlpRuntime } from '../dist/runtime/index.js';

function fakeTransport(runtimes) {
  return () => {
    const runtime = {
      calls: [], threadId: `thread-${runtimes.length}`,
      async initialize() {}, onNotification() {}, onFailure() {}, onRequest() {}, async close() {},
      async request(method, params) { this.calls.push({ method, params }); return method.startsWith('thread/') ? { thread: { id: this.threadId } } : {}; },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

test('each session records a digest of its instructions, and of ALP.md and AGENT.md, so a change shows in the run log', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-instructions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  await initProject(root);
  const runs = path.join(directory, 'runs');
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: runs });
  t.after(() => runtime.shutdown());
  // The run log is written in the background: wait for the entry.
  const log = async id => {
    for (let i = 0; i < 400; i++) {
      const entries = (await readFile(path.join(runs, `${id}.jsonl`), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.event === 'instructions');
      if (entries.length) return entries;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(`no instructions entry for ${id}`);
  };

  const first = await runtime.open('one', { cwd: root });
  const [before] = await log('one');
  assert.match(before.sha, /^[0-9a-f]{12}$/);
  assert.equal(first.instructionsSha, before.sha);
  assert.equal(before.agent, 'main');
  assert.equal(before.chars, runtimes[0].calls[0].params.developerInstructions.length);

  await appendFile(path.join(root, 'ALP.md'), '\nAlways write tests first.\n');
  await runtime.open('two', { cwd: root });
  const [after] = await log('two');
  assert.notEqual(after.sha, before.sha);
  assert.notEqual(after.parts.project, before.parts.project);
  assert.equal(after.parts.agent, before.parts.agent);

});
