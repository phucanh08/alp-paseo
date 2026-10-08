// Opt-in real Claude Code check without depending on daemon provider-session generations.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createProvider } from '../plugins/paseo/server/dist/index.js';
import { PROVIDER_CAPABILITIES } from '@getpaseo/plugin/server/provider';

// Default to an ignored fixture: the provider installs ALP starter files into the project.
const root = path.resolve(process.env.ALP_TEST_ROOT ?? path.join('.alp-test', `claude-runtime-${Date.now()}`));
await mkdir(root, { recursive: true });
const prompt = process.env.ALP_TEST_PROMPT ?? 'Reply with exactly: CLAUDE_ALP_OK';
const expected = process.env.ALP_TEST_EXPECT ?? 'CLAUDE_ALP_OK';
const provider = createProvider({ embedded: true });
const connection = await provider.connect({
  versions: [1],
  capabilities: PROVIDER_CAPABILITIES,
});
const events = [];
connection.onEvent((event) => events.push(event));

try {
  await connection.send({
    type: 'session.open',
    requestId: 'open',
    sessionId: 'claude-smoke',
    history: 'skip',
    config: {
      cwd: root,
      env: {},
      mcpServers: {},
      settings: {},
      persist: false,
      model: 'claude:sonnet',
      mode: 'read-only',
      thinkingOption: 'low',
    },
  });
  assert.ok(events.some((event) => event.type === 'session.ready'));

  await connection.send({
    type: 'session.prompt',
    sessionId: 'claude-smoke',
    prompt: {
      clientMessageId: 'smoke-prompt',
      delivery: 'auto',
      input: {
        type: 'message',
        content: [{ type: 'text', text: prompt }],
      },
    },
  });

  const deadline = Date.now() + 120_000;
  while (
    Date.now() < deadline &&
    !events.some((event) => event.type === 'session.turn' && event.sessionId === 'claude-smoke' && ['completed', 'failed'].includes(event.state))
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const terminal = events.findLast((event) => event.type === 'session.turn' && event.sessionId === 'claude-smoke');
  const response = events
    .filter((event) => event.type === 'timeline.item' && event.sessionId === 'claude-smoke' && event.item.type === 'assistant_message')
    .at(-1)?.item.text;
  console.log(JSON.stringify({ terminal, response }));
  assert.equal(terminal?.state, 'completed');
  assert.match(response ?? '', new RegExp(expected));
} finally {
  await connection.close();
}
