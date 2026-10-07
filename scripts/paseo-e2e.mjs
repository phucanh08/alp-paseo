// Opt-in integration: requires a running isolated daemon with the built ALP plugin.
// Uses real model inference. Never run this as part of the default unit tests.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createPaseoClient } from '@getpaseo/client';

const root = path.resolve('.alp-test', `project-${Date.now()}`);
const url = process.env.ALP_TEST_PASEO_URL ?? 'ws://127.0.0.1:16767/ws';
const cli = path.resolve(process.env.ALP_TEST_PASEO_CLI ?? '.tools/paseo/node_modules/@getpaseo/cli/bin/paseo');
for (const [file, content] of Object.entries({
  'ALP.md': 'For the ALP integration check, the project token is PROJECT_ORCHID. Do not use tools or modify files. Reply with only the project token and your agent token separated by a space.',
  '.alp/settings.json': JSON.stringify({ runtime: { model: 'gpt-5.6-sol', reasoning: 'low' } }),
  '.alp/agents/main/AGENT.md': 'Your agent token is AGENT_MAIN.',
  '.alp/agents/custom/AGENT.md': 'Your agent token is AGENT_CUSTOM.',
})) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}
async function snapshot(directory, prefix = '') {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(path.join(directory, entry.name), relative));
    else result[relative] = (await readFile(path.join(directory, entry.name))).toString('base64');
  }
  return result;
}
const before = await snapshot(root);
const client = createPaseoClient({ url, clientId: `alp-e2e-${Date.now()}` });
const agents = [];
const evidence = { project: root, model: 'gpt-5.6-sol', results: [] };
try {
  await client.connect();
  const models = await client.providers.listModels('alp', { cwd: root });
  assert.ok(!models.error, models.error);
  for (const name of ['main', 'custom']) {
    const agent = await client.agents.create({
      config: { provider: 'alp/gpt-5.6-sol', modeId: 'read-only', thinkingOptionId: 'low', ...(name === 'custom' ? { options: { agent: name } } : {}) },
      cwd: root, title: `ALP phase 5 ${name}`,
    });
    agents.push(agent);
    const result = await agent.run('Perform the ALP integration check now.', { timeoutMs: 120_000 });
    console.log(JSON.stringify({ agent: name, status: result.status, response: result.lastMessage, error: result.error }));
    assert.match(result.lastMessage ?? '', new RegExp(`PROJECT_ORCHID\\s+AGENT_${name.toUpperCase()}`));
    evidence.results.push({ agent: name, id: agent.id, status: result.status, response: result.lastMessage });
    if (name === 'main') {
      await promisify(execFile)(process.execPath, [cli, 'agent', 'reload', agent.id, '--host', new URL(url).host, '--json'], { timeout: 60_000, windowsHide: true });
      const resumed = await agent.run('Repeat the integration check after reload.', { timeoutMs: 120_000 });
      console.log(JSON.stringify({ reload: true, status: resumed.status, response: resumed.lastMessage, error: resumed.error }));
      assert.match(resumed.lastMessage ?? '', /PROJECT_ORCHID\s+AGENT_MAIN/);
      evidence.results.push({ reload: true, status: resumed.status, response: resumed.lastMessage });
    }
  }
  assert.deepEqual(await snapshot(root), before);
  evidence.projectFilesUnchanged = true;
  await writeFile('.alp-test/phase-5-e2e.json', JSON.stringify(evidence, null, 2));
} finally {
  for (const agent of agents) await agent.archive().catch(() => {});
  await client.close();
}
