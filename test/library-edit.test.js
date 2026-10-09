import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { resolveAgent } from '../src/core/resolver.js';
import { resolveTeam } from '../src/core/teams.js';
import { deleteEntry, duplicateEntry, getEntry, listEntries, renameEntry, saveEntry, setGivenSkills } from '../src/core/library-edit.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function setup(t) {
  const [root, library] = [await fixture(t), await fixture(t)];
  await initProject(root);
  return { root, library, options: { root, library } };
}

test('saving an agent writes its files, and a stale revision is refused', async t => {
  const { root, library, options } = await setup(t);
  const created = await saveEntry('agents', 'writer', { instructions: 'Write docs', config: { description: 'Docs writer', model: 'claude:claude-sonnet-5-5' } }, { ...options, scope: 'library', revision: null });
  assert.equal(await readFile(path.join(library, 'agents/writer/AGENT.md'), 'utf8'), 'Write docs\n');
  assert.deepEqual(JSON.parse(await readFile(path.join(library, 'agents/writer/agent.json'), 'utf8')), { description: 'Docs writer', model: 'claude:claude-sonnet-5-5' });
  const entry = await getEntry('agents', 'writer', options);
  assert.deepEqual([entry.source, entry.revision, entry.content.instructions], ['library', created.revision, 'Write docs\n']);
  // Creating again, or saving over a change made since, is refused.
  await assert.rejects(saveEntry('agents', 'writer', { instructions: 'Other' }, { ...options, scope: 'library', revision: null }), { code: 'REVISION_CONFLICT' });
  const second = await saveEntry('agents', 'writer', { instructions: 'Write docs well' }, { ...options, scope: 'library', revision: entry.revision });
  await assert.rejects(saveEntry('agents', 'writer', { instructions: 'Lost update' }, { ...options, scope: 'library', revision: entry.revision }), /changed in the library since you opened it/);
  // An empty config is no agent.json.
  await assert.rejects(readFile(path.join(library, 'agents/writer/agent.json')), { code: 'ENOENT' });
  assert.equal((await resolveAgent(root, { agent: 'writer', library })).instructions.agent, 'Write docs well\n');
  assert.notEqual(second.revision, entry.revision);
  // No temporary files are left behind.
  assert.deepEqual(await readdir(path.join(library, 'agents/writer')), ['AGENT.md']);
});

test('built-ins are never written: duplicate one, or override it by name in the library or project', async t => {
  const { root, library, options } = await setup(t);
  const builtin = await getEntry('agents', 'main', options);
  assert.equal(builtin.source, 'builtin');
  assert.deepEqual(builtin.usedBy, ['project settings', 'team cafe', 'team pho']);
  await assert.rejects(saveEntry('agents', 'main', builtin.content, { ...options, scope: 'builtin' }), { code: 'INVALID_SCOPE' });
  await duplicateEntry('agents', 'main', 'main-copy', { ...options, scope: 'library' });
  assert.equal((await getEntry('agents', 'main-copy', options)).content.instructions, builtin.content.instructions);
  await saveEntry('agents', 'main', { instructions: 'My main' }, { ...options, scope: 'project', revision: null });
  const override = await getEntry('agents', 'main', options);
  assert.deepEqual([override.source, override.overrides], ['project', 'builtin']);
  // Removing the override is allowed though main is in use: the built-in takes over.
  assert.deepEqual(await deleteEntry('agents', 'main', { ...options, scope: 'project' }), { removed: true, now: 'builtin' });
  assert.equal((await resolveAgent(root, { library })).source, 'builtin');
  await duplicateEntry('teams', 'pho', 'my-pho', { ...options, scope: 'project' });
  const team = await resolveTeam(root, 'my-pho', { library });
  assert.deepEqual([team.source, team.label, team.houseRules], ['project', 'Phở', (await resolveTeam(root, 'pho')).houseRules]);
});

test('what an entry names must exist where it lives, and an entry in use is not removed', async t => {
  const { root, library, options } = await setup(t);
  await saveEntry('skills', 'style', { body: '# Style\n' }, { ...options, scope: 'project' });
  // A library agent cannot name a project skill: other projects would not have it.
  await assert.rejects(saveEntry('agents', 'writer', { instructions: 'W', config: { skills: ['style'] } }, { ...options, scope: 'library' }), /names 'style', which is not in the library/);
  await saveEntry('agents', 'writer', { instructions: 'W', config: { skills: ['style'] } }, { ...options, scope: 'project' });
  await saveEntry('mcp', 'docs', { server: { url: 'https://example.test/mcp' } }, { ...options, scope: 'library' });
  await saveEntry('hooks', 'tests', { hook: { event: 'handoff', command: 'npm test', blocking: true } }, { ...options, scope: 'library' });
  await saveEntry('agents', 'checker', { instructions: 'C', config: { mcp: ['docs'], hooks: ['tests'] } }, { ...options, scope: 'library' });
  await assert.rejects(deleteEntry('skills', 'style', { ...options, scope: 'project' }), /skills 'style' is used by agent writer; change them first/);
  await assert.rejects(deleteEntry('mcp', 'docs', { ...options, scope: 'library' }), /used by agent checker/);
  await assert.rejects(renameEntry('hooks', 'tests', 'checks', { ...options, scope: 'library' }), /used by agent checker/);
  // Bad definitions never reach the disk.
  await assert.rejects(saveEntry('mcp', 'broken', { server: { command: '' } }, { ...options, scope: 'library' }), { code: 'INVALID_MCP' });
  await assert.rejects(saveEntry('hooks', 'broken', { hook: { event: 'turn.end', command: 'x', blocking: true } }, { ...options, scope: 'library' }), { code: 'INVALID_HOOK' });
  await assert.rejects(saveEntry('agents', 'broken', { instructions: '' }, { ...options, scope: 'library' }), { code: 'INVALID_ENTRY' });
  await assert.rejects(saveEntry('agents', '../escape', { instructions: 'x' }, { ...options, scope: 'library' }), { code: 'INVALID_NAME' });
  assert.deepEqual(await readdir(path.join(library, 'mcp')), ['docs.json']);
  // A team names existing agents, and keeps the agents it names from being removed.
  const team = { label: 'Docs', main: 'writer', members: { writer: {}, checker: { role: 'reviewer' } }, delegation: { writer: ['checker'] } };
  await assert.rejects(saveEntry('teams', 'docs', { team: { ...team, members: { ...team.members, ghost: { role: 'peer' } } } }, { ...options, scope: 'project' }), /agent 'ghost' is not built in/);
  await saveEntry('teams', 'docs', { team, houseRules: 'Check every page.' }, { ...options, scope: 'project' });
  assert.equal((await resolveTeam(root, 'docs', { library })).houseRules, 'Check every page.');
  await assert.rejects(deleteEntry('agents', 'checker', { ...options, scope: 'library' }), /used by team docs/);
  await deleteEntry('teams', 'docs', { ...options, scope: 'project' });
  await deleteEntry('agents', 'checker', { ...options, scope: 'library' });
  await renameEntry('hooks', 'tests', 'checks', { ...options, scope: 'library' });
  assert.deepEqual((await listEntries('hooks', options)).map(row => [row.name, row.source]), [['checks', 'library']]);
  assert.deepEqual((await listEntries('teams', options)).map(row => row.name), ['pho', 'cafe']);
  await assert.rejects(deleteEntry('hooks', 'absent', { ...options, scope: 'library' }), { code: 'NOT_FOUND' });
});

test('the library gives an agent skills by name, so a built-in agent changes its skills without a copy', async t => {
  const { root, library, options } = await setup(t);
  for (const name of ['xia', 'bug-loop']) await saveEntry('skills', name, { body: `---\nname: ${name}\ndescription: d\n---\n` }, { ...options, scope: 'library', revision: null });
  await writeFile(path.join(library, 'role-skills.json'), JSON.stringify({ main: ['xia'], peer: ['bug-loop'] }));
  const main = await getEntry('agents', 'main', options);
  assert.deepEqual([main.source, main.librarySkills], ['builtin', ['xia']]);
  assert.deepEqual(await setGivenSkills('main', ['xia', 'bug-loop', 'xia'], { library }), { skills: ['xia', 'bug-loop'] });
  assert.deepEqual(JSON.parse(await readFile(path.join(library, 'role-skills.json'), 'utf8')), { main: ['xia', 'bug-loop'], peer: ['bug-loop'] });
  assert.deepEqual((await resolveAgent(root, { agent: 'main', library })).skills.map(skill => skill.name), ['bug-loop', 'xia']);
  // Still built in: no copy of main was made.
  assert.equal((await getEntry('agents', 'main', options)).source, 'builtin');
  await assert.rejects(setGivenSkills('main', ['missing'], { library }), /No skill 'missing' in the library/);
  await setGivenSkills('peer', [], { library });
  assert.deepEqual(JSON.parse(await readFile(path.join(library, 'role-skills.json'), 'utf8')), { main: ['xia', 'bug-loop'] });
});
