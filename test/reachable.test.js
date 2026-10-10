import test from 'node:test';
import assert from 'node:assert/strict';
import { tree, until } from './support/fake-agent.js';

/**
 * Main stays reachable while its assignments run (ALPD §48): the user's words end its
 * waits, check-ins keep it and the user posted, and an ETA it gave is held to.
 */
const steer = (runtime, text) => runtime.prompt('root', { clientMessageId: `steer-${text}`, delivery: 'steer', content: [{ type: 'text', text }] });
const peerHandoff = { outcome: 'complete', summary: 'Done' };

test('the user\'s message ends main\'s wait for an assignment, which keeps running', async t => {
  const { runtime, agents, main } = await tree(t, { options: () => ({ checkInMs: 0 }) });
  const waiting = main.call('alp_delegate', { agent: 'peer', task: 'Do the long job', mode: 'read-only', wait: true });
  await until(() => agents[1]?.started.length, 'the peer to start');
  await steer(runtime, 'How is it going?');
  const early = await waiting;
  assert.equal(early.status, 'running');
  assert.equal(early.userMessage, true);
  assert.match(early.next, /Answer them first/);
  assert.deepEqual(main.calls.filter(call => call.method === 'turn/steer').map(call => call.params.input.at(-1).text), ['How is it going?']);
  assert.equal(agents[1].closed, false, 'the assignment keeps running');

  // alp_wait ends early the same way, then collects the result.
  const wait = main.call('alp_wait', { timeoutMs: 60_000 });
  await steer(runtime, 'Also add a README');
  const released = await wait;
  assert.equal(released.userMessage, true);
  assert.deepEqual(released.running.map(entry => [entry.agent, entry.status]), [['peer', 'running']]);
  const result = main.call('alp_wait', { timeoutMs: 60_000 });
  await agents[1].call('alp_handoff', peerHandoff);
  agents[1].finish('finished');
  const [event] = (await result).events;
  assert.equal(event.kind, 'result');
  assert.equal(event.result.output, 'finished');
});

test('main gets a check-in while assignments run, and check-ins do not use up its wakes', async t => {
  const { agents, main, runLog } = await tree(t, { options: () => ({ checkInMs: 40, silentForMs: 3_600_000 }) });
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Do the long job', mode: 'read-only', wait: false, etaMinutes: 30 });
  await until(() => agents[1]?.started.length, 'the peer to start');
  await agents[1].call('alp_send', { to: 'parent', kind: 'note', body: 'Halfway through the parser' });
  main.finish('Started peer on it; I will report back.');
  // More check-ins than the wake limit (8) each wake main, which finishes its turn.
  for (let wake = 1; wake <= 10; wake++) {
    await until(() => main.started.length === 1 + wake, `check-in wake ${wake}`);
    const text = main.started.at(-1).params.input.at(-1).text;
    assert.match(text, /check-in from ALP/);
    assert.match(text, new RegExp(`peer \\(${assignmentId}\\): running \\d+ s; last activity \\d+ s ago; ETA in 30 min; last note: Halfway through the parser`));
    assert.match(text, /Tell the user in one or two lines how the work is going/);
    main.finish('Peer is still on the parser.');
  }
  // The result still wakes main.
  await agents[1].call('alp_handoff', peerHandoff);
  agents[1].finish('parser done');
  await until(() => main.started.at(-1).params.input.at(-1).text.includes('parser done'), 'the result wake');
  assert.ok((await runLog()).some(entry => entry.event === 'mail' && entry.kind === 'checkin'));
});

test('an assignment past the ETA its requester gave ends the requester\'s wait with a check-in, once', async t => {
  const { agents, main } = await tree(t, { options: () => ({ checkInMs: 0, silentForMs: 3_600_000, watchMs: 10 }) });
  // ALP's timers do not hold the process open; this does while the test awaits them.
  const alive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(alive));
  for (const etaMinutes of [0, 1441, 1.5, '5']) {
    assert.match((await main.call('alp_delegate', { agent: 'peer', task: 'x', mode: 'read-only', etaMinutes })).error, /Invalid assignment/);
  }
  const real = Date.now;
  t.after(() => { Date.now = real; });
  const waiting = main.call('alp_delegate', { agent: 'peer', task: 'Quick fix', mode: 'read-only', etaMinutes: 1, wait: true });
  await until(() => agents[1]?.started.length, 'the peer to start');
  Date.now = () => real() + 61_000;
  const late = await waiting;
  assert.equal(late.status, 'running');
  assert.match(late.next, /Not a result: the assignment keeps running/);
  assert.equal(late.events[0].kind, 'checkin');
  assert.match(late.events[0].body, /^1 assignment still running; peer past the ETA you gave:/);
  assert.match(late.events[0].body, /past its ETA by \d+ s/);
  // Once: a later wait sees the result, not another check-in.
  const result = main.call('alp_wait', { timeoutMs: 60_000 });
  await new Promise(resolve => setTimeout(resolve, 100));
  await agents[1].call('alp_handoff', peerHandoff);
  agents[1].finish('fixed');
  assert.deepEqual((await result).events.map(event => event.kind), ['result']);
});

test('main is told to ask once about unclear requests and to stay reachable while others work', async t => {
  const { main } = await tree(t);
  const instructions = main.config.developerInstructions;
  assert.match(instructions, /Unclear requests: .*ask once before you plan or delegate/);
  assert.match(instructions, /offer to decide with those defaults/);
  assert.match(instructions, /Stay reachable while others work, as a chat where work runs in the background\. .*Then end your turn rather than wait/);
  assert.match(instructions, /Background first: run long shell commands/);
  assert.match(instructions, /by default alp_delegate starts the assignment and returns its assignmentId at once/);
  const delegate = main.config.dynamicTools.find(tool => tool.name === 'alp_delegate');
  assert.equal(delegate.inputSchema.properties.etaMinutes.maximum, 1440);
});

test('a steer from its requester ends a lead\'s wait for its peer, which keeps running', async t => {
  const { agents, main } = await tree(t, { open: { workflow: 'cafe' }, options: () => ({ checkInMs: 0 }) });
  // Background is the default: main gets the assignment id at once.
  const { assignmentId: leadId, status } = await main.call('alp_delegate', { agent: 'lead', task: 'Build the site' });
  assert.equal(status, 'running');
  await until(() => agents[1]?.started.length, 'lead to start');
  const lead = agents[1];
  // Lead waits for its peer, then for a named assignment.
  const waiting = lead.call('alp_delegate', { agent: 'peer', task: 'Write the pages', mode: 'read-only', wait: true });
  await until(() => agents[2]?.started.length, 'peer to start');
  await main.call('alp_send', { to: leadId, kind: 'steer', body: 'The user wants a Notion-like style' });
  const early = await waiting;
  assert.equal(early.status, 'running');
  assert.deepEqual(early.events.map(event => [event.kind, event.from, event.body]), [['steer', 'main', 'The user wants a Notion-like style']]);
  assert.match(early.next, /pass that on with alp_send/);
  assert.equal(agents[2].closed, false, 'the peer keeps running');
  const named = lead.call('alp_wait', { assignments: [early.assignmentId], timeoutMs: 60_000 });
  await main.call('alp_send', { to: leadId, kind: 'note', body: 'Also a dark mode' });
  assert.deepEqual((await named).events.map(event => event.body), ['Also a dark mode']);
});

test('notes from running assignments ride with main\'s next turn instead of waking it', async t => {
  const { agents, main } = await tree(t, { options: () => ({ checkInMs: 0 }) });
  await main.call('alp_delegate', { agent: 'peer', task: 'Long job', mode: 'read-only' });
  await until(() => agents[1]?.started.length, 'the peer to start');
  main.finish('Peer is on it.');
  await agents[1].call('alp_send', { to: 'parent', kind: 'note', body: 'Halfway' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(main.started.length, 1, 'a note does not wake main');
  await agents[1].call('alp_handoff', peerHandoff);
  agents[1].finish('all done');
  await until(() => main.started.length === 2, 'the result wake');
  const text = main.started[1].params.input.at(-1).text;
  assert.match(text, /note from peer[\s\S]*Halfway[\s\S]*result from peer/);
});

test('while the user waits a minute for main\'s first words, every ALP tool result reminds main to answer', async t => {
  const { runtime, main } = await tree(t, { options: () => ({ checkInMs: 0 }) });
  await steer(runtime, 'Sao rồi e ơi');
  assert.equal((await main.call('alp_board', {})).userWaiting, undefined, 'not within the first minute');
  const real = Date.now;
  t.after(() => { Date.now = real; });
  Date.now = () => real() + 61_000;
  const reminded = await main.call('alp_board', {});
  assert.match(reminded.userWaiting, /^The user wrote to you at \d\d:\d\d:\d\d and has had no reply for \d+ s\. Before more tool calls, answer them in a short message they can read/);
  // Words the user can read end the reminders.
  main.notification('item/completed', { threadId: main.threadId, item: { type: 'agentMessage', id: 'reply', text: 'Lead đang review, khoảng 10 phút nữa xong ạ.' } });
  assert.equal((await main.call('alp_board', {})).userWaiting, undefined);
});

test('Claude adopts a turn it starts by itself, as after a background task ended (ALPD §56)', async () => {
  const { ClaudeTransport } = await import('../dist/runtime/index.js');
  const { tmpdir } = await import('node:os');
  const transport = new ClaudeTransport(process.execPath, tmpdir(), process.env);
  const seen = [];
  transport.onNotification((method, params) => (method === 'turn/started' || method === 'turn/completed') && seen.push([method, params.turn.id]));
  const assistant = (parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id: `m${seen.length}`, content: [{ type: 'text', text: 'CI is green' }] } });
  // A sub-agent's message starts nothing; the session's own does, once.
  transport.handle(assistant('tool-1'));
  transport.handle(assistant());
  transport.handle(assistant());
  transport.handle({ type: 'result', subtype: 'success', is_error: false });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map(([method]) => method), ['turn/started', 'turn/completed']);
  assert.equal(seen[0][1], seen[1][1]);
});

test('ALP follows a turn the runtime started by itself: its tools work and its end is a turn end', async t => {
  const { runtime, main, runLog } = await tree(t, { options: () => ({ checkInMs: 0 }) });
  const events = [];
  runtime.onEvent(envelope => envelope.sessionId === 'root' && events.push(envelope.event));
  main.finish('Watching CI in the background.');
  await until(() => events.some(event => event.type === 'turn.ended'), 'the first turn to end');
  // The background command ends; Claude answers in a turn ALP did not start.
  main.turnId = 'native-turn';
  main.notification('turn/started', { threadId: main.threadId, turn: { id: 'native-turn' } });
  assert.deepEqual(events.at(-1), { type: 'turn.started', turnId: 'native-turn', origin: 'runtime' });
  const board = await main.call('alp_board', {});
  assert.equal(board.error, undefined, JSON.stringify(board));
  main.finish('CI is green; closing the task.');
  await until(() => events.filter(event => event.type === 'turn.ended').length === 2, 'the native turn to end');
  assert.equal(events.at(-1).turnId, 'native-turn');
  // A turn ALP knows of is not taken over by one the runtime reports.
  await runtime.prompt('root', { clientMessageId: 'm2', delivery: 'auto', content: [{ type: 'text', text: 'Next' }] });
  main.notification('turn/started', { threadId: main.threadId, turn: { id: 'late' } });
  assert.notEqual(events.at(-1).turnId, 'late');
  assert.ok((await runLog()).length);
});
