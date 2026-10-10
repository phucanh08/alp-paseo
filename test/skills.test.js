import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { upgradeProject } from '../src/core/upgrade.js';
import { resolveAgent } from '../src/core/resolver.js';
import { seedLibrary } from '../src/core/library.js';
import { PaseoAdapter } from '../plugins/paseo/server/dist/index.js';
import { skillDescription } from '../dist/runtime/index.js';
import { legacyProject } from './support/legacy.js';

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
const template = name => readFile(new URL(`../templates/${name}`, import.meta.url), 'utf8');

test('the user library is seeded with the intended role skills and their references', async t => {
  const [root, library] = [await fixture(t), await fixture(t)];
  await initProject(root);
  const seeded = await seedLibrary(library);
  assert.ok(seeded.created.includes('role-skills.json'));
  assert.ok(seeded.created.includes('skills/bug-loop/references/test-proof.md'));
  await assert.rejects(readdir(path.join(root, '.alp/agents')), { code: 'ENOENT' });
  for (const [agent, names] of Object.entries(expected)) {
    const resolved = await resolveAgent(root, { agent, library });
    assert.deepEqual(resolved.skills.map(s => s.name), names);
    for (const skill of resolved.skills) {
      assert.equal(skill.path, path.join(library, 'skills', skill.name, 'SKILL.md'));
      const body = await readFile(skill.path, 'utf8');
      assert.equal(body, await template(`skills/${skill.name}/SKILL.md`));
      for (const match of body.matchAll(/\]\((references\/[^)]+)\)/g)) {
        assert.equal(await readFile(path.join(path.dirname(skill.path), match[1]), 'utf8'), await template(`skills/${skill.name}/${match[1]}`));
      }
    }
  }
  for (const agent of ['oracle', 'reviewer', 'supervisor']) assert.deepEqual((await resolveAgent(root, { agent, library })).skills, []);
  assert.deepEqual(await seedLibrary(library), { created: [], updated: [] });
});

test('the user decides which skills a role gets, and a project skill replaces a library skill of its name', async t => {
  const [root, library] = [await fixture(t), await fixture(t)];
  await initProject(root);
  await seedLibrary(library);
  const roles = JSON.parse(await readFile(path.join(library, 'role-skills.json'), 'utf8'));
  await writeFile(path.join(library, 'role-skills.json'), JSON.stringify({ ...roles, peer: ['xia', 'goal-griller', 'missing'], oracle: ['xia'] }));
  assert.deepEqual((await resolveAgent(root, { agent: 'peer', library })).skills.map(s => s.name), ['goal-griller', 'xia']);
  assert.deepEqual((await resolveAgent(root, { agent: 'oracle', library })).skills.map(s => s.name), ['xia']);
  // A project skill replaces the library's for every agent; an agent's own skills/ replaces both.
  const shared = path.join(root, '.alp/skills/xia/SKILL.md');
  await mkdir(path.dirname(shared), { recursive: true });
  await writeFile(shared, 'Project research method');
  let skills = (await resolveAgent(root, { agent: 'peer', library })).skills;
  assert.deepEqual(skills.map(s => [s.name, s.path]), [['goal-griller', path.join(library, 'skills/goal-griller/SKILL.md')], ['xia', shared]]);
  await legacyProject(root, ['peer']);
  const local = path.join(root, '.alp/agents/peer/skills/xia/SKILL.md');
  await mkdir(path.dirname(local), { recursive: true });
  await writeFile(local, 'Peer research method');
  skills = (await resolveAgent(root, { agent: 'peer', library })).skills;
  assert.deepEqual(skills.map(s => [s.name, s.path]), [['goal-griller', path.join(library, 'skills/goal-griller/SKILL.md')], ['xia', local]]);
  await writeFile(path.join(library, 'role-skills.json'), '{"peer": ["../escape"]}');
  await assert.rejects(resolveAgent(root, { agent: 'peer', library }), /INVALID_LIBRARY|skill directory names/);
});

test('an app update changes only library files the user left as shipped', async t => {
  const library = await fixture(t);
  const v1 = {
    'role-skills.json': '{"main": ["kept", "edited", "deleted"]}\n',
    'skills/kept/SKILL.md': 'kept v1',
    'skills/edited/SKILL.md': 'edited v1',
    'skills/deleted/SKILL.md': 'deleted v1',
    'agents/main/AGENT.md': 'not part of the library',
  };
  assert.deepEqual((await seedLibrary(library, { templates: v1 })).created, ['role-skills.json', 'skills/deleted/SKILL.md', 'skills/edited/SKILL.md', 'skills/kept/SKILL.md']);
  await writeFile(path.join(library, 'skills/edited/SKILL.md'), 'my method');
  await rm(path.join(library, 'skills/deleted'), { recursive: true });
  await writeFile(path.join(library, 'role-skills.json'), '{"main": ["kept", "edited"]}\n');
  const v2 = {
    'role-skills.json': '{"main": ["kept", "edited", "deleted", "added"]}\n',
    'skills/kept/SKILL.md': 'kept v2',
    'skills/edited/SKILL.md': 'edited v2',
    'skills/deleted/SKILL.md': 'deleted v2',
    'skills/added/SKILL.md': 'added v2',
  };
  assert.deepEqual(await seedLibrary(library, { templates: v2 }), { created: ['skills/added/SKILL.md'], updated: ['skills/kept/SKILL.md'] });
  assert.equal(await readFile(path.join(library, 'skills/kept/SKILL.md'), 'utf8'), 'kept v2');
  assert.equal(await readFile(path.join(library, 'skills/edited/SKILL.md'), 'utf8'), 'my method');
  await assert.rejects(readFile(path.join(library, 'skills/deleted/SKILL.md'), 'utf8'), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(library, 'role-skills.json'), 'utf8'), '{"main": ["kept", "edited"]}\n');
  assert.deepEqual(await seedLibrary(library, { templates: v2 }), { created: [], updated: [] });
  // A file the user made before ALP shipped one of that name stays theirs.
  const other = await fixture(t);
  await mkdir(path.join(other, 'skills/kept'), { recursive: true });
  await writeFile(path.join(other, 'skills/kept/SKILL.md'), 'mine');
  await seedLibrary(other, { templates: v1 });
  await seedLibrary(other, { templates: v2 });
  assert.equal(await readFile(path.join(other, 'skills/kept/SKILL.md'), 'utf8'), 'mine');
});

test('Paseo receives a skill index with each skill\'s description, while bodies and supporting references stay lazy', async t => {
  const [root, library] = [await fixture(t), await fixture(t)];
  await initProject(root);
  await seedLibrary(library);
  const reference = await readFile(path.join(library, 'skills/bug-loop/references/test-proof.md'), 'utf8');
  for (const agent of Object.keys(expected)) {
    const resolved = await resolveAgent(root, { agent, library });
    const compiled = await new PaseoAdapter().compile(resolved);
    assert.match(compiled.material.instructions, /Before you start work that a skill's description matches, read its SKILL\.md and follow it/);
    for (const skill of resolved.skills) {
      const description = await skillDescription(skill.path);
      assert.ok(description.length > 40, skill.name);
      assert.ok(compiled.material.instructions.includes(`- ${skill.name} (${skill.path}): ${description}`), skill.name);
      assert.equal(compiled.material.instructions.includes(await readFile(skill.path, 'utf8')), false);
    }
    assert.equal(compiled.material.instructions.includes(reference), false);
  }
});

test('upgrade archives project skill copies that match the shipped skills and keeps customized ones', async t => {
  const root = await fixture(t);
  await legacyProject(root);
  // Projects from 0.3 carry a copy of each role's skills.
  for (const [role, names] of Object.entries(expected)) {
    for (const name of names) await cp(new URL(`../templates/skills/${name}`, import.meta.url), path.join(root, `.alp/agents/${role}/skills/${name}`), { recursive: true });
  }
  const custom = path.join(root, '.alp/agents/peer/skills/xia/SKILL.md');
  await writeFile(custom, 'Custom research method');
  const result = await upgradeProject(root);
  assert.deepEqual(result.customSkills, ['.alp/agents/peer/skills/xia']);
  // 13 skill copies, then every agent copy left as shipped; peer keeps its customized skill.
  assert.equal(result.removed.length, 18);
  assert.deepEqual(result.removed.filter(name => !name.includes('/skills/')), ['.alp/agents/main', '.alp/agents/lead', '.alp/agents/oracle', '.alp/agents/reviewer', '.alp/agents/supervisor']);
  assert.equal(await readFile(custom, 'utf8'), 'Custom research method');
  assert.deepEqual(await readdir(path.join(root, '.alp/agents')), ['peer']);
  assert.equal(await readFile(path.join(result.backup, '.alp/agents/main/skills/bug-loop/references/test-proof.md'), 'utf8'), await template('skills/bug-loop/references/test-proof.md'));
  assert.deepEqual((await upgradeProject(root)).removed, []);
});

test('upgrade recognizes shipped team-v1 instructions and backs up each role', async t => {
  const [root, library] = [await fixture(t), await fixture(t)];
  await legacyProject(root);
  await seedLibrary(library);
  for (const role of Object.keys(expected)) {
    await cp(new URL(`./fixtures/team-v1/${role}/AGENT.md`, import.meta.url), path.join(root, `.alp/agents/${role}/AGENT.md`));
  }
  // Copies as ALP shipped them, old or current, are put away: the project uses the built-ins.
  const result = await upgradeProject(root);
  assert.deepEqual(result.updated, []);
  assert.deepEqual(result.removed, ['main', 'lead', 'peer', 'oracle', 'reviewer', 'supervisor'].map(name => `.alp/agents/${name}`));
  for (const role of Object.keys(expected)) {
    const old = await readFile(new URL(`./fixtures/team-v1/${role}/AGENT.md`, import.meta.url), 'utf8');
    assert.equal(await readFile(path.join(result.backup, `.alp/agents/${role}/AGENT.md`), 'utf8'), old);
    const resolved = await resolveAgent(root, { agent: role, library });
    assert.equal(resolved.source, 'builtin');
    assert.equal(resolved.instructions.agent, await template(`agents/${role}/AGENT.md`));
    assert.deepEqual(resolved.skills.map(s => s.name), expected[role]);
  }
  await assert.rejects(readdir(path.join(root, '.alp/agents')), { code: 'ENOENT' });
  assert.deepEqual((await upgradeProject(root)).removed, []);
});

test('a customized team role is preserved even when its original version is known', async t => {
  const root = await fixture(t);
  await legacyProject(root);
  const old = await readFile(new URL('./fixtures/team-v1/lead/AGENT.md', import.meta.url), 'utf8');
  const custom = old + '\nProject-specific review rule.\n';
  await writeFile(path.join(root, '.alp/agents/lead/AGENT.md'), custom);
  const result = await upgradeProject(root);
  assert.deepEqual(result.customInstructions, ['.alp/agents/lead/AGENT.md']);
  assert.equal(await readFile(path.join(root, '.alp/agents/lead/AGENT.md'), 'utf8'), custom);
  assert.deepEqual(await readdir(path.join(root, '.alp/agents')), ['lead']);
  assert.equal((await resolveAgent(root, { agent: 'lead' })).source, 'project');
});

test('upgrade archives the retired router from each role and does not reinstall it', async t => {
  const root = await fixture(t);
  await legacyProject(root);
  const original = await readFile(new URL('./fixtures/retired-ask-alp.md', import.meta.url), 'utf8');
  for (const role of Object.keys(expected)) {
    const directory = path.join(root, `.alp/agents/${role}/skills/ask-alp`);
    await mkdir(directory);
    await writeFile(path.join(directory, 'SKILL.md'), original);
  }
  const result = await upgradeProject(root);
  // The three routers, then the six agent copies they leave as shipped.
  assert.equal(result.removed.length, 9);
  for (const role of Object.keys(expected)) {
    assert.deepEqual((await resolveAgent(root, { agent: role })).skills, []);
    assert.equal(await readFile(path.join(result.backup, `.alp/agents/${role}/skills/ask-alp/SKILL.md`), 'utf8'), original);
  }
  assert.deepEqual((await initProject(root)).created, []);
  assert.deepEqual((await upgradeProject(root)).removed, []);
});

test('upgrade preserves a customized retired skill for explicit review', async t => {
  const root = await fixture(t);
  await legacyProject(root);
  const relative = '.alp/agents/main/skills/ask-alp';
  await mkdir(path.join(root, relative));
  await writeFile(path.join(root, relative, 'SKILL.md'), 'Custom user method');
  const result = await upgradeProject(root);
  assert.deepEqual(result.customSkills, [relative]);
  assert.equal(await readFile(path.join(root, relative, 'SKILL.md'), 'utf8'), 'Custom user method');
});

test('a skill\'s description is read from its frontmatter: plain, quoted, folded, missing, or clipped', async t => {
  const root = await fixture(t);
  const write = async (name, text) => { const file = path.join(root, name, 'SKILL.md'); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); return file; };
  assert.equal(await skillDescription(await write('plain', '---\nname: plain\ndescription: Use for plain work.\n---\n# Body')), 'Use for plain work.');
  assert.equal(await skillDescription(await write('quoted', '---\nname: quoted\ndescription: "Use: when quoted."\n---\n')), 'Use: when quoted.');
  assert.equal(await skillDescription(await write('folded', '---\nname: folded\ndescription: >\n  Use for work\n  over two lines.\nother: x\n---\n')), 'Use for work over two lines.');
  assert.equal(await skillDescription(await write('none', '# No frontmatter\ndescription: not this')), '');
  assert.equal(await skillDescription(path.join(root, 'missing', 'SKILL.md')), '');
  const long = await skillDescription(await write('long', `---\ndescription: ${'x'.repeat(500)}\n---\n`));
  assert.equal(long.length, 400);
  assert.ok(long.endsWith('…'));
});
