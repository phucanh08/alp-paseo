import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/core/init.js';
import { upgradeProject } from '../src/core/upgrade.js';
import { mapSession, CodexTransport } from '../plugins/paseo/server/dist/index.js';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-workflow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const config = { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: true };
  return { root, config };
}

test('the Paseo model picker selects a profile, independent of permissions and frozen on resume', async t => {
  const { root, config } = await setup(t);
  assert.equal((await mapSession(config)).workflow.mode, 'pho');
  const mapping = await mapSession({ ...config, model: 'cafe', mode: 'workspace-write' });
  assert.equal(mapping.mode, 'workspace-write');
  assert.equal(mapping.workflow.mode, 'cafe');
  // Older clients send the workflow setting or provider option, under the old names too.
  assert.equal((await mapSession({ ...config, settings: { workflow: 'supervised' } })).workflow.mode, 'cafe');
  assert.equal((await mapSession({ ...config, providerOptions: { workflow: 'smart' } })).workflow.mode, 'pho');
  await assert.rejects(mapSession({ ...config, model: 'pho', settings: { workflow: 'cafe' } }), /Conflicting profile/);
  const persistence = { version: 1, data: { agent: 'main', cwd: root, threadId: 'saved', workflow: { mode: 'supervised', maxPeers: 2 } } };
  assert.equal((await mapSession(config, persistence)).workflow.mode, 'cafe');
  await assert.rejects(mapSession({ ...config, model: 'pho' }, persistence), /Cannot change profile/);
  await assert.rejects(mapSession({ ...config, settings: { workflow: 'magic' } }), /Profile must be/);
  for (const maxPeers of [0, -1, 1.5, '3']) {
    await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ workflow: { mode: 'pho', maxPeers } }));
    await assert.rejects(mapSession(config), /maxPeers/);
  }
});

test('main runs on Opus 5.5 high with full access unless settings or the caller choose otherwise', async t => {
  const { root, config } = await setup(t);
  const main = await mapSession({ ...config, model: 'pho', thinkingOption: 'low' });
  assert.deepEqual([main.runtimeKind, main.model, main.thinking, main.mode, main.workflow.supervisor], ['claude', 'claude-opus-5-5', 'high', 'full-access', true]);
  assert.equal((await mapSession({ ...config, mode: 'read-only' })).mode, 'read-only');
  for (const agent of ['oracle', 'reviewer', 'supervisor']) {
    const advisor = await mapSession({ ...config, mode: 'full-access', providerOptions: { agent } }).catch(error => error);
    if (agent === 'oracle') assert.match(advisor.message, /claude:claude-fable-5-1 or codex:gpt-6-astra/);
    else assert.equal(advisor.mode, 'read-only');
  }
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ workflow: { mode: 'cafe', supervisor: false }, runtime: { provider: 'codex', model: 'gpt-6-sol', reasoning: 'low' } }));
  const custom = await mapSession(config);
  assert.deepEqual([custom.runtimeKind, custom.model, custom.thinking, custom.workflow.mode, custom.workflow.supervisor], ['codex', 'gpt-6-sol', 'low', 'cafe', false]);
});

test('explicit upgrade preserves supervised behavior for old shipped topology and renames old profiles', async t => {
  const { root } = await setup(t);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ runtime: { model: 'custom' }, delegation: { main: ['lead'], lead: ['peer'] } }));
  const result = await upgradeProject(root);
  assert.ok(result.backup);
  const config = { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: false };
  const mapping = await mapSession(config);
  assert.equal(mapping.workflow.mode, 'cafe');
  assert.equal(mapping.model, 'custom');
  assert.deepEqual((await upgradeProject(root)).updated, []);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ workflow: { mode: 'smart', maxPeers: 3 } }));
  assert.deepEqual((await upgradeProject(root)).updated, ['.alp/settings.json']);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, '.alp/settings.json'), 'utf8')).workflow, { mode: 'pho', maxPeers: 3 });
});

test('Codex usage snapshot strips account data, preserves reset windows, and handles unavailable usage', async () => {
  const context = await CodexTransport.prototype.orchestrationContext.call({ request: async method => method === 'model/list'
    ? { data: [{ model: 'best', description: 'Highest capability', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }
    : { accountId: 'PRIVATE', rateLimits: { planType: 'pro', primary: { usedPercent: 80, resetsAt: 123, windowDurationMins: 300 } } } });
  assert.equal(context.usage.limits[0].windows[0].remainingPercent, 20);
  assert.equal(context.usage.limits[0].windows[0].resetsAt, 123);
  assert.equal(JSON.stringify(context).includes('PRIVATE'), false);
  const absent = await CodexTransport.prototype.orchestrationContext.call({ request: async () => { throw Error('Unsupported'); } });
  assert.equal(absent.usage.available, false);
  assert.equal(absent.catalogAvailable, false);
});

test('Claude usage context exposes only plan/windows and tolerates unsupported experimental API', async () => {
  const { ClaudeTransport } = await import('../plugins/paseo/server/dist/index.js');
  const context = await ClaudeTransport.prototype.orchestrationContext.call({ query: {
    supportedModels: async () => [{ value: 'premium', displayName: 'Premium', description: 'Highest capability', supportedEffortLevels: ['high'] }],
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
      email: 'PRIVATE', subscription_type: 'max', rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 90, resets_at: '2026-10-08T12:00:00Z' } },
    }),
  } });
  assert.equal(context.usage.plan, 'max');
  assert.equal(context.usage.windows[0].remainingPercent, 10);
  assert.equal(JSON.stringify(context).includes('PRIVATE'), false);
  const absent = await ClaudeTransport.prototype.orchestrationContext.call({ query: { supportedModels: async () => [] } });
  assert.equal(absent.usage.available, false);
});

test('Claude resolves PATH to an explicit executable instead of SDK binaries inside Electron archives', async () => {
  const { ClaudeTransport } = await import('../plugins/paseo/server/dist/index.js');
  const { realpathSync } = await import('node:fs');
  const runtime = new ClaudeTransport(path.basename(process.execPath), process.cwd(), { PATH: path.dirname(process.execPath) });
  assert.equal(runtime.command, realpathSync(process.execPath));
  assert.throws(() => new ClaudeTransport('alp-missing-claude', process.cwd(), { PATH: '' }), /ALP_CLAUDE_BIN/);
});

test('Claude read-only sessions can delegate without plan approval and cannot write plan files', async () => {
  const { claudePermissions } = await import('../plugins/paseo/server/dist/index.js');
  const policy = claudePermissions('read-only');
  assert.equal(policy.permissionMode, 'default');
  assert.ok(!policy.tools.includes('Write'));
  assert.ok(!policy.tools.includes('Bash'));
  for (const name of ['Write', 'Edit', 'Bash', 'ExitPlanMode', 'EnterPlanMode', 'mcp__other__mutate']) {
    assert.equal((await policy.canUseTool(name, {})).behavior, 'deny');
  }
  assert.equal((await policy.canUseTool('Read', {})).behavior, 'allow');
  assert.equal((await policy.canUseTool('mcp__alp__alp_delegate', {})).behavior, 'allow');
  assert.equal((await policy.canUseTool('mcp__alp__alp_handoff', {})).behavior, 'allow');
});

test('Claude live permission gate follows upgrades and downgrades', async () => {
  const { claudePermissions } = await import('../plugins/paseo/server/dist/index.js');
  let sandbox = 'read-only';
  const policy = claudePermissions(sandbox, () => sandbox);
  assert.equal((await policy.canUseTool('Write', {})).behavior, 'deny');
  sandbox = 'workspace-write';
  assert.equal((await policy.canUseTool('Write', {})).behavior, 'allow');
  sandbox = 'read-only';
  for (const tool of ['Write', 'Edit', 'Bash', 'mcp__other__mutate']) assert.equal((await policy.canUseTool(tool, {})).behavior, 'deny');
});

test('Claude full access skips permission checks', async () => {
  const { claudePermissions } = await import('../plugins/paseo/server/dist/index.js');
  const policy = claudePermissions('full-access');
  assert.equal(policy.permissionMode, 'bypassPermissions');
  assert.equal(policy.allowDangerouslySkipPermissions, true);
  assert.equal(claudePermissions('workspace-write').permissionMode, 'acceptEdits');
});
