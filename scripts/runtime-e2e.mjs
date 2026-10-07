// Opt-in check of the real runtime behind the public provider connection.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createProvider } from '../plugins/paseo/server/dist/index.js';
const cwd = path.resolve('.alp-test', `runtime-${Date.now()}`);
await mkdir(path.join(cwd, '.alp', 'agents', 'main'), { recursive: true });
await writeFile(path.join(cwd, '.alp', 'agents', 'main', 'AGENT.md'), 'You are testing lifecycle operations. Do not use tools or change files.');
const connection = await createProvider().connect({ versions: [1], capabilities: ['prompt.message', 'prompt.steer', 'session.persistence'] });
const events = [];
connection.onEvent(event => events.push(event));
try {
  await connection.send({ type: 'session.open', requestId: 'open', sessionId: 'test', history: 'skip', config: {
    cwd, env: {}, mcpServers: {}, settings: {}, persist: false, model: 'gpt-5.6-sol', mode: 'read-only', thinkingOption: 'low',
  } });
  assert.ok(events.some(e => e.type === 'session.ready'), JSON.stringify(events));
  const prompt = (id, delivery, text) => ({ type: 'session.prompt', sessionId: 'test', prompt: { clientMessageId: id, delivery, input: { type: 'message', content: [{ type: 'text', text }] } } });
  await connection.send(prompt('first', 'auto', 'Explain the first 100 prime numbers, one paragraph per number.'));
  assert.ok(events.some(e => e.type === 'session.turn' && e.state === 'started'), JSON.stringify(events));
  await connection.send(prompt('steer', 'steer', 'Correction: focus on factorization instead.'));
  assert.equal(events.find(e => e.type === 'session.prompt_result' && e.clientMessageId === 'steer')?.result.type, 'steer', JSON.stringify(events));
  await connection.send({ type: 'session.interrupt', sessionId: 'test', requestId: 'cancel' });
  assert.ok(events.some(e => e.type === 'session.turn' && e.state === 'canceled'), JSON.stringify(events));
  assert.ok(events.some(e => e.type === 'request.completed' && e.requestId === 'cancel'));
  await connection.send({ type: 'session.close', sessionId: 'test', requestId: 'close' });
  assert.ok(events.some(e => e.type === 'session.closed'));
  const result = { model: 'gpt-5.6-sol', steering: 'passed', cancel: 'passed', close: 'passed', events: events.filter(e => e.type !== 'timeline.item') };
  await writeFile('.alp-test/runtime-e2e.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ steering: 'passed', cancel: 'passed', close: 'passed' }));
} finally { await connection.close(); }
