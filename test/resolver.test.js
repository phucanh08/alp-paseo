import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveAgent, discoverAgents } from '../src/core/resolver.js';

async function fixture(t, files = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries({ '.alp/agents/main/AGENT.md': 'Main instructions', ...files })) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content);
  }
  return root;
}

test('main fallback and absent optional resources', async t => {
  const result = await resolveAgent(await fixture(t));
  assert.equal(result.name, 'main'); assert.equal(result.instructions.agent, 'Main instructions');
  assert.equal(result.instructions.project, ''); assert.deepEqual(result.skills, []); assert.deepEqual(result.hooks, []); assert.deepEqual(result.mcp, { mcpServers: {} });
});
test('filesystem discovery and explicit > configured > main precedence', async t => {
  const root = await fixture(t, { '.alp/settings.json': '{"defaultAgent":"writer"}', '.alp/agents/writer/AGENT.md': 'Write', '.alp/agents/checker/AGENT.md': 'Check', 'ALP.md': 'Project' });
  assert.deepEqual(await discoverAgents(root), ['checker', 'main', 'writer']);
  assert.equal((await resolveAgent(root)).name, 'writer');
  const result = await resolveAgent(root, { agent: 'checker' }); assert.equal(result.name, 'checker'); assert.equal(result.instructions.project, 'Project');
});
test('selected missing agent does not silently fall back', async t => {
  const root = await fixture(t, { '.alp/settings.json': '{"defaultAgent":"absent"}' });
  await assert.rejects(resolveAgent(root), { code: 'AGENT_NOT_FOUND' });
  await assert.rejects(resolveAgent(root, { agent: '../main' }), { code: 'INVALID_AGENT' });
});
for (const content of ['{', '[]', 'null', '{"defaultAgent":42}']) test(`reject malformed settings ${content}`, async t => {
  await assert.rejects(resolveAgent(await fixture(t, { '.alp/settings.json': content })), { code: 'INVALID_SETTINGS' });
});
test('reject malformed MCP with exact source path', async t => {
  const root = await fixture(t, { '.alp/agents/main/.mcp.json': '{' });
  await assert.rejects(resolveAgent(root), e => e.code === 'INVALID_MCP' && e.message.includes('.mcp.json'));
});
test('discover resources without injecting skill bodies', async t => {
  const root = await fixture(t, { '.alp/agents/main/skills/demo/SKILL.md': 'SECRET SKILL BODY', '.alp/agents/main/hooks/start.sh': 'echo hello', '.alp/agents/main/.mcp.json': '{"mcpServers":{}}' });
  const result = await resolveAgent(root);
  assert.equal(result.skills[0].name, 'demo'); assert.equal(result.hooks[0].name, 'start.sh');
  assert.equal(JSON.stringify(result).includes('SECRET SKILL BODY'), false);
});
test('agent folder requires AGENT.md', async t => {
  const root = await fixture(t, { '.alp/agents/empty/.keep': '' });
  await assert.rejects(resolveAgent(root, { agent: 'empty' }), { code: 'AGENT_INSTRUCTIONS_MISSING' });
});
