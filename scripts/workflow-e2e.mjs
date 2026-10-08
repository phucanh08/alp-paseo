// Opt-in: uses real models and an already running Paseo daemon.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { initProject } from '../src/core/init.js';

const workflow = process.argv[2] ?? 'smart';
const provider = process.env.ALP_TEST_PROVIDER ?? 'alp/codex:gpt-6.1-sol';
const runtime = provider.includes('/claude:') ? 'claude' : 'codex';
assert.ok(['smart', 'supervised'].includes(workflow));
const root = path.resolve('.alp-test', `workflow-${workflow}-${Date.now()}`);
await initProject(root);
const token = `PROOF_${randomUUID()}`;
await writeFile(path.join(root, 'proof.txt'), token);
async function snapshot(directory) {
  const output = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    output[entry.name] = entry.isDirectory() ? await snapshot(file) : await readFile(file, 'base64');
  }
  return output;
}
const before = await snapshot(root);
const driver = new DaemonClient({ url: process.env.ALP_TEST_PASEO_URL ?? 'ws://127.0.0.1:6767/ws', clientId: `alp-workflow-${Date.now()}` });
const client = createPaseoApi(driver);
let agent;
try {
  await driver.connect();
  agent = await client.agents.create({ cwd: root, title: `ALP ${workflow} smoke test`, config: {
    provider, modeId: 'read-only', thinkingOptionId: 'low',
    options: { workflow },
  } });
  console.log(JSON.stringify({ workflow, project: root, agent: agent.id }));
  const assignment = 'Use alp_delegate to assign peer to read proof.txt and return its exact content. Choose an explicit available model and effort for peer. After peer returns, use alp_delegate to reviewer with an explicit brief: review the existing proof.txt as the only supplied artifact (there is intentionally no git diff), verify it is a single PROOF_ token, and return its exact content and any finding. No files may be changed. Do not run unrelated tests or git commands. Return the token and actual handoffs.';
  const prompt = workflow === 'supervised'
    ? `Bounded integration test: delegate exactly one lead and pass it this complete brief verbatim, including the reviewer step: ${assignment} Lead calls both peer and reviewer. Main must not call peer or reviewer directly. Return the proof token and handoffs.`
    : `Bounded integration test in Smart. ${assignment} Also ask oracle once to confirm the simplest approach to verifying a single token file. Choose the highest-capability available model from your runtime catalog with an explicit modelReason and effort; do not inherit a default or silently downgrade. Include the oracle handoff. Do not create lead. Finish once these calls complete.`;
  const result = await agent.run(prompt, { timeoutMs: 360_000 });
  const children = await driver.listProviderSubagents(agent.id);
  const timeline = await agent.timeline.refetch({ limit: 100 });
  const evidence = { workflow, provider, project: root, agent: agent.id, result, children, timeline };
  const evidencePath = `.alp-test/workflow-${workflow}-${runtime}-e2e.json`;
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ workflow, status: result.status, error: result.error, children: children.subagents?.map(child => ({ title: child.title, status: child.status, parent: child.parentSubagentId })), evidencePath }));
  assert.ok(result.lastMessage?.includes(token), 'Missing real peer proof');
  assert.equal(children.error, null);
  const find = name => children.subagents.find(child => child.title?.startsWith(`ALP ${name}`));
  assert.ok(find('peer'), 'No real peer');
  assert.ok(find('reviewer'), 'No real reviewer');
  for (const child of children.subagents) assert.equal(child.status, 'completed', JSON.stringify(child));
  if (workflow === 'smart') {
    assert.equal(find('lead'), undefined);
    assert.ok(find('oracle'), 'No real oracle');
    assert.equal(find('peer').parentSubagentId, null);
  } else {
    assert.ok(find('lead'));
    assert.equal(find('peer').parentSubagentId, find('lead').id);
    assert.equal(find('reviewer').parentSubagentId, find('lead').id);
  }
  assert.deepEqual(await snapshot(root), before);
  console.log(JSON.stringify({ workflow, passed: true, evidencePath }));
} finally {
  if (agent) await agent.archive().catch(() => {});
  await client.dispose();
  await driver.close();
}
