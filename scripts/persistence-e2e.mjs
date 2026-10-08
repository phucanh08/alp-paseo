// Opt-in: real model calls. Kills alpd with SIGKILL mid-turn, restarts it, and checks the
// root is settled as daemon_restarted and resumes its native thread with earlier context.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { connect, readLock } from '../src/client/index.js';

const model = process.env.ALP_TEST_MODEL ?? 'codex:gpt-5.6-sol';
const home = await mkdtemp(path.join(tmpdir(), 'alp-persist-'));
const env = { ...process.env, ALP_HOME: home, ALP_RUN_LOG_DIR: path.join(home, 'runs') };
const cli = (...args) => spawnSync(process.execPath, ['src/cli.js', ...args], { env, encoding: 'utf8' });

/** Runs the CLI with --json; resolves its envelopes, or calls `onEnvelope` as they stream. */
function stream(args, onEnvelope = () => {}) {
  const child = spawn(process.execPath, ['src/cli.js', ...args, '--json'], { env });
  const envelopes = [];
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const envelope = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      envelopes.push(envelope);
      onEnvelope(envelope, child);
    }
  });
  const done = new Promise(resolve => child.on('close', code => resolve({ code, envelopes })));
  return { child, done };
}
const lastAnswer = (envelopes, sessionId) => envelopes.filter(e => e.sessionId === sessionId && e.event.type === 'item' && e.event.item.kind === 'assistant_message').at(-1)?.event.item.text ?? '';

const root = path.resolve('.alp-test', `persist-${Date.now()}`);
await initProject(root);
await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ defaultAgent: 'main' }));
const word = `ORCHID-${randomUUID().slice(0, 8)}`;

try {
  assert.equal(cli('daemon', 'start').status, 0);
  const first = await stream(['run', '--project', root, '--model', model, '--thinking', 'low', `Remember the code word ${word}. Reply only with OK.`]).done;
  assert.equal(first.code, 0);
  const sessionId = first.envelopes.find(e => e.event.type === 'session.opened').sessionId;

  // Kill alpd while a turn runs.
  const { pid } = await readLock(home);
  let killed = false;
  const second = stream(['send', sessionId, 'Run the shell command `sleep 90`, then reply only with DONE.'], (envelope, child) => {
    if (!killed && envelope.sessionId === sessionId && envelope.event.type === 'turn.started') {
      killed = true;
      setTimeout(() => { process.kill(pid, 'SIGKILL'); child.kill(); }, 3000);
    }
  });
  await second.done;
  assert.ok(killed, 'the second turn started before the kill');

  assert.equal(cli('daemon', 'start').status, 0);
  const client = await connect((await readLock(home)).socket);
  const { session } = await client.request('session.get', { sessionId });
  client.close();
  assert.equal(session.status, 'error');
  assert.equal(session.lastError.code, 'daemon_restarted');
  const ps = cli('ps', '--all').stdout;
  assert.match(ps, new RegExp(`${sessionId}.*daemon_restarted`));

  const third = await stream(['send', sessionId, 'What was the code word I asked you to remember? Reply with the word only.']).done;
  assert.equal(third.code, 0);
  const answer = lastAnswer(third.envelopes, sessionId);
  const evidence = { home, project: root, sessionId, word, killedPid: pid, statusAfterRestart: session.status, lastError: session.lastError, ps, answer };
  await writeFile('.alp-test/persistence-e2e.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  assert.ok(answer.includes(word), 'the resumed session remembers the code word');
  console.log(JSON.stringify({ passed: true, evidence: '.alp-test/persistence-e2e.json' }));
} finally {
  cli('daemon', 'stop');
  await rm(home, { recursive: true, force: true });
}
