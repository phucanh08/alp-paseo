// Opt-in: uses real models and an already running Paseo daemon with the rebuilt plugin.
// Scenarios: ask (question/answer), wake (idle requester woken by mail), steer (mail into a busy turn),
// long (alp_ask and alp_wait held for minutes; ALP_TEST_WAIT_SECONDS, default 360).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createPaseoApi } from '@getpaseo/client';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { initProject } from '../src/core/init.js';

const scenario = process.argv[2] ?? 'ask';
const provider = process.env.ALP_TEST_PROVIDER ?? 'alp/codex:gpt-6.1-sol';
const runtime = provider.includes('/claude:') ? 'claude' : 'codex';
const runLogDir = process.env.ALP_RUN_LOG_DIR || path.join(homedir(), '.alp', 'runs');
assert.ok(['ask', 'wake', 'steer', 'long'].includes(scenario));
const waitSeconds = Number(process.env.ALP_TEST_WAIT_SECONDS ?? 360);

const root = path.resolve('.alp-test', `mailbox-${scenario}-${runtime}-${Date.now()}`);
await initProject(root);
const token = `PROOF_${randomUUID()}`;
const noteToken = `NOTE_${randomUUID()}`;
await writeFile(path.join(root, 'proof.txt'), token);

const rules = 'Bounded integration test of ALP mail. Do not edit files, run tests, or use git. Use low effort for peers.';
const prompts = {
  ask: `${rules} Use alp_delegate with wait false to assign peer this brief: "Call alp_ask exactly once with the question: Which token should I report? After the answer arrives, file alp_handoff with outcome complete and a summary containing exactly the answered token, then end your turn." Then call alp_wait. When the question arrives, answer it with alp_send kind answer, replyTo the question id, and body exactly ${token}. Then alp_wait for the result and reply with the token from the peer handoff.`,
  wake: `${rules} Use alp_delegate with wait false to assign peer this brief: "Read ALP.md, then .alp/settings.json, then proof.txt, one at a time. File alp_handoff with outcome complete and a summary containing the exact content of proof.txt, then end your turn." Right after alp_delegate returns, end your turn by replying only "Delegated." Do not call alp_wait. Later, when ALP mail delivers the peer result, reply with the exact content of proof.txt from the handoff.`,
  long: `${rules} Use alp_delegate with wait false to assign peer this brief: "Call alp_ask exactly once with the question: Which token should I report? After the answer arrives, file alp_handoff with outcome complete and a summary containing exactly the answered token, then end your turn." Then call alp_wait. When the question arrives, do not answer yet: first call alp_wait with timeoutMs ${waitSeconds * 1000} (it returns no events, because the peer is waiting for you). Only after that returns, answer with alp_send kind answer, replyTo the question id, and body exactly ${token}. Then alp_wait for the result and reply with the token from the peer handoff.`,
  steer: `${rules} First, use alp_delegate with wait false to assign peer this brief: "Immediately call alp_send with to parent, kind note, and body exactly ${noteToken}. Then read proof.txt, file alp_handoff with outcome complete and a summary containing its exact content, and end your turn." Second, without calling alp_wait, use alp_delegate (waiting) to assign another peer: "Read ALP.md, then .alp/settings.json, then proof.txt, one at a time, and file alp_handoff summarizing what each contains." After it returns, alp_wait for the first peer's result. Reply with the note token you received by ALP mail and the content of proof.txt.`,
};

const text = item => item?.text ?? '';
async function runLog() {
  for (const name of await readdir(runLogDir).catch(() => [])) {
    const lines = (await readFile(path.join(runLogDir, name), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (lines.some(line => line.project === root)) return lines;
  }
  return [];
}

const driver = new DaemonClient({ url: process.env.ALP_TEST_PASEO_URL ?? 'ws://127.0.0.1:6767/ws', clientId: `alp-mailbox-${Date.now()}` });
const client = createPaseoApi(driver);
let agent;
try {
  await driver.connect();
  agent = await client.agents.create({ cwd: root, title: `ALP mailbox ${scenario} smoke test`, config: {
    provider, modeId: 'read-only', thinkingOptionId: 'low', options: { workflow: 'smart' },
  } });
  console.log(JSON.stringify({ scenario, runtime, project: root, agent: agent.id }));
  const result = await agent.run(prompts[scenario], { timeoutMs: scenario === 'long' ? (4 * waitSeconds + 600) * 1000 : 420_000 });

  // Mail can wake the requester after run() returns; settle on the expected final message.
  const expected = scenario === 'steer' ? [noteToken, token] : [token];
  let entries = [];
  const deadline = Date.now() + (scenario === 'long' ? 2 * waitSeconds * 1000 : 0) + 300_000;
  for (;;) {
    entries = (await agent.timeline.refetch({ limit: 300 })).entries ?? [];
    const messages = entries.filter(entry => entry.item.type === 'assistant_message');
    const last = messages.at(-1);
    const children = await driver.listProviderSubagents(agent.id);
    const idle = !children.subagents?.some(child => child.status === 'running');
    if (idle && last && expected.every(value => text(last.item).includes(value))) break;
    if (Date.now() > deadline) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  const children = await driver.listProviderSubagents(agent.id);
  const log = await runLog();
  const mailInputs = entries.filter(entry => entry.item.type === 'user_message' && /^alp-(mail|wake)-/.test(entry.item.clientMessageId ?? ''));
  const evidencePath = `.alp-test/mailbox-${scenario}-${runtime}-e2e.json`;
  await writeFile(evidencePath, JSON.stringify({ scenario, provider, project: root, agent: agent.id, result, children, log, timeline: entries }, null, 2));
  const mail = log.filter(line => line.event === 'mail').map(line => ({ kind: line.kind, from: line.from, id: line.id, body: line.body, ts: line.ts }));
  const delivery = mailInputs.map(entry => entry.item.clientMessageId.split('-').slice(0, 2).join('-'));
  const finalText = text(entries.filter(entry => entry.item.type === 'assistant_message').at(-1)?.item);
  console.log(JSON.stringify({ scenario, runtime, mail, delivery, final: finalText.slice(0, 300), children: children.subagents?.map(child => ({ title: child.title, status: child.status })), evidencePath }));

  for (const value of expected) assert.ok(finalText.includes(value), `Final message lacks ${value}`);
  for (const child of children.subagents) assert.equal(child.status, 'completed', JSON.stringify(child));
  const finished = log.filter(line => line.event === 'assignment.finished');
  assert.ok(finished.length >= 1 && finished.every(line => line.status === 'completed'), 'Assignments did not all complete');
  if (scenario === 'ask' || scenario === 'long') {
    assert.ok(mail.some(line => line.kind === 'question' && line.from === 'peer'), 'No question mail');
    assert.ok(mail.some(line => line.kind === 'answer' && line.body === token), 'No answer mail');
    assert.ok(finished.some(line => line.handoff?.summary?.includes(token)), 'Answer did not reach the peer handoff');
  }
  if (scenario === 'long') {
    // The requester's alp_wait times out while the child's alp_ask waits, so both calls are held.
    const at = kind => Date.parse(mail.find(line => line.kind === kind).ts);
    const held = (at('answer') - at('question')) / 1000;
    console.log(JSON.stringify({ scenario, runtime, heldSeconds: held }));
    assert.ok(held >= waitSeconds, `alp_ask and alp_wait were held only ${held} s`);
  }
  if (scenario === 'wake') assert.ok(delivery.includes('alp-wake'), `Requester was not woken (delivery: ${delivery.join(', ') || 'tool calls only'})`);
  if (scenario === 'steer') {
    assert.ok(mail.some(line => line.kind === 'note' && line.body === noteToken), 'No note mail');
    assert.ok(delivery.length, 'Note was not delivered into a turn');
  }
  console.log(JSON.stringify({ scenario, runtime, passed: true, evidencePath }));
} finally {
  if (agent) await agent.archive().catch(() => {});
  await client.dispose();
  await driver.close();
}
