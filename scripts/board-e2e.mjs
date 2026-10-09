// Opt-in: real model calls through alpd. Two independent agents work on one project at once.
// Alice claims src/auth and pins a decision; Bob, started later, reads the board, is refused
// an overlapping claim and follows the decision; Bob's finding reaches Alice's running turn.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';

const model = process.env.ALP_TEST_MODEL ?? 'codex:gpt-5.6-sol';
const home = await mkdtemp(path.join(tmpdir(), 'alp-board-e2e-'));
const env = { ...process.env, ALP_HOME: home, ALP_RUN_LOG_DIR: path.join(home, 'runs') };
const alp = (...args) => spawnSync(process.execPath, ['src/cli.js', ...args], { env, encoding: 'utf8' });
const root = path.resolve('.alp-test', `board-${Date.now()}`);
await initProject(root);
await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'smart', maxPeers: 2 } }));
const hashing = `HASH-${randomUUID().slice(0, 8)}`;
const finding = `FINDING-${randomUUID().slice(0, 8)}`;

const alice = [
  'Integration check of the project board. Do not edit files.',
  'First call alp_pin with kind claim, paths ["src/auth"] and body "Rewriting login".',
  `Then call alp_pin with kind decision and body "Password hashing uses ${hashing}".`,
  'Then run the shell command `sleep 45` once.',
  'Finally reply with the body of every finding you received as board mail from another agent, verbatim, or NONE.',
].join(' ');
const bob = [
  'Integration check of the project board. Do not edit files and do not run shell commands.',
  'First call alp_board. Then call alp_pin with kind claim, paths ["src/auth/login.ts"] and body "Fix login".',
  `Then call alp_pin with kind finding and body "${finding}".`,
  'Finally reply in this form: CLAIM: <granted, or refused because of which agent>; HASHING: <the password hashing decision on the board, verbatim>.',
].join(' ');

function run(prompt) {
  const child = spawn(process.execPath, ['src/cli.js', 'run', '--json', '--project', root, '--mode', 'workspace-write', '--model', model, '--thinking', 'low', prompt], { env });
  const envelopes = [];
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      envelopes.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGINT'); reject(new Error('alp run timed out')); }, 600_000);
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(envelopes) : reject(new Error(`alp run exited ${code}: ${stderr}`)); });
  });
  return { envelopes, done };
}

const final = envelopes => {
  const root = envelopes.find(e => e.event.type === 'session.opened' && !e.event.session.parentId)?.sessionId;
  return { root, text: envelopes.filter(e => e.sessionId === root && e.event.type === 'item' && e.event.item.kind === 'assistant_message').at(-1)?.event.item.text ?? '' };
};

try {
  assert.equal(alp('daemon', 'start').status, 0);
  const a = run(alice);
  // Bob starts once Alice's claim and decision are on the board, while she is still at work.
  const board = () => JSON.parse(alp('board', '--project', root, '--json').stdout || '[]');
  for (const deadline = Date.now() + 300_000; board().filter(pin => pin.kind !== 'finding').length < 2;) {
    assert.ok(Date.now() < deadline, 'alice pinned her claim and decision');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const top = alp('top', '--once').stdout;
  const b = run(bob);
  const [aliceEnvelopes, bobEnvelopes] = await Promise.all([a.done, b.done]);
  const aliceFinal = final(aliceEnvelopes);
  const bobFinal = final(bobEnvelopes);
  const pins = bobEnvelopes.concat(aliceEnvelopes).filter(e => e.event.type === 'pin').map(e => ({ session: e.sessionId, kind: e.event.pin.kind, body: e.event.pin.body, paths: e.event.pin.paths }));
  const boardMail = aliceEnvelopes.filter(e => e.sessionId === aliceFinal.root && e.event.type === 'mail' && e.event.mail.kind === 'board').map(e => e.event.mail.body);
  const refused = bobEnvelopes.filter(e => e.event.type === 'item' && e.event.item.kind === 'tool_call' && e.event.item.name === 'alp_pin' && JSON.stringify(e.event.item.detail).includes('overlapping'));
  // Alice's root closes once idle and her claim ends with it.
  for (const deadline = Date.now() + 30_000; board().some(pin => pin.kind === 'claim') && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 500));
  const evidence = {
    project: root, model, hashing, finding, top: top.split('\n'), pins, boardMail, bobRefused: refused.length,
    alice: aliceFinal.text, bob: bobFinal.text,
    boardAfter: alp('board', '--project', root).stdout.split('\n'),
    log: alp('log', aliceFinal.root).stdout.split('\n'),
  };
  await writeFile('.alp-test/board-e2e.json', JSON.stringify({ ...evidence, aliceEnvelopes, bobEnvelopes }, null, 2));
  console.log(JSON.stringify(evidence));
  assert.match(top, /⚑ main claims src\/auth: Rewriting login/);
  assert.ok(refused.length >= 1, 'bob\'s overlapping claim was refused');
  assert.ok(!pins.some(pin => pin.session === bobFinal.root && pin.kind === 'claim'), 'bob holds no claim on src/auth');
  assert.match(bobFinal.text, /refused/i);
  assert.ok(bobFinal.text.includes(hashing), 'bob read the decision from the board');
  assert.ok(boardMail.some(body => body.includes(finding)), 'bob\'s finding reached alice as board mail');
  assert.ok(aliceFinal.text.includes(finding), 'alice read the finding in her running turn');
  // Alice's claim ended with her session; the decision and finding stay.
  const after = board();
  assert.deepEqual(after.map(pin => pin.kind).sort(), ['decision', 'finding']);
  assert.ok(evidence.log.some(line => /⚑ main pins claim/.test(line)) && evidence.log.some(line => /released when its session ended/.test(line)), 'the log shows the claim and its release');
  console.log(JSON.stringify({ passed: true, evidence: '.alp-test/board-e2e.json' }));
} finally {
  alp('daemon', 'stop');
  await rm(home, { recursive: true, force: true });
}
