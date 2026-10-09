// Opt-in: real model calls. A peer asks the user for a code word with alp_ask to: "user";
// the answer comes from the alp CLI (mode cli, no Paseo) or from Paseo's question prompt
// (mode paseo), and has to reach main's final message.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';

const mode = process.argv[2] ?? 'cli';
assert.ok(['cli', 'paseo'].includes(mode), 'usage: human-e2e.mjs cli|paseo');
const model = process.env.ALP_TEST_MODEL ?? 'codex:gpt-5.6-sol';
const word = `ORCHID-${randomUUID().slice(0, 8)}`;
const root = path.resolve('.alp-test', `human-${mode}-${Date.now()}`);
await initProject(root);
await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'smart', maxPeers: 2 } }));
await writeFile(path.join(root, '.alp/agents/peer/AGENT.md'), 'For this integration assignment: call alp_ask exactly once with to "user" and question "What is the code word?". Then call alp_handoff with outcome complete and the answer verbatim as summary, and end with the answer as your final message. Do not use any other tool.');
const prompt = 'Integration check: call alp_delegate exactly once with agent peer, mode read-only and task "Ask the user for the code word, as your instructions say, and return it." Do not ask the user yourself and do not use other tools. Reply with the code word the peer returns, verbatim.';

async function cli() {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-human-e2e-'));
  const env = { ...process.env, ALP_HOME: home, ALP_RUN_LOG_DIR: path.join(home, 'runs') };
  const alp = (...args) => spawnSync(process.execPath, ['src/cli.js', ...args], { env, encoding: 'utf8' });
  try {
    assert.equal(alp('daemon', 'start').status, 0);
    const evidence = { mode, model, project: root, word };
    const envelopes = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['src/cli.js', 'run', '--json', '--project', root, '--model', model, '--thinking', 'low', prompt], { env });
      const seen = [];
      let buffer = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGINT'); reject(new Error('alp run timed out')); }, 600_000);
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.stdout.on('data', chunk => {
        buffer += chunk;
        for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
          const envelope = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          seen.push(envelope);
          if (envelope.event.type !== 'question') continue;
          // Another terminal sees the question, the dashboard shows who waits, and the user answers by id prefix.
          const { question } = envelope.event;
          evidence.question = question;
          evidence.listed = JSON.parse(alp('questions', '--json').stdout);
          evidence.top = alp('top', '--once').stdout;
          evidence.answer = alp('answer', question.id.slice(0, 6), word);
        }
      });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(seen) : reject(new Error(`alp run exited ${code}: ${stderr}`)); });
    });
    const main = envelopes.find(e => e.event.type === 'session.opened' && !e.event.session.parentId).sessionId;
    evidence.final = envelopes.filter(e => e.sessionId === main && e.event.type === 'item' && e.event.item.kind === 'assistant_message').at(-1)?.event.item.text ?? '';
    evidence.resolved = envelopes.find(e => e.event.type === 'question.resolved')?.event;
    evidence.log = alp('log', main).stdout;
    await writeFile('.alp-test/human-cli-e2e.json', JSON.stringify({ ...evidence, envelopes }, null, 2));
    console.log(JSON.stringify({ ...evidence, top: evidence.top.split('\n'), answer: evidence.answer.stdout.trim(), log: evidence.log.split('\n') }));
    assert.equal(evidence.question?.agent, 'peer');
    assert.ok(evidence.listed.some(question => question.id === evidence.question.id), 'alp questions lists it');
    assert.match(evidence.top, /peer\s+waiting_user/);
    assert.equal(evidence.answer.status, 0, evidence.answer.stderr);
    assert.deepEqual({ outcome: evidence.resolved?.outcome, answer: evidence.resolved?.answer }, { outcome: 'answered', answer: word });
    assert.ok(evidence.final.includes(word), 'the answer reaches main');
    assert.match(evidence.log, /peer asks the user/);
    console.log(JSON.stringify({ passed: true, evidence: '.alp-test/human-cli-e2e.json' }));
  } finally {
    alp('daemon', 'stop');
    await rm(home, { recursive: true, force: true });
  }
}

async function paseo() {
  const { createPaseoApi } = await import('@getpaseo/client');
  const { DaemonClient } = await import('@getpaseo/client/internal/daemon-client');
  const provider = process.env.ALP_TEST_PROVIDER ?? `alp/${model}`;
  const driver = new DaemonClient({ url: process.env.ALP_TEST_PASEO_URL ?? 'ws://127.0.0.1:16767/ws', clientId: `alp-human-${Date.now()}` });
  const client = createPaseoApi(driver);
  let agent;
  const requests = [];
  try {
    await driver.connect();
    agent = await client.agents.create({ cwd: root, title: 'ALP human channel smoke test', config: { provider, modeId: 'read-only', thinkingOptionId: 'low', options: { workflow: 'smart' } } });
    // run() stops when the agent needs attention; the user answers in Paseo's question prompt on the root agent.
    let result = await agent.run(prompt, { timeoutMs: 420_000 });
    for (let round = 0; result.status === 'permission' && round < 20; round++) {
      // A snapshot taken just after answering can still list the question; answer each once.
      for (const request of result.final?.pendingPermissions ?? []) {
        if (requests.some(seen => seen.id === request.id)) continue;
        requests.push(request);
        await agent.respondToPermission({ requestId: request.id, response: { behavior: 'allow', updatedInput: { answers: { Answer: word } } } });
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      result = await agent.waitForFinish(420_000);
    }
    let final = '';
    for (const deadline = Date.now() + 300_000; Date.now() < deadline;) {
      const entries = (await agent.timeline.refetch({ limit: 300 })).entries ?? [];
      const last = entries.filter(entry => entry.item.type === 'assistant_message').at(-1)?.item;
      final = last?.text ?? last?.content ?? '';
      if (final.includes(word)) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    const children = await driver.listProviderSubagents(agent.id);
    const evidence = { mode, provider, project: root, agent: agent.id, word, requests, final, children: children.subagents?.map(child => ({ title: child.title, status: child.status })) };
    await writeFile('.alp-test/human-paseo-e2e.json', JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
    assert.equal(requests.length, 1, 'one question prompt in Paseo');
    assert.equal(requests[0].kind, 'question');
    assert.equal(requests[0].title, 'peer asks you');
    assert.ok(final.includes(word), 'the answer reaches main');
    console.log(JSON.stringify({ passed: true, evidence: '.alp-test/human-paseo-e2e.json' }));
  } finally {
    if (agent) await agent.archive().catch(() => {});
    await client.dispose();
    await driver.close();
  }
}

await (mode === 'cli' ? cli() : paseo());
