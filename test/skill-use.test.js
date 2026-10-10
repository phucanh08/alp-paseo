import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudePermissions, skillPlugin, SKILL_PLUGIN } from '../dist/runtime/index.js';
import { renderLog } from '../src/client/render.js';
import { tree, until } from './support/fake-agent.js';

test('Claude gets the agent\'s skills to load as its own; Codex finds them in its instructions', async t => {
  const claude = await tree(t, { prefix: 'alp-skill-', open: { model: 'claude:claude-opus-5-5' } });
  const config = claude.main.config;
  assert.deepEqual(config.skills.map(skill => skill.name), ['bug-loop', 'goal-griller', 'prompt-leverage', 'sequence-execution-plan', 'smart-commits', 'xia']);
  assert.ok(config.skills.every(skill => skill.path.endsWith(`/skills/${skill.name}/SKILL.md`)));
  assert.match(config.developerInstructions, /Your skills are also Claude Code skills named alp:<name>: run one with the Skill tool/);
  assert.match(config.developerInstructions, /- xia \([^)]+\/skills\/xia\/SKILL\.md\): Research an unfamiliar implementation/);

  const codex = await tree(t, { prefix: 'alp-skill-', open: { model: 'codex:gpt-5.6-sol' } });
  assert.equal(codex.main.config.skills, undefined);
  assert.doesNotMatch(codex.main.config.developerInstructions, /Claude Code skills/);
  assert.match(codex.main.config.developerInstructions, /- smart-commits \([^)]+\): Package existing owned changes/);
});

test('an agent using a skill is logged once per skill: by the Skill tool, or by reading its SKILL.md', async t => {
  const { main, agents, runLog } = await tree(t, { prefix: 'alp-skill-', open: { model: 'codex:gpt-5.6-sol' } });
  const skills = main.config.developerInstructions.match(/- xia \(([^)]+)\)/);
  const started = item => main.notification('item/started', { threadId: main.threadId, item });
  started({ type: 'commandExecution', id: 'c1', command: `cat ALP.md ${skills[1]}`, cwd: '/tmp', status: 'inProgress' });
  started({ type: 'commandExecution', id: 'c2', command: `sed -n 1,80p ${skills[1]}`, cwd: '/tmp', status: 'inProgress' });
  // Claude's Skill tool, as its transport reports it.
  started({ type: 'commandExecution', id: 'c3', command: `Skill {"skill":"${SKILL_PLUGIN}:smart-commits"}`, cwd: '/tmp', status: 'inProgress' });
  // A skill of another role is not the agent's: nothing to log.
  started({ type: 'commandExecution', id: 'c4', command: 'cat ~/.alp/skills/unknown-skill/SKILL.md', cwd: '/tmp', status: 'inProgress' });
  await until(async () => (await runLog()).filter(entry => entry.event === 'skill').length === 2, 'two skill entries');
  await new Promise(resolve => setTimeout(resolve, 30));
  const used = (await runLog()).filter(entry => entry.event === 'skill');
  assert.deepEqual(used.map(entry => [entry.agent, entry.skill, entry.via]), [['main', 'xia', 'read'], ['main', 'smart-commits', 'skill']]);
  assert.deepEqual(renderLog('root', used.map(entry => ({ ...entry, ts: '2026-01-01T10:00:00.000Z' }))), ['10:00:00  ✦ main uses skill xia', '10:00:00  ✦ main uses skill smart-commits (Skill tool)']);
  assert.equal(agents.length, 1);
});

test('the skill plugin links each skill\'s own directory under the plugin name alp', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-skill-plugin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const plugin = path.join(directory, 'plugin');
  skillPlugin(plugin, [{ name: 'xia', path: '/library/skills/xia/SKILL.md' }, { name: 'bug-loop', path: '/project/.alp/skills/bug-loop/SKILL.md' }]);
  assert.deepEqual(JSON.parse(await readFile(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')).name, 'alp');
  assert.equal(await readlink(path.join(plugin, 'skills', 'xia')), '/library/skills/xia');
  assert.equal(await readlink(path.join(plugin, 'skills', 'bug-loop')), '/project/.alp/skills/bug-loop');
  // Made again on a restart, from scratch.
  skillPlugin(plugin, [{ name: 'xia', path: '/library/skills/xia/SKILL.md' }]);
  await assert.rejects(lstat(path.join(plugin, 'skills', 'bug-loop')));
});

test('a read-only Claude session may run its skills', async () => {
  const fixed = claudePermissions('read-only');
  assert.ok(fixed.tools.includes('Skill'));
  const live = claudePermissions('read-only', () => 'read-only');
  assert.equal((await live.canUseTool('Skill', { skill: 'alp:xia' })).behavior, 'allow');
  assert.equal((await live.canUseTool('Write', { file_path: '/tmp/x', content: '' })).behavior, 'deny');
});
