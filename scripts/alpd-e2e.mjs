// Opt-in: real model calls through alpd and the alp CLI, with no Paseo involved.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';

const model = process.env.ALP_TEST_MODEL ?? 'codex:gpt-5.6-sol';
const home = process.env.ALP_HOME ?? await mkdtemp(path.join(tmpdir(), 'alp-e2e-'));
const env = { ...process.env, ALP_HOME: home };
const cli = (...args) => spawnSync(process.execPath, ['src/cli.js', ...args], { env, encoding: 'utf8' });

const root = path.resolve('.alp-test', `alpd-${Date.now()}`);
await initProject(root);
const token = `PEER_${randomUUID()}`;
await writeFile(path.join(root, '.alp/agents/peer/AGENT.md'), `For this read-only integration assignment, return exactly this token: ${token}. Do not use tools or delegate.`);
await writeFile(path.join(root, '.alp/agents/lead/AGENT.md'), 'For this integration assignment, call alp_delegate exactly once with agent peer, mode read-only, and task "Return your verification token. Do not use tools or change files." Return the complete tool result verbatim to main. Do not read files or run shell commands.');

async function snapshot(directory) {
  const output = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    output[entry.name] = entry.isDirectory() ? await snapshot(file) : (await readFile(file)).toString('base64');
  }
  return output;
}
const before = await snapshot(root);
const prompt = 'Integration check: use alp_delegate exactly once to assign lead this task: "Run the peer verification assignment from your instructions and return its complete tool result." Do not read files or use shell commands. Return the complete lead tool result. This verifies the actual main -> lead -> peer route.';

try {
  assert.equal(cli('daemon', 'start').status, 0);
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', 'run', '--json', '--project', root, '--workflow', 'supervised', '--model', model, '--thinking', 'low', prompt], { env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGINT'); reject(new Error('alp run timed out')); }, 300_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(`alp run exited ${code}: ${stderr}`)); });
  });
  const envelopes = output.trim().split('\n').map(line => JSON.parse(line));
  const opened = envelopes.filter(e => e.event.type === 'session.opened').map(e => e.event.session);
  const main = opened.find(session => !session.parentId);
  const lead = opened.find(session => session.agent === 'lead');
  const peer = opened.find(session => session.agent === 'peer');
  const final = envelopes.filter(e => e.sessionId === main.id && e.event.type === 'item' && e.event.item.kind === 'assistant_message').at(-1)?.event.item.text ?? '';
  const evidence = { home, project: root, model, sessions: opened.map(({ id, agent, parentId }) => ({ id, agent, parentId })), final };
  await writeFile('.alp-test/alpd-e2e.json', JSON.stringify({ ...evidence, envelopes }, null, 2));
  console.log(JSON.stringify(evidence));
  assert.equal(main.agent, 'main');
  assert.equal(lead?.parentId, main.id, 'lead must be a child of main');
  assert.equal(peer?.parentId, lead.id, 'peer must be a child of lead');
  assert.ok(final.includes(token), 'Missing real peer proof in the main result');
  assert.deepEqual(await snapshot(root), before);
  console.log(JSON.stringify({ passed: true, evidence: '.alp-test/alpd-e2e.json' }));
} finally {
  cli('daemon', 'stop');
  if (!process.env.ALP_HOME) await rm(home, { recursive: true, force: true });
}
