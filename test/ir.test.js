import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateSettings, normalizeMcp, validateResolvedAgent } from '../src/core/validation.js';

test('resolved IR serializes and is consumed by a provider-neutral fake', () => {
  const root = path.resolve('fixture');
  const agent = validateResolvedAgent({ name: 'main', projectRoot: root, instructions: { project: 'P', agent: 'A' }, skills: [{ name: 'demo', path: path.join(root, 'SKILL.md') }], hooks: [], runtime: { model: 'test-model' }, mcp: normalizeMcp({ mcpServers: { local: { command: './bin/server', cwd: '.', args: ['--ready'] } } }, root, 'fixture') });
  const restored = JSON.parse(JSON.stringify(agent));
  assert.deepEqual(validateResolvedAgent(restored), agent);
  const fake = input => [input.instructions.project, input.instructions.agent].join('\n');
  assert.equal(fake(restored), 'P\nA');
  assert.ok(path.isAbsolute(agent.mcp.mcpServers.local.command));
  assert.equal(agent.mcp.mcpServers.local.cwd, root);
  assert.equal('settings' in agent, false);
});
test('settings runtime schema rejects malformed values', () => {
  for (const runtime of [null, [], 'x', { model: 2 }, { provider: '' }, { unexpected: true }]) assert.throws(() => validateSettings({ runtime }, 'settings.json'), { code: 'INVALID_SETTINGS' });
  assert.deepEqual(validateSettings({}, 'settings.json'), {});
});
test('MCP schema rejects invalid transport and malformed server fields', () => {
  for (const raw of [{ mcpServers: [] }, { mcpServers: null }, { mcpServers: { a: {} } }, { mcpServers: { a: { command: 'node', url: 'https://example.test' } } }, { mcpServers: { a: { command: 'node', args: [1] } } }, { mcpServers: { a: { url: 'file:///tmp/socket' } } }, { mcpServers: { a: { command: 'node', env: { A: 1 } } } }]) assert.throws(() => normalizeMcp(raw, path.resolve('.'), '.mcp.json'), { code: 'INVALID_MCP' });
  assert.equal(normalizeMcp({ mcpServers: { a: { command: 'node' } } }, path.resolve('.'), 'mcp').mcpServers.a.command, 'node');
});
test('IR rejects relative paths before adapter handoff', () => {
  assert.throws(() => validateResolvedAgent({ name: 'main', projectRoot: '.' }), { code: 'INVALID_RESOLVED_AGENT' });
});
