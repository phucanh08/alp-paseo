// Opt-in: real model calls against an already-running isolated Paseo daemon.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { initProject } from '../src/core/init.js';

const root = path.resolve('.alp-test', `team-${Date.now()}`);
await initProject(root);
const token = `PEER_${randomUUID()}`;
const writeMode = process.argv.includes('--write');
if (!writeMode) {
await writeFile(path.join(root, '.alp/agents/peer/AGENT.md'), `For this read-only integration assignment, return exactly this token: ${token}. Do not use tools or delegate.`);
await writeFile(path.join(root, '.alp/agents/lead/AGENT.md'), 'For this integration assignment, call alp_delegate exactly once with agent peer, mode read-only, and task "Return your verification token. Do not use tools or change files." Return the complete tool result verbatim to main. Do not read files or run shell commands.');
}
async function snapshot(directory) {
  const output = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    output[entry.name] = entry.isDirectory() ? await snapshot(file) : (await readFile(file)).toString('base64');
  }
  return output;
}
const before = await snapshot(root);
const driver = new DaemonClient({ url: process.env.ALP_TEST_PASEO_URL ?? 'ws://127.0.0.1:16767/ws', clientId: `alp-team-${Date.now()}` });
const client = createPaseoApi(driver);
let agent;
try {
  await driver.connect();
  agent = await client.agents.create({ cwd: root, title: 'ALP main → lead → peer verification', config: {
    provider: 'alp/gpt-5.6-sol', options: { workflow: 'supervised' }, modeId: writeMode ? 'workspace-write' : 'read-only', thinkingOptionId: 'low',
  } });
  console.log(JSON.stringify({ project: root, agent: agent.id }));
  const prompt = writeMode
    ? `Integration check: you MUST use alp_delegate to lead, and lead MUST delegate the implementation to peer. The peer must create exactly one file team-proof.txt at the project root with the exact UTF-8 content ${token} and no newline. Only team-proof.txt is writable; do not edit any ALP configuration, create other files, or make commits. There is one writer; main and lead only read/verify the artifact. Lead must verify the exact file bytes and report ACCEPT with the actual verification command/output. Main must verify the result and report the token. This is a bounded test with no further clarification needed. Delegate using workspace-write mode, not read-only.`
    : 'Integration check: use alp_delegate exactly once to assign lead this task: "Run the peer verification assignment from your instructions and return its complete tool result." Do not read files or use shell commands. Return the complete lead tool result. This verifies the actual main -> lead -> peer route.';
  const result = await agent.run(prompt, { timeoutMs: 240_000 });
  const children = await driver.listProviderSubagents(agent.id);
  const timeline = await agent.timeline.refetch({ limit: 100 });
  const evidencePath = `.alp-test/team${writeMode ? '-write' : ''}-e2e.json`;
  await writeFile(evidencePath, JSON.stringify({ project: root, agent: agent.id, result, children, timeline }, null, 2));
  assert.ok(result.lastMessage?.includes(token), JSON.stringify(result));
  const evidence = JSON.stringify(children);
  assert.match(evidence, /ALP lead/);
  assert.match(evidence, /ALP peer/);
  assert.equal(children.error, null);
  const lead = children.subagents.find(child => child.title?.startsWith('ALP lead'));
  const peer = children.subagents.find(child => child.title?.startsWith('ALP peer'));
  assert.equal(lead.parentSubagentId, null);
  assert.equal(peer.parentSubagentId, lead.id);
  assert.equal(lead.status, 'completed');
  assert.equal(peer.status, 'completed');
  const after = await snapshot(root);
  if (writeMode) {
    assert.equal(await readFile(path.join(root, 'team-proof.txt'), 'utf8'), token);
    delete after['team-proof.txt'];
  }
  assert.deepEqual(after, before);
  console.log(JSON.stringify({ passed: true, response: result.lastMessage, evidence: evidencePath }));
} finally {
  if (agent) await agent.archive().catch(() => {});
  await client.dispose();
  await driver.close();
}
