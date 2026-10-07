import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { upgradeProject } from '../src/core/upgrade.js';
import { resolveAgent } from '../src/core/resolver.js';
import { PaseoAdapter } from '../plugins/paseo/server/dist/index.js';

const expected = {
  main: ['bug-loop', 'goal-griller', 'prompt-leverage', 'sequence-execution-plan', 'smart-commits', 'xia'],
  lead: ['bug-loop', 'prompt-leverage', 'sequence-execution-plan', 'smart-commits', 'xia'],
  peer: ['bug-loop', 'smart-commits', 'xia'],
};
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('starter assigns the intended skills and copies all relative references into portable packages', async t => {
  const root = await fixture(t);
  await initProject(root);
  for (const [agent, names] of Object.entries(expected)) {
    const resolved = await resolveAgent(root, { agent });
    assert.deepEqual(resolved.skills.map(s => s.name), names);
    for (const skill of resolved.skills) {
      const body = await readFile(skill.path, 'utf8');
      const source = await readFile(new URL(`../templates/skills/${skill.name}/SKILL.md`, import.meta.url), 'utf8');
      assert.equal(body, source);
      for (const match of body.matchAll(/\]\((references\/[^)]+)\)/g)) {
        const installed = await readFile(path.join(path.dirname(skill.path), match[1]), 'utf8');
        const original = await readFile(new URL(`../templates/skills/${skill.name}/${match[1]}`, import.meta.url), 'utf8');
        assert.equal(installed, original);
      }
    }
  }
  const other = await fixture(t);
  await mkdir(path.join(other, '.alp/agents'), { recursive: true });
  await cp(path.join(root, '.alp/agents/peer'), path.join(other, '.alp/agents/researcher'), { recursive: true });
  const portable = await resolveAgent(other, { agent: 'researcher' });
  assert.deepEqual(portable.skills.map(s => s.name), expected.peer);
  for (const skill of portable.skills) assert.ok(skill.path.startsWith(other + path.sep));
  assert.ok(await readFile(path.join(other, '.alp/agents/researcher/skills/bug-loop/references/test-proof.md'), 'utf8'));
});

test('Paseo receives a skill index while bodies and supporting references stay lazy', async t => {
  const root = await fixture(t);
  await initProject(root);
  for (const agent of Object.keys(expected)) {
    const resolved = await resolveAgent(root, { agent });
    const compiled = await new PaseoAdapter().compile(resolved);
    for (const skill of resolved.skills) {
      assert.ok(compiled.material.instructions.includes(JSON.stringify(skill.path)));
      assert.equal(compiled.material.instructions.includes(await readFile(skill.path, 'utf8')), false);
    }
    const reference = await readFile(path.join(root, `.alp/agents/${agent}/skills/bug-loop/references/test-proof.md`), 'utf8');
    assert.equal(compiled.material.instructions.includes(reference), false);
  }
});

test('repeated init and upgrade preserve customized skills and fill missing resources', async t => {
  const root = await fixture(t);
  await initProject(root);
  const customPath = path.join(root, '.alp/agents/peer/skills/xia/SKILL.md');
  await writeFile(customPath, 'Custom research method');
  const reference = path.join(root, '.alp/agents/peer/skills/bug-loop/references/test-proof.md');
  await rm(reference);
  const result = await upgradeProject(root);
  assert.deepEqual(result.created, ['.alp/agents/peer/skills/bug-loop/references/test-proof.md']);
  assert.equal(await readFile(customPath, 'utf8'), 'Custom research method');
  assert.deepEqual((await initProject(root)).created, []);
});

test('upgrade recognizes shipped team-v1 instructions and backs up each role before adding skill guidance', async t => {
  const root = await fixture(t);
  await initProject(root);
  for (const role of Object.keys(expected)) {
    await cp(new URL(`./fixtures/team-v1/${role}/AGENT.md`, import.meta.url), path.join(root, `.alp/agents/${role}/AGENT.md`));
    await rm(path.join(root, `.alp/agents/${role}/skills`), { recursive: true });
  }
  const result = await upgradeProject(root);
  assert.deepEqual(result.updated, ['.alp/agents/main/AGENT.md', '.alp/agents/lead/AGENT.md', '.alp/agents/peer/AGENT.md']);
  for (const role of Object.keys(expected)) {
    const old = await readFile(new URL(`./fixtures/team-v1/${role}/AGENT.md`, import.meta.url), 'utf8');
    assert.equal(await readFile(path.join(result.backup, `.alp/agents/${role}/AGENT.md`), 'utf8'), old);
    const desired = await readFile(new URL(`../templates/agents/${role}/AGENT.md`, import.meta.url), 'utf8');
    assert.equal(await readFile(path.join(root, `.alp/agents/${role}/AGENT.md`), 'utf8'), desired);
    assert.deepEqual((await resolveAgent(root, { agent: role })).skills.map(s => s.name), expected[role]);
  }
  assert.deepEqual((await upgradeProject(root)).updated, []);
});

test('a customized team role is preserved even when its original version is known', async t => {
  const root = await fixture(t);
  await initProject(root);
  const old = await readFile(new URL('./fixtures/team-v1/lead/AGENT.md', import.meta.url), 'utf8');
  const custom = old + '\nProject-specific review rule.\n';
  await writeFile(path.join(root, '.alp/agents/lead/AGENT.md'), custom);
  const result = await upgradeProject(root);
  assert.deepEqual(result.customInstructions, ['.alp/agents/lead/AGENT.md']);
  assert.equal(await readFile(path.join(root, '.alp/agents/lead/AGENT.md'), 'utf8'), custom);
});

test('upgrade archives the retired router from each role and does not reinstall it', async t => {
  const root = await fixture(t);
  await initProject(root);
  const original = await readFile(new URL('./fixtures/retired-ask-alp.md', import.meta.url), 'utf8');
  for (const role of Object.keys(expected)) {
    const directory = path.join(root, `.alp/agents/${role}/skills/ask-alp`);
    await mkdir(directory);
    await writeFile(path.join(directory, 'SKILL.md'), original);
  }
  const result = await upgradeProject(root);
  assert.equal(result.removed.length, 3);
  for (const role of Object.keys(expected)) {
    assert.deepEqual((await resolveAgent(root, { agent: role })).skills.map(s => s.name), expected[role]);
    assert.equal(await readFile(path.join(result.backup, `.alp/agents/${role}/skills/ask-alp/SKILL.md`), 'utf8'), original);
  }
  assert.deepEqual((await initProject(root)).created, []);
  assert.deepEqual((await upgradeProject(root)).removed, []);
});

test('upgrade preserves a customized retired skill for explicit review', async t => {
  const root = await fixture(t);
  await initProject(root);
  const relative = '.alp/agents/main/skills/ask-alp';
  await mkdir(path.join(root, relative));
  await writeFile(path.join(root, relative, 'SKILL.md'), 'Custom user method');
  const result = await upgradeProject(root);
  assert.deepEqual(result.customSkills, [relative]);
  assert.equal(await readFile(path.join(root, relative, 'SKILL.md'), 'utf8'), 'Custom user method');
});
