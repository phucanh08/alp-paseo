// Opt-in: real model calls. A tree created with the alp CLI is imported into an isolated
// Paseo daemon, which replays the root timeline and its children. Requires ALP_HOME to be
// the home that Paseo's alpd uses.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { initProject } from '../src/core/init.js';

assert.ok(process.env.ALP_HOME, 'Set ALP_HOME to the home of Paseo\'s alpd');
const model = process.env.ALP_TEST_MODEL ?? 'codex:gpt-5.6-sol';
const root = path.resolve('.alp-test', `import-${Date.now()}`);
await initProject(root);
const token = `PEER_${randomUUID()}`;
await writeFile(path.join(root, '.alp/agents/peer/AGENT.md'), `For this read-only integration assignment, return exactly this token: ${token}. Do not use tools or delegate.`);
await writeFile(path.join(root, '.alp/agents/lead/AGENT.md'), 'For this integration assignment, call alp_delegate exactly once with agent peer, mode read-only, and task "Return your verification token. Do not use tools or change files." Return the complete tool result verbatim to main. Do not read files or run shell commands.');

const run = spawnSync(process.execPath, ['src/cli.js', 'run', '--json', '--project', root, '--profile', 'cafe', '--model', model, '--thinking', 'low',
  'Integration check: use alp_delegate exactly once to assign lead this task: "Run the peer verification assignment from your instructions and return its complete tool result." Do not read files or use shell commands. Return the complete lead tool result.'],
  { env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
assert.equal(run.status, 0, run.stderr);
const envelopes = run.stdout.trim().split('\n').map(line => JSON.parse(line));
const rootId = envelopes.find(e => e.event.type === 'session.opened' && !e.event.session.parentId).sessionId;

const driver = new DaemonClient({ url: process.env.ALP_TEST_PASEO_URL ?? 'ws://127.0.0.1:16767/ws', clientId: `alp-import-${Date.now()}` });
await driver.connect();
let agentId;
try {
  const { entries } = await driver.fetchRecentProviderSessions({ cwd: root, providers: ['alp'] });
  const entry = entries.find(candidate => candidate.providerHandleId.includes(rootId));
  assert.ok(entry, `alpd root ${rootId} is offered for import: ${JSON.stringify(entries)}`);
  const agent = await driver.importAgent({ providerId: 'alp', providerHandleId: entry.providerHandleId, cwd: root });
  agentId = agent.id;
  const timeline = await driver.fetchAgentTimeline(agentId, { limit: 200 });
  const children = await driver.listProviderSubagents(agentId);
  const texts = JSON.stringify(timeline);
  const evidence = { project: root, rootId, entry, agentId, children: children.subagents?.map(child => ({ title: child.title, status: child.status, parent: child.parentSubagentId })) };
  await writeFile('.alp-test/import-e2e.json', JSON.stringify({ ...evidence, timeline }, null, 2));
  console.log(JSON.stringify(evidence));
  assert.ok(texts.includes(token), 'imported root timeline carries the peer token');
  const find = name => children.subagents.find(child => child.title?.startsWith(`ALP ${name}`));
  assert.ok(find('lead'), 'lead replayed as a subagent');
  assert.ok(find('peer'), 'peer replayed as a subagent');
  assert.equal(find('peer').parentSubagentId, find('lead').id);
  console.log(JSON.stringify({ passed: true, evidence: '.alp-test/import-e2e.json' }));
} finally {
  if (agentId) await driver.archiveAgent?.(agentId).catch(() => {});
  await driver.close();
}
