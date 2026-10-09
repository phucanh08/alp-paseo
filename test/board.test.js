import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { connect } from '../src/client/index.js';
import { createAlpRuntime } from '../dist/runtime/index.js';
import { createDaemonServer } from '../dist/daemon/index.js';

async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}

let calls = 0;
function fakeTransport(runtimes) {
  return () => {
    const index = runtimes.length;
    const runtime = {
      calls: [], threadId: `thread-${index}`, turnId: `turn-${index}`,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() {},
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') return { turn: { id: this.turnId } };
        return {};
      },
      async call(tool, args, callId = `${tool}-${index}-${++calls}`) {
        return JSON.parse((await this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId, namespace: null, tool, arguments: args })).contentItems[0].text);
      },
      texts(method) {
        return this.calls.filter(call => call.method === method).map(call => call.params.input.map(input => input.text).join('\n'));
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function setup(t, options = {}) {
  const directory = options.directory ?? await mkdtemp(path.join(tmpdir(), 'alp-board-'));
  const root = path.join(directory, 'project');
  if (!options.directory) {
    await initProject(root);
    await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['peer'] } }));
  }
  const runtimes = [];
  const boardDir = options.boardDir ?? path.join(directory, 'boards');
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), runLogDir: path.join(directory, 'runs'), boardDir });
  t.after(() => runtime.shutdown());
  if (!options.directory) t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const envelopes = [];
  runtime.onEvent(envelope => envelopes.push(envelope));
  const start = async (id, mode = 'workspace-write') => {
    await runtime.open(id, { cwd: root, mode });
    await runtime.prompt(id, { clientMessageId: `${id}-m1`, delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
    return runtimes.at(-1);
  };
  const of = type => envelopes.filter(envelope => envelope.event.type === type);
  return { directory, root, boardDir, runtime, runtimes, start, of };
}

test('independent agents on one project share a board: claims keep them apart, pins reach running turns', async t => {
  const { root, runtime, start, of, directory } = await setup(t);
  const alice = await start('alice');
  const bob = await start('bob');

  const claimed = await alice.call('alp_pin', { kind: 'claim', body: 'Rewriting the auth module', paths: ['src/auth', `${root}/README.md`] });
  assert.deepEqual({ ...claimed, pinned: undefined }, { pinned: undefined, kind: 'claim', paths: ['src/auth', 'README.md'] });

  // Bob is told who holds what instead of editing it.
  const refused = await bob.call('alp_pin', { kind: 'claim', body: 'Session cleanup', paths: ['src'] });
  assert.match(refused.error, /claimed overlapping paths/);
  assert.deepEqual(refused.conflicts.map(conflict => [conflict.pinId, conflict.agent, conflict.sessionId, conflict.paths]), [[claimed.pinned, 'main', 'alice', ['src/auth']]]);
  assert.ok((await bob.call('alp_pin', { kind: 'claim', body: 'Billing', paths: ['src/billing/'] })).pinned);

  // A decision reaches bob's running turn as board mail, never alice's own.
  const decided = await alice.call('alp_pin', { kind: 'decision', body: 'Use JWT with 15 minute expiry everywhere' });
  await until(() => bob.texts('turn/steer').some(text => text.includes('Use JWT')));
  const steered = bob.texts('turn/steer').find(text => text.includes('Use JWT'));
  assert.match(steered, new RegExp(`\\[#\\d+\\] board from main, pin ${decided.pinned} on the project board:\\ndecision ${decided.pinned} by main: Use JWT`));
  assert.ok(!alice.texts('turn/steer').some(text => text.includes('Use JWT')));
  // Each pin reaches the other agent; nobody hears their own.
  assert.deepEqual(of('mail').map(envelope => [envelope.sessionId, envelope.event.mail.body.split(' ')[0]]), [['bob', 'claim'], ['alice', 'claim'], ['bob', 'decision']]);

  const board = await bob.call('alp_board', {});
  assert.deepEqual(board.claims.map(pin => [pin.sessionId, pin.paths]), [['alice', ['src/auth', 'README.md']], ['bob', ['src/billing']]]);
  assert.deepEqual(board.notes.map(pin => [pin.kind, pin.body]), [['decision', 'Use JWT with 15 minute expiry everywhere']]);
  assert.deepEqual((await bob.call('alp_board', { kinds: ['claim'] })).notes, []);
  assert.deepEqual(runtime.status('alice').claims.map(pin => pin.id), [claimed.pinned]);

  assert.match((await bob.call('alp_unpin', { pinId: claimed.pinned })).error, /Only main, who pinned it/);

  // A claim ends with its session; the board keeps decisions.
  await runtime.close('alice');
  await until(() => of('unpin').length === 1);
  assert.deepEqual(of('unpin')[0].event, { type: 'unpin', pinId: claimed.pinned, reason: 'session_ended' });
  assert.ok((await bob.call('alp_pin', { kind: 'claim', body: 'Session cleanup', paths: ['src/auth/session.ts'] })).pinned);
  assert.deepEqual((await runtime.board(root)).map(pin => [pin.kind, pin.sessionId]), [['claim', 'bob'], ['claim', 'bob'], ['decision', 'alice']]);

  const read = async () => (await readFile(path.join(directory, 'runs', 'alice.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  await until(async () => (await read()).some(entry => entry.event === 'board.unpin'));
  const log = await read();
  assert.deepEqual(log.filter(entry => entry.event.startsWith('board.')).map(entry => [entry.event, entry.kind ?? entry.reason]), [['board.pin', 'claim'], ['board.pin', 'decision'], ['board.unpin', 'session_ended']]);
});

test('an assignment starts with the board, shares its requester\'s claims and never claims read-only', async t => {
  const { runtimes, start } = await setup(t);
  const main = await start('root');
  const other = await start('other');
  await other.call('alp_pin', { kind: 'finding', body: 'The test database needs Docker' });
  const held = await main.call('alp_pin', { kind: 'claim', body: 'Payments', paths: ['src/payments'] });

  await main.call('alp_delegate', { agent: 'peer', task: 'Fix the refund rounding', wait: false });
  await until(() => runtimes.length === 3 && runtimes[2].texts('turn/start').length);
  const peer = runtimes[2];
  const [assignment] = peer.texts('turn/start');
  assert.match(assignment, /Fix the refund rounding\n\nProject board \(shared by every agent on this project; read more with alp_board\):\n- claim p-\w+ by main \[src\/payments\]: Payments\n- finding p-\w+ by main: The test database needs Docker/);

  // The requester's claim covers its assignment; another tree's does not.
  assert.ok((await peer.call('alp_pin', { kind: 'claim', body: 'Refunds', paths: ['src/payments/refund.ts'] })).pinned);
  assert.match((await other.call('alp_pin', { kind: 'claim', body: 'x', paths: ['src/payments/refund.ts'] })).error, /overlapping/);
  assert.equal((await other.call('alp_pin', { kind: 'claim', body: 'x', paths: ['src/payments/refund.ts'] })).conflicts.length, 2);
  assert.equal(held.kind, 'claim');

  const reader = await start('reader', 'read-only');
  assert.match((await reader.call('alp_pin', { kind: 'claim', body: 'Look', paths: ['docs'] })).error, /read-only session/);
  assert.ok((await reader.call('alp_pin', { kind: 'finding', body: 'docs/api.md is stale' })).pinned);
});

test('pins are checked: kinds, bodies, project-relative paths and owners', async t => {
  const { start } = await setup(t);
  const main = await start('root');
  for (const [args, error] of [
    [{ kind: 'task', body: 'x' }, /A pin needs kind/],
    [{ kind: 'decision', body: ' ' }, /A pin needs kind/],
    [{ kind: 'finding', body: 'x'.repeat(2001) }, /A pin needs kind/],
    [{ kind: 'claim', body: 'x' }, /paths must list 1 to 50/],
    [{ kind: 'claim', body: 'x', paths: [] }, /paths must list 1 to 50/],
    [{ kind: 'claim', body: 'x', paths: ['../elsewhere'] }, /outside the project/],
    [{ kind: 'claim', body: 'x', paths: ['/etc/passwd'] }, /outside the project/],
    [{ kind: 'claim', body: 'x', paths: [''] }, /nonempty strings/],
    [{ kind: 'decision', body: 'x', extra: 1 }, /A pin needs kind/],
  ]) assert.match((await main.call('alp_pin', args)).error, error, JSON.stringify(args));
  assert.deepEqual((await main.call('alp_pin', { kind: 'claim', body: 'Everything', paths: ['.', 'src/../src'] })).paths, ['.', 'src']);
  assert.match((await main.call('alp_unpin', { pinId: 'p-missing' })).error, /No such pin/);
  assert.match((await main.call('alp_board', { kinds: ['task'] })).error, /kinds lists/);
  const finding = await main.call('alp_pin', { kind: 'finding', body: 'Flaky test in CI' });
  assert.deepEqual(await main.call('alp_unpin', { pinId: finding.pinned }), { unpinned: finding.pinned });
  assert.deepEqual((await main.call('alp_board', { kinds: ['finding'] })).notes, []);
});

test('a board outlives the daemon: decisions and findings stay, claims end with their sessions', async t => {
  const first = await setup(t);
  const main = await first.start('root');
  await main.call('alp_pin', { kind: 'claim', body: 'Search', paths: ['src/search'] });
  const decision = await main.call('alp_pin', { kind: 'decision', body: 'Use SQLite FTS5' });
  const dropped = await main.call('alp_pin', { kind: 'finding', body: 'Wrong guess' });
  await main.call('alp_unpin', { pinId: dropped.pinned });
  await first.runtime.shutdown();

  const second = await setup(t, { directory: first.directory });
  const board = await second.runtime.board(first.root);
  assert.deepEqual(board.map(pin => [pin.id, pin.kind, pin.body]), [[decision.pinned, 'decision', 'Use SQLite FTS5']]);
  const other = await second.start('other');
  // The restarted board accepts the claim the ended session held.
  assert.ok((await other.call('alp_pin', { kind: 'claim', body: 'Search again', paths: ['src/search'] })).pinned);
  const [file] = await readdir(first.boardDir);
  await until(async () => (await readFile(path.join(first.boardDir, file), 'utf8')).includes('Search again'));
  const lines = (await readFile(path.join(first.boardDir, file), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  // Compacted on load: only what was kept, then what came after.
  assert.deepEqual(lines.map(line => line.pin?.body), ['Use SQLite FTS5', 'Search again']);
});

test('alpd serves the board by project, and status shows a tree\'s claims', async t => {
  const { directory, root, runtime, start } = await setup(t);
  const server = createDaemonServer({ runtime, socketPath: path.join(directory, 'd.sock'), version: 'test' });
  await server.listen();
  t.after(() => server.close());
  const client = await connect(path.join(directory, 'd.sock'));
  t.after(() => client.close());
  const main = await start('root');
  const claim = await main.call('alp_pin', { kind: 'claim', body: 'API', paths: ['src/api'] });
  const { pins } = await client.request('board.list', { projectRoot: root });
  assert.deepEqual(pins.map(pin => [pin.id, pin.kind, pin.paths]), [[claim.pinned, 'claim', ['src/api']]]);
  assert.deepEqual((await client.request('board.list', { projectRoot: path.join(directory, 'elsewhere') })).pins, []);
  await assert.rejects(client.request('board.list', { projectRoot: 'relative' }), error => error.code === -32602);
  const { status } = await client.request('session.status', { sessionId: 'root' });
  assert.deepEqual(status.claims.map(pin => pin.id), [claim.pinned]);
});
