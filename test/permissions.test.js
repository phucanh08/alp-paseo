import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../src/core/init.js';
import { addAllowRule, commandDecision, parseRule, profileFor, simpleCommands, unwrapShell, validatePermissions } from '../src/core/permissions.js';
import { claudePermissions, createAlpRuntime, createCopy, reclaimCopies, removeCopy, resolveSession } from '../dist/runtime/index.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function project(t, permissions, userPermissions) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-permissions-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  const home = path.join(directory, 'home');
  await initProject(root);
  await mkdir(home, { recursive: true });
  const settings = path.join(root, '.alp', 'settings.json');
  if (permissions) await writeFile(settings, JSON.stringify({ ...JSON.parse(await readFile(settings, 'utf8')), permissions }));
  if (userPermissions) await writeFile(path.join(home, 'settings.json'), JSON.stringify({ permissions: userPermissions }));
  return { directory, root, home };
}

test('rules use Claude Code syntax and settings are checked', () => {
  assert.deepEqual(parseRule('Bash'), { tool: 'Bash' });
  assert.deepEqual(parseRule('Bash(*)'), { tool: 'Bash' });
  assert.deepEqual(parseRule('Bash(npm test:*)'), { tool: 'Bash', specifier: 'npm test:*' });
  assert.deepEqual(parseRule('WebFetch(domain:example.com)'), { tool: 'WebFetch', specifier: 'domain:example.com' });
  assert.deepEqual(parseRule('mcp__github__search'), { tool: 'mcp__github__search' });
  assert.throws(() => parseRule('Bash()'), /empty specifier/);
  assert.throws(() => parseRule('npm test'), /is not Tool or Tool\(specifier\)/);
  assert.throws(() => parseRule('bash(npm test:*)'), /names unknown tool bash; use Bash, Read/);
  const check = value => () => validatePermissions(value, 'settings.json');
  assert.throws(check([]), /permissions must be an object/);
  assert.throws(check({ rules: {} }), /unsupported permissions field 'rules'/);
  assert.throws(check({ profiles: { r: { base: 'admin' } } }), /permissions\.profiles\.r\.base must be read-only, workspace-write, full-access/);
  assert.throws(check({ profiles: { r: { mode: 'x' } } }), /unsupported field 'mode'/);
  assert.throws(check({ profiles: { r: { beyondMode: 'maybe' } } }), /permissions\.profiles\.r\.beyondMode must be refuse or ask/);
  assert.throws(check({ profiles: { r: { allow: ['npm test'] } } }), /permissions\.profiles\.r\.allow: "npm test" is not Tool/);
  assert.throws(check({ agents: { reviewer: 3 } }), /permissions\.agents\.reviewer must name a profile/);
  assert.deepEqual(check({ profiles: { r: { base: 'read-only', allow: [' Bash(npm test:*) '] } }, agents: { reviewer: 'r' } })(),
    { profiles: { r: { base: 'read-only', allow: ['Bash(npm test:*)'], ask: [], deny: [] } }, agents: { reviewer: 'r' } });
});

test('a command is allowed only when allow rules cover every part of it, and denied when a deny rule covers any', () => {
  const profile = { allow: ['Bash(npm test:*)', 'Bash(git diff:*)', 'Bash(git status)'], deny: ['Bash(git push:*)', 'Bash(rm:*)'] };
  const cases = [
    ['npm test', 'allow'], ['npm test -- --watch=false', 'allow'], ['npm test 2>&1', 'allow'], ['npm test 2>/dev/null', 'allow'],
    ['git diff HEAD && git status', 'allow'], ['git status --short', undefined], ['npm testing', undefined],
    ['npm test > out.txt', undefined], ['npm test &> out.txt', undefined], ['git diff | tail -5', undefined],
    ['npm test; rm -rf dist', 'deny'], ['git push origin main', 'deny'], ['echo $(git push)', 'deny'], ['npm test "unclosed', 'deny'],
    ['echo "rm is fine in quotes"', undefined], ["/bin/zsh -lc 'npm test -- --x'", 'allow'], ["/bin/zsh -lc 'git diff; git push'", 'deny'],
  ];
  for (const [command, expected] of cases) assert.equal(commandDecision(profile, command), expected, command);
  assert.equal(commandDecision({ allow: ['Bash(npm test:*)'], deny: [] }, 'echo `id`'), undefined);
  assert.equal(commandDecision({ allow: [], deny: ['Bash'] }, 'ls'), 'deny');
  // Deny wins over ask, and ask over allow; `npm test *` is Claude's newer prefix form.
  const asking = { allow: ['Bash(git *)'], ask: ['Bash(git push *)'], deny: ['Bash(git push --force *)'] };
  assert.deepEqual(['git status', 'git', 'git push origin', 'git push --force origin', 'echo $(x)'].map(command => commandDecision(asking, command)), ['allow', 'allow', 'ask', 'deny', 'deny']);
  // A line ALP cannot split is asked about when there are ask rules and no deny rules.
  assert.equal(commandDecision({ allow: [], ask: ['Bash(git push *)'], deny: [] }, 'echo $(x)'), 'ask');
  assert.equal(unwrapShell(`/bin/bash -c 'echo '\\''hi'\\'''`), "echo 'hi'");
  assert.deepEqual(simpleCommands('a && b || c; d | e\nf & g'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

test('profiles merge the project and the user, cap modes, and keep advisors read-only', async t => {
  const { root, home } = await project(t,
    { profiles: { review: { base: 'read-only', allow: ['Bash(npm test:*)'] }, builder: { base: 'workspace-write', deny: ['Bash(git push:*)'] } }, agents: { reviewer: 'review', peer: 'builder', main: 'builder' } },
    { profiles: { review: { base: 'full-access', allow: ['Bash(node --test:*)'], deny: ['Bash(rm:*)'] } }, agents: { reviewer: 'other', lead: 'workspace-write' } });
  const none = { ask: [], beyondMode: 'refuse' };
  assert.deepEqual(await profileFor(root, home, 'reviewer'), { name: 'review', base: 'read-only', allow: ['Bash(npm test:*)', 'Bash(node --test:*)'], deny: ['Bash(rm:*)'], ...none });
  assert.deepEqual(await profileFor(root, home, 'oracle'), { name: 'read-only', base: 'read-only', allow: [], deny: [], ...none });
  assert.deepEqual(await profileFor(root, home, 'lead'), { name: 'workspace-write', base: 'workspace-write', allow: [], deny: [], ...none });
  assert.equal(await profileFor(root, undefined, 'lead'), null);

  // A profile caps the mode a session asks for.
  assert.deepEqual(await resolved(root, home, { agent: 'peer', mode: 'full-access' }), ['workspace-write', 'builder']);
  assert.deepEqual(await resolved(root, home, { agent: 'main' }), ['workspace-write', 'builder']);
  assert.deepEqual(await resolved(root, home, { agent: 'reviewer', mode: 'full-access' }), ['read-only', 'review']);

  const { root: other } = await project(t, { profiles: { open: { base: 'workspace-write' } }, agents: { reviewer: 'open', peer: 'missing' } });
  await assert.rejects(profileFor(other, undefined, 'reviewer'), /reviewer is an advisor; its profile 'open' must have base read-only/);
  await assert.rejects(profileFor(other, undefined, 'peer'), /permissions\.agents\.peer names profile 'missing', which no settings file defines/);
});

async function resolved(root, home, spec) {
  const session = await resolveSession({ cwd: root, ...spec, ...(spec.agent === 'oracle' ? { model: 'claude:claude-fable-5-1' } : {}) }, { library: home });
  return [session.mode, session.permissions?.name];
}

test('Claude enforces allow and deny rules itself', () => {
  const options = claudePermissions('read-only', () => 'read-only', { allow: ['Bash(npm test:*)'], deny: ['Bash(git push:*)'] });
  assert.deepEqual(options.allowedTools, ['Bash(npm test:*)']);
  assert.deepEqual(options.disallowedTools.slice(-1), ['Bash(git push:*)']);
  assert.ok(options.disallowedTools.includes('Agent'));
  assert.equal(claudePermissions('full-access', () => 'full-access', null).allowedTools, undefined);
});

test('Codex asks ALP before leaving its sandbox, and ALP answers by the profile', async t => {
  const { directory, root, home } = await project(t, {
    profiles: { review: { base: 'read-only', allow: ['Bash(npm test:*)'], deny: ['Bash(rm:*)'] }, lead: { deny: ['Bash(git push:*)'] }, builder: { base: 'workspace-write' } },
    agents: { reviewer: 'review', main: 'lead', peer: 'builder' },
  });
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs') });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, model: 'codex:gpt-6.1-sol' });
  await until(() => runtimes.length === 2);
  const [main] = runtimes;
  // Full access with deny rules: Codex asks before every command.
  // Codex has a permissions field of its own; the profile stays in ALP.
  assert.deepEqual([main.config.approvalPolicy, main.config.sandbox, main.config.permissions], ['untrusted', 'danger-full-access', undefined]);
  assert.match(main.config.developerInstructions, /Permissions: profile lead, mode full-access\. Never: Bash\(git push:\*\)\./);
  // Main briefs its targets knowing their profiles; oracle's plain read-only one says nothing new.
  assert.match(main.config.developerInstructions, /Permission profiles of your targets[^\n]*: peer: at most workspace-write; reviewer: at most read-only, may also run Bash\(npm test:\*\), never Bash\(rm:\*\)\./);
  assert.doesNotMatch(main.config.developerInstructions, /oracle: at most/);
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Review it' }] });
  assert.equal(main.started[0].params.approvalPolicy, 'untrusted');
  const ask = (harness, command) => harness.serverRequest('item/commandExecution/requestApproval', { kind: 'command', threadId: harness.threadId, command });
  assert.deepEqual(await ask(main, "/bin/zsh -lc 'git push origin main'"), { decision: 'decline' });
  assert.deepEqual(await ask(main, "/bin/zsh -lc 'npm install'"), { decision: 'accept' });

  // A read-only reviewer with allow rules: commands run sandboxed, and only allowed ones leave the sandbox.
  await main.call('alp_delegate', { agent: 'reviewer', task: 'Run the tests', wait: false });
  await until(() => runtimes.length === 3 && runtimes[2].started.length === 1);
  const reviewer = runtimes[2];
  assert.deepEqual([reviewer.config.approvalPolicy, reviewer.config.sandbox, reviewer.started[0].params.approvalPolicy], ['on-request', 'read-only', 'on-request']);
  assert.match(reviewer.config.developerInstructions, /Beyond your mode you may also use: Bash\(npm test:\*\)\. Never: Bash\(rm:\*\)\.[\s\S]*with escalated permissions from the start/);
  assert.deepEqual(await ask(reviewer, "/bin/zsh -lc 'npm test 2>&1'"), { decision: 'accept' });
  assert.deepEqual(await ask(reviewer, "/bin/zsh -lc 'npm test && rm -rf dist'"), { decision: 'decline' });
  assert.deepEqual(await ask(reviewer, "/bin/zsh -lc 'touch x'"), { decision: 'decline' });
  assert.deepEqual(await reviewer.serverRequest('item/fileChange/requestApproval', { threadId: reviewer.threadId }), { decision: 'decline' });
  await assert.rejects(reviewer.serverRequest('item/permissions/requestApproval', {}), /Unsupported runtime request/);
  reviewer.call('alp_handoff', { outcome: 'complete', summary: 'Tests pass' });
  reviewer.finish('Reviewed');
  await main.call('alp_wait', {});

  // A peer's profile caps the mode main asks for; a worktree is still a writer.
  const started = await main.call('alp_delegate', { agent: 'peer', task: 'Fix it', mode: 'full-access', wait: false });
  assert.deepEqual([started.mode, started.modeNote], ['workspace-write', 'peer runs workspace-write: its permission profile builder caps it']);
  await until(() => runtimes.length === 4 && runtimes[3].started.length === 1);
  assert.deepEqual([runtimes[3].config.sandbox, runtimes[3].config.approvalPolicy], ['workspace-write', 'never']);
  runtimes[3].call('alp_handoff', { outcome: 'complete', summary: 'Fixed' });
  runtimes[3].finish('Fixed');
  await main.call('alp_wait', {});
  main.finish('Done');

  const read = async () => (await readFile(path.join(directory, 'runs', 'root.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'permission');
  await until(async () => (await read()).length === 6);
  assert.deepEqual((await read()).map(entry => [entry.agent, entry.request, entry.decision, entry.rule ?? null]), [
    ['main', 'command', 'decline', 'deny'], ['main', 'command', 'accept', null],
    ['reviewer', 'command', 'accept', 'allow'], ['reviewer', 'command', 'decline', 'deny'], ['reviewer', 'command', 'decline', null], ['reviewer', 'file change', 'decline', null],
  ]);
});

test('without permission settings Codex never asks, as before', async t => {
  const { directory, root, home } = await project(t);
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs') });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, model: 'codex:gpt-6.1-sol' });
  await until(() => runtimes.length === 2);
  const [main, supervisor] = runtimes;
  assert.deepEqual([main.config.approvalPolicy, supervisor.config.approvalPolicy], ['never', 'never']);
  assert.doesNotMatch(main.config.developerInstructions, /Permissions:|Permission profiles of your targets/);
  // Main cannot make an advisor write.
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Review' }] });
  await main.call('alp_delegate', { agent: 'reviewer', task: 'Review', mode: 'full-access', wait: false });
  await until(() => runtimes.length === 3);
  assert.equal(runtimes[2].config.sandbox, 'read-only');
});

test('a Claude session carries its profile to the transport', async t => {
  const { directory, root, home } = await project(t, { profiles: { review: { base: 'read-only', allow: ['Bash(npm test:*)'] } }, agents: { reviewer: 'review' } });
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs') });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  const [main, supervisor] = runtimes;
  assert.deepEqual([main.config.runtime, main.config.permissions, supervisor.config.permissions], ['claude', null, { name: 'read-only', base: 'read-only', allow: [], ask: [], deny: [], beyondMode: 'refuse' }]);
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Review' }] });
  await main.call('alp_delegate', { agent: 'reviewer', task: 'Review', model: 'claude:claude-sonnet-5-5', wait: false });
  await until(() => runtimes.length === 3);
  assert.deepEqual(runtimes[2].config.permissions, { name: 'review', base: 'read-only', allow: ['Bash(npm test:*)'], ask: [], deny: [], beyondMode: 'refuse' });
});

test('Claude asks ALP for ask rules and for what a read-only mode refuses', async () => {
  const asked = [];
  const answer = { allow: true, always: true };
  const { canUseTool, settings } = claudePermissions('read-only', () => 'read-only', { allow: [], ask: ['Bash(git push *)'], deny: [], beyondMode: 'ask' }, async request => { asked.push(request); return answer; });
  assert.deepEqual(settings, { permissions: { ask: ['Bash(git push *)'] } });
  // An ask rule: Claude says so in decisionReasonType; no rule to add.
  assert.deepEqual(await canUseTool('Bash', { command: 'git push' }, { decisionReasonType: 'rule' }), { behavior: 'allow', updatedInput: { command: 'git push' } });
  // Beyond the mode: Claude's suggestion becomes the rule an always-allow adds for the session.
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm ci *' }], behavior: 'allow', destination: 'localSettings' }];
  assert.deepEqual(await canUseTool('Bash', { command: 'npm ci' }, { decisionReasonType: 'other', suggestions }),
    { behavior: 'allow', updatedInput: { command: 'npm ci' }, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm ci *' }], behavior: 'allow', destination: 'session' }] });
  assert.deepEqual(await canUseTool('Edit', { file_path: 'a.js' }, {}), { behavior: 'allow', updatedInput: { file_path: 'a.js' }, updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Edit', ruleContent: 'a.js' }], behavior: 'allow', destination: 'session' }] });
  assert.deepEqual(asked.map(request => [request.reason, request.rule ?? null]), [['rule', null], ['mode', 'Bash(npm ci *)'], ['mode', 'Edit(a.js)']]);
  answer.allow = false; answer.message = 'The user refused it';
  assert.deepEqual(await canUseTool('Bash', { command: 'rm x' }, {}), { behavior: 'deny', message: 'The user refused it' });
  assert.equal((await canUseTool('Read', { file_path: 'a.js' }, {})).behavior, 'allow');
  // Without beyondMode ask, read-only refuses as before and asks no one.
  const refusing = claudePermissions('read-only', () => 'read-only', { allow: [], ask: [], deny: [], beyondMode: 'refuse' }, async () => assert.fail('asked'));
  assert.deepEqual(await refusing.canUseTool('Bash', { command: 'npm ci' }, {}), { behavior: 'deny', message: 'ALP session is read-only' });
  assert.equal(refusing.settings, undefined);
});

test('the user answers permission questions; always allow writes the rule and stops asking', async t => {
  const { directory, root, home } = await project(t, {
    profiles: { review: { base: 'read-only', ask: ['Bash(git push *)'], beyondMode: 'ask' } },
    agents: { reviewer: 'review' },
  });
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs') });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, model: 'codex:gpt-6.1-sol' });
  await until(() => runtimes.length === 2);
  const [main] = runtimes;
  assert.match(main.config.developerInstructions, /reviewer: at most read-only, with the user's approval each time Bash\(git push \*\), and asks the user before anything else beyond that mode\./);
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Review' }] });
  await main.call('alp_delegate', { agent: 'reviewer', task: 'Review', wait: false });
  await until(() => runtimes.length === 3 && runtimes[2].started.length === 1);
  const reviewer = runtimes[2];
  assert.equal(reviewer.config.approvalPolicy, 'on-request');
  assert.match(reviewer.config.developerInstructions, /The user approves each use of: Bash\(git push \*\); ALP asks them and you wait\. ALP asks the user before anything else your mode does not allow/);
  const ask = (command, extra = {}) => reviewer.serverRequest('item/commandExecution/requestApproval', { kind: 'command', threadId: reviewer.threadId, command, ...extra });
  const question = async () => { await until(() => runtime.questions().length === 1); return runtime.questions()[0]; };

  // Beyond the mode: the user may allow always, and the rule lands in the project's settings.
  const install = ask("/bin/zsh -lc 'npm install --no-audit'", { proposedExecpolicyAmendment: ['npm', 'install'], reason: 'needs network' });
  const first = await question();
  assert.deepEqual(first.options, ['Allow once', 'Always allow', 'Deny']);
  assert.match(first.body, /^reviewer wants to run `npm install --no-audit` \(needs network\)\. Its read-only mode does not allow that\. Always allow adds Bash\(npm install \*\) to profile review\.$/);
  runtime.answer(first.id, { text: 'Always allow' });
  assert.deepEqual(await install, { decision: 'accept' });
  const settings = JSON.parse(await readFile(path.join(root, '.alp', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions.profiles.review.allow, ['Bash(npm install *)']);
  assert.equal(settings.workflow !== undefined || settings.permissions !== undefined, true);
  // The same session no longer asks about it.
  assert.deepEqual(await ask("/bin/zsh -lc 'npm install left-pad'"), { decision: 'accept' });
  assert.deepEqual(runtime.questions(), []);

  // An ask rule asks every time, with no always.
  const push = ask("/bin/zsh -lc 'git push origin main'");
  const second = await question();
  assert.deepEqual(second.options, ['Allow once', 'Deny']);
  assert.match(second.body, /Its permission profile review asks you each time\.$/);
  runtime.answer(second.id, { text: 'Deny' });
  assert.deepEqual(await push, { decision: 'decline' });

  // Questions wait in turn; another answer refuses.
  const one = ask("/bin/zsh -lc 'touch a'");
  const two = ask("/bin/zsh -lc 'touch b'");
  const third = await question();
  runtime.answer(third.id, { text: 'Allow once' });
  assert.deepEqual(await one, { decision: 'accept' });
  const fourth = await question();
  assert.match(fourth.body, /touch b/);
  runtime.answer(fourth.id, { text: 'not now' });
  assert.deepEqual(await two, { decision: 'decline' });

  // Claude's requests go the same way.
  const claude = reviewer.serverRequest('item/permission/request', { tool: 'Bash', input: { command: 'npm ci' }, reason: 'mode', rule: 'Bash(npm ci *)' });
  runtime.answer((await question()).id, { text: 'Allow once' });
  assert.deepEqual(await claude, { allow: true });

  // The run log is written in the background.
  const permissions = async () => (await readFile(path.join(directory, 'runs', 'root.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'permission');
  await until(async () => (await permissions()).length === 6);
  assert.deepEqual((await permissions()).map(entry => [entry.decision, entry.asked ?? false, entry.always ?? null, entry.rule ?? null]), [
    ['accept', true, 'Bash(npm install *)', null], ['accept', false, null, 'allow'], ['decline', true, null, 'ask'],
    ['accept', true, null, null], ['decline', true, null, null], ['accept', true, null, null],
  ]);
  reviewer.call('alp_handoff', { outcome: 'complete', summary: 'Done' });
  reviewer.finish('Done');
  await main.call('alp_wait', {});
  main.finish('Done');
});

test('always allow writes to the file that defines the profile', async t => {
  const { root, home } = await project(t, undefined, { profiles: { mine: { base: 'read-only' } } });
  assert.equal(await addAllowRule(root, home, 'mine', 'Bash(make check)'), path.join(home, 'settings.json'));
  assert.deepEqual(JSON.parse(await readFile(path.join(home, 'settings.json'), 'utf8')).permissions.profiles.mine, { base: 'read-only', allow: ['Bash(make check)'] });
  await assert.rejects(addAllowRule(root, home, 'missing', 'Bash(x)'), /No settings file defines profile missing/);
  await assert.rejects(addAllowRule(root, home, 'mine', 'bash(x)'), /unknown tool bash/);
});

test('the CLI lists profiles and checks a command against one', async t => {
  const { root, home } = await project(t, { profiles: { review: { base: 'read-only', allow: ['Bash(npm test:*)'], ask: ['Bash(git push *)'], deny: ['Bash(rm:*)'], beyondMode: 'ask' } }, agents: { reviewer: 'review' } });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ALP_HOME: home } });
  const listed = run('permissions');
  assert.match(listed.stdout, /^main {2}no profile: the mode its requester or the user chooses$/m);
  assert.match(listed.stdout, /^reviewer {2}profile review, at most read-only; asks the user beyond it\n {2}allow: Bash\(npm test:\*\)\n {2}ask: {3}Bash\(git push \*\)\n {2}deny: {2}Bash\(rm:\*\)$/m);
  assert.match(listed.stdout, /^oracle {2}profile read-only, at most read-only$/m);
  assert.match(run('permissions', 'check', 'reviewer', 'npm test 2>&1').stdout, /^allow: profile review lets reviewer run it, even beyond its read-only mode/);
  assert.match(run('permissions', 'check', 'reviewer', 'npm test; rm -rf /').stdout, /^deny: a deny rule of profile review covers it/);
  assert.match(run('permissions', 'check', 'reviewer', 'git push').stdout, /^ask: profile review asks the user each time/);
  assert.deepEqual(JSON.parse(run('permissions', 'check', 'main', 'ls', '--json').stdout), { agent: 'main', profile: null, base: null, decision: 'mode' });
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ permissions: { profiles: { r: { allow: ['npm test'] } } } }));
  const broken = run('permissions');
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /settings\.json: permissions\.profiles\.r\.allow: "npm test" is not Tool or Tool\(specifier\)/);
});

// --- helpers ------------------------------------------------------------------------

let calls = 0;
function fakeTransport(runtimes) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      kind, calls: [], threadId: `thread-${index}`, turnId: undefined,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.handler = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      get started() { return this.calls.filter(call => call.method === 'turn/start'); },
      get config() { return this.calls.find(call => call.method === 'thread/start').params; },
      serverRequest(method, params) { return this.handler(method, params); },
      async call(tool, args) {
        return JSON.parse((await this.handler('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId: `${tool}-${index}-${++calls}`, namespace: null, tool, arguments: args })).contentItems[0].text);
      },
      finish(text = 'done') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `output-${index}-${turns}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}

// --- step 3: the sandbox floor and review copies -------------------------------------

const git = (cwd, ...args) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };

test('a floor puts Claude Bash in the OS sandbox and keeps file tools in the workspace', async () => {
  const root = path.join(tmpdir(), 'alp-floor-root');
  const asked = [];
  const readOnly = claudePermissions('read-only', () => 'read-only', { allow: ['Bash(npm test *)'], ask: [], deny: ['Bash(rm *)'], beyondMode: 'refuse', floor: 'read-only', floorRoot: root }, async request => { asked.push(request); return { allow: true }; });
  assert.deepEqual(readOnly.sandbox, { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: true, filesystem: { denyWrite: [root] } });
  // Inside a read-only floor any command runs; the OS stops its writes.
  assert.equal((await readOnly.canUseTool('Bash', { command: 'node -e "1"' }, {})).behavior, 'allow');
  // Leaving the sandbox needs an allow rule; a deny rule refuses even that.
  assert.equal((await readOnly.canUseTool('Bash', { command: 'npm test', dangerouslyDisableSandbox: true }, {})).behavior, 'allow');
  assert.deepEqual(await readOnly.canUseTool('Bash', { command: 'touch x', dangerouslyDisableSandbox: true }, {}), { behavior: 'deny', message: 'Bash runs inside the sandbox; leaving it needs an allow rule in your permission profile' });
  assert.deepEqual(await readOnly.canUseTool('Bash', { command: 'npm test && rm -rf a', dangerouslyDisableSandbox: true }, {}), { behavior: 'deny', message: 'A deny rule of your permission profile covers it' });
  assert.equal((await readOnly.canUseTool('Edit', { file_path: path.join(root, 'a.js') }, {})).behavior, 'deny');
  assert.deepEqual(asked, []);

  const asking = claudePermissions('read-only', () => 'read-only', { allow: [], ask: [], deny: [], beyondMode: 'ask', floor: 'read-only', floorRoot: root }, async request => { asked.push(request); return { allow: true, always: true }; });
  const left = await asking.canUseTool('Bash', { command: 'npm ci', dangerouslyDisableSandbox: true }, {});
  assert.deepEqual([left.behavior, asked.map(request => [request.reason, request.rule])], ['allow', [['mode', 'Bash(npm ci)']]]);

  // A workspace floor: the workspace and temp files, nothing else, for Bash and file tools alike.
  const workspace = claudePermissions('workspace-write', () => 'workspace-write', { allow: [], ask: [], deny: [], beyondMode: 'refuse', floor: 'workspace-write', floorRoot: root });
  assert.deepEqual(workspace.sandbox, { enabled: true, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: true });
  assert.equal((await workspace.canUseTool('Write', { file_path: path.join(root, 'src', 'a.js') }, {})).behavior, 'allow');
  assert.equal((await workspace.canUseTool('Write', { file_path: 'relative/b.js' }, {})).behavior, 'allow');
  assert.equal((await workspace.canUseTool('Write', { file_path: path.join(tmpdir(), 'scratch.txt') }, {})).behavior, 'allow');
  assert.deepEqual(await workspace.canUseTool('Edit', { file_path: '/etc/hosts' }, {}), { behavior: 'deny', message: 'Outside your workspace' });
  assert.deepEqual(await workspace.canUseTool('Bash', { command: 'curl x', dangerouslyDisableSandbox: true }, {}), { behavior: 'deny', message: 'Bash runs inside the sandbox; leaving it needs an allow rule in your permission profile' });
  // Without a floor nothing changes.
  assert.equal(claudePermissions('read-only', () => 'read-only', { allow: [], ask: [], deny: [] }).sandbox, undefined);
});

test('a review copy has the requester\'s state, links node_modules, and leaves the tree untouched', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-copy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = path.join(directory, 'repo');
  await mkdir(path.join(checkout, 'src'), { recursive: true });
  await mkdir(path.join(checkout, 'node_modules', 'dep'), { recursive: true });
  await writeFile(path.join(checkout, '.gitignore'), 'node_modules\ndist\n');
  await writeFile(path.join(checkout, 'src', 'a.js'), 'one\n');
  git(checkout, 'init', '-q'); git(checkout, 'add', '-A'); git(checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  await writeFile(path.join(checkout, 'src', 'a.js'), 'two\n');
  await writeFile(path.join(checkout, 'src', 'new.js'), 'new\n');
  await mkdir(path.join(checkout, 'dist'));
  await writeFile(path.join(checkout, 'dist', 'out.js'), 'built\n');
  const status = git(checkout, 'status', '--porcelain');

  const copy = await createCopy(path.join(checkout, 'src'), path.join(directory, 'copies'), 'a1');
  assert.equal(copy.workdir, path.join(copy.path, 'src'));
  assert.equal(await readFile(path.join(copy.path, 'src', 'a.js'), 'utf8'), 'two\n');
  assert.equal(await readFile(path.join(copy.path, 'src', 'new.js'), 'utf8'), 'new\n');
  // A reviewer sees the requester's diff and status there.
  assert.equal(git(copy.path, 'diff'), git(checkout, 'diff'));
  assert.equal(git(copy.path, 'status', '--porcelain'), status);
  await assert.rejects(readFile(path.join(copy.path, 'dist', 'out.js')));
  assert.ok((await readdir(path.join(copy.path, 'node_modules'))).includes('dep'));
  await writeFile(path.join(copy.path, 'src', 'a.js'), 'changed in the copy\n');
  await mkdir(path.join(copy.path, 'dist'), { recursive: true });
  await writeFile(path.join(copy.path, 'dist', 'out.js'), 'rebuilt\n');
  assert.equal(await readFile(path.join(checkout, 'src', 'a.js'), 'utf8'), 'two\n');
  assert.equal(await readFile(path.join(checkout, 'dist', 'out.js'), 'utf8'), 'built\n');
  assert.equal(git(checkout, 'status', '--porcelain'), status);

  await removeCopy(copy);
  await assert.rejects(readdir(copy.path));
  assert.ok((await readdir(path.join(checkout, 'node_modules'))).includes('dep'));
  assert.doesNotMatch(git(checkout, 'worktree', 'list'), /copies/);
  const again = await createCopy(checkout, path.join(directory, 'copies'), 'a2');
  assert.equal(await reclaimCopies(path.join(directory, 'copies')), 1);
  await assert.rejects(readdir(again.path));
});

test('an assignment with workdir copy writes, builds and tests in its copy, which goes when it ends', async t => {
  const { directory, root, home } = await project(t, { profiles: { review: { base: 'read-only', workdir: 'copy', allow: ['Bash(npm test *)'] } }, agents: { reviewer: 'review' } });
  git(root, 'init', '-q'); git(root, 'add', '-A'); git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const previous = process.env.ALP_CLAUDE_SANDBOX;
  process.env.ALP_CLAUDE_SANDBOX = '1';
  t.after(() => { if (previous === undefined) delete process.env.ALP_CLAUDE_SANDBOX; else process.env.ALP_CLAUDE_SANDBOX = previous; });
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs'), copyDir: path.join(directory, 'copies') });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, model: 'codex:gpt-6.1-sol' });
  await until(() => runtimes.length === 2);
  const [main] = runtimes;
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Review' }] });

  // Codex: the copy is its workspace; the requester's tree is not writable.
  const started = await main.call('alp_delegate', { agent: 'reviewer', task: 'Review and test', wait: false });
  assert.equal(started.workdirNote, 'reviewer works in a disposable copy of your tree; nothing it changes reaches yours');
  await until(() => runtimes.length === 3 && runtimes[2].started.length === 1);
  const codex = runtimes[2];
  const copy = codex.config.cwd;
  assert.ok(copy.startsWith(path.join(directory, 'copies')));
  assert.deepEqual([codex.config.sandbox, codex.started[0].params.sandboxPolicy.type, codex.started[0].params.sandboxPolicy.writableRoots], ['workspace-write', 'workspaceWrite', [copy]]);
  assert.match(codex.config.developerInstructions, /You work in a disposable copy of your requester's tree at /);
  // To ALP it stays read-only: it claims nothing.
  assert.match((await codex.call('alp_pin', { kind: 'claim', paths: ['src'], body: 'x' })).error, /read-only session changes no files/);
  assert.match(codex.config.developerInstructions, new RegExp(`mirroring ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. .*Never run a command in, or write to, the requester's tree\\.`));
  assert.match(main.config.developerInstructions, /reviewer: at most read-only, may also run Bash\(npm test \*\), and works in a disposable copy of your tree, so name paths relative to the project/);
  // Codex lets a command write where it runs, so ALP reports commands run in the requester's tree.
  codex.notification('item/started', { threadId: codex.threadId, item: { type: 'commandExecution', id: 'c1', command: "/bin/zsh -lc 'npm test'", cwd: root, status: 'inProgress' } });
  codex.notification('item/started', { threadId: codex.threadId, item: { type: 'commandExecution', id: 'c2', command: "/bin/zsh -lc 'git diff'", cwd: copy, status: 'inProgress' } });
  codex.call('alp_handoff', { outcome: 'complete', summary: 'Tests pass in the copy' });
  codex.finish('Done');
  const waited = await main.call('alp_wait', {});
  assert.match(JSON.stringify(waited), /reviewer ran commands in your tree, not its copy; they may have changed files there: npm test \(in [^)]*\/project\)"/);
  await assert.rejects(readdir(copy));

  // Claude: Bash sandboxed to the copy.
  await main.call('alp_delegate', { agent: 'reviewer', task: 'Review again', model: 'claude:claude-sonnet-5-5', wait: false });
  await until(() => runtimes.length === 4 && runtimes[3].started.length === 1);
  const claude = runtimes[3];
  assert.deepEqual([claude.config.sandbox, claude.config.floor], ['workspace-write', 'workspace-write']);
  assert.match(claude.config.developerInstructions, /Bash runs in an OS sandbox: it writes only .*copies.* and temporary files, and has no network\. Run any command you need for your work in it\. To run a command outside it .* set dangerouslyDisableSandbox/);
  claude.call('alp_handoff', { outcome: 'complete', summary: 'Done' });
  claude.finish('Done');
  await main.call('alp_wait', {});

  // Without the sandbox, a Claude reviewer cannot get a copy.
  process.env.ALP_CLAUDE_SANDBOX = '0';
  assert.match((await main.call('alp_delegate', { agent: 'reviewer', task: 'Once more', model: 'claude:claude-sonnet-5-5' })).error, /A review copy on Claude needs its Bash sandbox/);
  main.finish('Done');
  await until(async () => (await readdir(path.join(directory, 'copies')).catch(() => [])).length === 0);
  const copies = async () => (await readFile(path.join(directory, 'runs', 'root.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).event).filter(event => event.startsWith('copy.'));
  await until(async () => (await copies()).length === 7);
  assert.deepEqual(await copies(), ['copy.created', 'copy.escape', 'copy.removed', 'copy.created', 'copy.removed', 'copy.created', 'copy.removed']);
});

test('advisors on Claude run Bash in a read-only floor by default', async t => {
  const { directory, root, home } = await project(t);
  const previous = process.env.ALP_CLAUDE_SANDBOX;
  process.env.ALP_CLAUDE_SANDBOX = '1';
  t.after(() => { if (previous === undefined) delete process.env.ALP_CLAUDE_SANDBOX; else process.env.ALP_CLAUDE_SANDBOX = previous; });
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), libraryDir: home, runLogDir: path.join(directory, 'runs') });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root });
  await until(() => runtimes.length === 2);
  const [main, supervisor] = runtimes;
  assert.equal(main.config.floor, undefined);
  assert.deepEqual([supervisor.config.floor, supervisor.config.sandbox], ['read-only', 'read-only']);
  assert.match(supervisor.config.developerInstructions, /Bash runs in an OS sandbox: it writes nothing but temporary files, and has no network\. Run any command you need for your work in it\./);
  assert.doesNotMatch(supervisor.config.developerInstructions, /dangerouslyDisableSandbox/);
});
