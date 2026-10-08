// Opt-in: real model calls. Stops an isolated Paseo daemon mid-delegation and checks that
// alpd finishes the tree on its own. Requires ALP_TEST_PASEO_HOME (the isolated Paseo home,
// which this script stops) and the ALP_HOME / ALP_RUN_LOG_DIR that Paseo's alpd uses.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { initProject } from '../src/core/init.js';
import { alpHome, connect, readLock } from '../src/client/index.js';

const paseoHome = process.env.ALP_TEST_PASEO_HOME;
const runLogDir = process.env.ALP_RUN_LOG_DIR;
assert.ok(paseoHome && process.env.ALP_HOME && runLogDir, 'Set ALP_TEST_PASEO_HOME, ALP_HOME and ALP_RUN_LOG_DIR');
const provider = process.env.ALP_TEST_PROVIDER ?? 'alp/codex:gpt-6.1-sol';
const until = async (check, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 1000)); }
  throw new Error(`Timed out waiting for ${label}`);
};

const root = path.resolve('.alp-test', `detach-${Date.now()}`);
await initProject(root);
const token = `PEER_${randomUUID()}`;
await writeFile(path.join(root, '.alp/agents/peer/AGENT.md'), `For this read-only integration assignment, first run the shell command \`sleep 45\`, then return exactly this token: ${token}. Do not delegate.`);
await writeFile(path.join(root, '.alp/agents/lead/AGENT.md'), 'For this integration assignment, call alp_delegate exactly once with agent peer, mode read-only, and task "Follow your instructions and return your verification token. Do not change files." Return the complete tool result verbatim to main. Do not read files or run shell commands yourself.');

const driver = new DaemonClient({ url: process.env.ALP_TEST_PASEO_URL ?? 'ws://127.0.0.1:16767/ws', clientId: `alp-detach-${Date.now()}` });
const client = createPaseoApi(driver);
await driver.connect();
const agent = await client.agents.create({ cwd: root, title: 'ALP viewer detach check', config: { provider, options: { workflow: 'supervised' }, modeId: 'read-only', thinkingOptionId: 'low' } });
console.log(JSON.stringify({ project: root, agent: agent.id }));
void agent.run('Integration check: use alp_delegate exactly once to assign lead this task: "Run the peer verification assignment from your instructions and return its complete tool result." Do not read files or use shell commands. Return the complete lead tool result.', { timeoutMs: 600_000 }).catch(() => {});

const alpd = await connect((await readLock(alpHome())).socket);
const peer = await until(async () => (await alpd.request('session.list')).sessions.find(session => session.agent === 'peer'), 240_000, 'the peer to start');
const rootId = (await alpd.request('session.list')).sessions.find(session => !session.parentId && session.projectRoot === root)?.id;
assert.ok(rootId, 'root session is live in alpd');

// The viewer goes away while peer still works.
await driver.close().catch(() => {});
const stoppedAt = new Date().toISOString();
const stop = spawnSync('paseo', ['daemon', 'stop', '--home', paseoHome], { encoding: 'utf8' });
assert.equal(stop.status, 0, stop.stderr);
console.log(JSON.stringify({ paseoStoppedAt: stoppedAt, peer: peer.id, root: rootId }));

// alpd finishes the tree, then closes the root because no viewer is attached.
await until(async () => !(await alpd.request('session.list')).sessions.some(session => session.id === rootId), 420_000, 'the tree to finish');
alpd.close();
const log = (await readFile(path.join(runLogDir, `${rootId.replace(/[^\w.-]/g, '_')}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const finished = log.filter(entry => entry.event === 'assignment.finished');
await writeFile('.alp-test/viewer-detach-e2e.json', JSON.stringify({ project: root, rootId, stoppedAt, log }, null, 2));
const peerDone = finished.find(entry => entry.agent === 'peer');
const leadDone = finished.find(entry => entry.agent === 'lead');
assert.equal(peerDone?.status, 'completed', JSON.stringify(finished));
assert.equal(leadDone?.status, 'completed', JSON.stringify(finished));
assert.ok(peerDone.ts > stoppedAt && leadDone.ts > stoppedAt, 'assignments finished after Paseo stopped');
assert.ok(JSON.stringify(leadDone).includes(token), 'lead result carries the peer token');
console.log(JSON.stringify({ passed: true, evidence: '.alp-test/viewer-detach-e2e.json' }));
