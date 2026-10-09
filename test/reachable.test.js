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
  const waiting = main.call('alp_delegate', { agent: 'peer', task: 'Do the long job', mode: 'read-only' });
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
  const { agents, main } = await tree(t, { options: () => ({ checkInMs: 0, silentForMs: 3_600_000 }) });
  for (const etaMinutes of [0, 1441, 1.5, '5']) {
    assert.match((await main.call('alp_delegate', { agent: 'peer', task: 'x', mode: 'read-only', etaMinutes })).error, /Invalid assignment/);
  }
  const real = Date.now;
  t.after(() => { Date.now = real; });
  const waiting = main.call('alp_delegate', { agent: 'peer', task: 'Quick fix', mode: 'read-only', etaMinutes: 1 });
  await until(() => agents[1]?.started.length, 'the peer to start');
  Date.now = () => real() + 61_000;
  const late = await waiting;
  assert.equal(late.status, 'running');
  assert.match(late.next, /A check-in, not a result/);
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
  assert.match(instructions, /Stay reachable while others work\. .*wait: false and etaMinutes/);
  const delegate = main.config.dynamicTools.find(tool => tool.name === 'alp_delegate');
  assert.equal(delegate.inputSchema.properties.etaMinutes.maximum, 1440);
});
