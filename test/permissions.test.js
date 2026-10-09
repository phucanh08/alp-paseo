import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../src/core/init.js';
import { commandDecision, parseRule, profileFor, simpleCommands, unwrapShell, validatePermissions } from '../src/core/permissions.js';
import { claudePermissions, createAlpRuntime, resolveSession } from '../dist/runtime/index.js';

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
  assert.throws(check({ profiles: { r: { ask: [] } } }), /unsupported field 'ask'/);
  assert.throws(check({ profiles: { r: { allow: ['npm test'] } } }), /permissions\.profiles\.r\.allow: "npm test" is not Tool/);
  assert.throws(check({ agents: { reviewer: 3 } }), /permissions\.agents\.reviewer must name a profile/);
  assert.deepEqual(check({ profiles: { r: { base: 'read-only', allow: [' Bash(npm test:*) '] } }, agents: { reviewer: 'r' } })(),
    { profiles: { r: { base: 'read-only', allow: ['Bash(npm test:*)'], deny: [] } }, agents: { reviewer: 'r' } });
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
  assert.equal(unwrapShell(`/bin/bash -c 'echo '\\''hi'\\'''`), "echo 'hi'");
  assert.deepEqual(simpleCommands('a && b || c; d | e\nf & g'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

test('profiles merge the project and the user, cap modes, and keep advisors read-only', async t => {
  const { root, home } = await project(t,
    { profiles: { review: { base: 'read-only', allow: ['Bash(npm test:*)'] }, builder: { base: 'workspace-write', deny: ['Bash(git push:*)'] } }, agents: { reviewer: 'review', peer: 'builder', main: 'builder' } },
    { profiles: { review: { base: 'full-access', allow: ['Bash(node --test:*)'], deny: ['Bash(rm:*)'] } }, agents: { reviewer: 'other', lead: 'workspace-write' } });
  assert.deepEqual(await profileFor(root, home, 'reviewer'), { name: 'review', base: 'read-only', allow: ['Bash(npm test:*)', 'Bash(node --test:*)'], deny: ['Bash(rm:*)'] });
  assert.deepEqual(await profileFor(root, home, 'oracle'), { name: 'read-only', base: 'read-only', allow: [], deny: [] });
  assert.deepEqual(await profileFor(root, home, 'lead'), { name: 'workspace-write', base: 'workspace-write', allow: [], deny: [] });
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

  const log = (await readFile(path.join(directory, 'runs', 'root.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.event === 'permission');
  assert.deepEqual(log.map(entry => [entry.agent, entry.request, entry.decision, entry.rule ?? null]), [
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
  assert.deepEqual([main.config.runtime, main.config.permissions, supervisor.config.permissions], ['claude', null, { name: 'read-only', base: 'read-only', allow: [], deny: [] }]);
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Review' }] });
  await main.call('alp_delegate', { agent: 'reviewer', task: 'Review', model: 'claude:claude-sonnet-5-5', wait: false });
  await until(() => runtimes.length === 3);
  assert.deepEqual(runtimes[2].config.permissions, { name: 'review', base: 'read-only', allow: ['Bash(npm test:*)'], deny: [] });
});

test('the CLI lists profiles and checks a command against one', async t => {
  const { root, home } = await project(t, { profiles: { review: { base: 'read-only', allow: ['Bash(npm test:*)'], deny: ['Bash(rm:*)'] } }, agents: { reviewer: 'review' } });
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ALP_HOME: home } });
  const listed = run('permissions');
  assert.match(listed.stdout, /^main {2}no profile: the mode its requester or the user chooses$/m);
  assert.match(listed.stdout, /^reviewer {2}profile review, at most read-only\n {2}allow: Bash\(npm test:\*\)\n {2}deny: {2}Bash\(rm:\*\)$/m);
  assert.match(listed.stdout, /^oracle {2}profile read-only, at most read-only$/m);
  assert.match(run('permissions', 'check', 'reviewer', 'npm test 2>&1').stdout, /^allow: profile review lets reviewer run it, even beyond its read-only mode/);
  assert.match(run('permissions', 'check', 'reviewer', 'npm test; rm -rf /').stdout, /^deny: a deny rule of profile review covers it/);
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
