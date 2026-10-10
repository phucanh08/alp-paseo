import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import WebSocket from 'ws';
import { validateWSOutboundMessage } from '@getpaseo/protocol/validation/ws-outbound';
import { createAlpRuntime } from '../dist/runtime/index.js';
import { createDaemonServer, createPaseoBridge, createWebServer } from '../dist/daemon/index.js';
import { initProject } from '../src/core/init.js';
import { fakeTransport, until } from './support/fake-agent.js';

/** alpd in this process serving a stand-in for the built ALP web app (Paseo's app, ALPD §62). */
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-paseo-web-'));
  const home = path.join(directory, 'home');
  const root = path.join(directory, 'project');
  await initProject(root);
  const agents = [];
  const dir = path.join(directory, 'web-app');
  await mkdir(path.join(dir, '_expo/static/js/web'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>ALP</title><script src="/_expo/static/js/web/index-1.js" defer></script>');
  const bundle = `console.log(${JSON.stringify('x'.repeat(4000))})`;
  await writeFile(path.join(dir, '_expo/static/js/web/index-1.js'), bundle);
  await writeFile(path.join(dir, '_expo/static/js/web/index-1.js.br'), brotliCompressSync(bundle));
  await writeFile(path.join(directory, 'secret.txt'), 'no');
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(agents), supervisor: false, libraryDir: home });
  const daemon = createDaemonServer({ runtime, socketPath: '', version: 'test' });
  let web;
  const gateway = createPaseoBridge({ daemon, version: 'test', home, token: () => web.token, serverId: () => web.serverId });
  web = createWebServer({ daemon, home, port: 0, assets: {}, app: { dir, gateway } });
  const info = await web.listen();
  t.after(async () => { await web.close(); await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const origin = `http://127.0.0.1:${info.port}`;
  /** A socket as the app opens it: every frame alpd sends must pass Paseo's own validator. */
  const socket = (options = {}) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, options.protocols ?? [], { headers: { Origin: options.origin ?? origin } });
    const frames = [];
    const waiting = [];
    ws.on('message', data => {
      const frame = JSON.parse(String(data));
      const checked = validateWSOutboundMessage(frame);
      assert.ok(checked.success, `alpd sent a frame Paseo's app drops: ${JSON.stringify(frame).slice(0, 300)}\n${checked.error}`);
      frames.push(frame);
      for (const wait of [...waiting]) if (wait.test(frame)) { waiting.splice(waiting.indexOf(wait), 1); wait.resolve(frame); }
    });
    ws.on('unexpected-response', (_request, response) => reject(new Error(`refused ${response.statusCode}`)));
    ws.on('error', reject);
    ws.on('open', () => {
      t.after(() => ws.close());
      const next = test => new Promise(done => { const found = frames.find(test); if (found) done(found); else waiting.push({ test, resolve: done }); });
      const closed = new Promise(done => ws.on('close', (code, reason) => done({ code, reason: String(reason) })));
      resolve({ ws, frames, next, closed, send: frame => ws.send(JSON.stringify(frame)) });
    });
  });
  const hello = (extra = {}) => ({ type: 'hello', clientId: 'cid-test', clientType: 'browser', protocolVersion: 1, capabilities: { helloRejection: true }, ...extra });
  const session = (client, message) => client.send({ type: 'session', message });
  /** A client past hello, as the app is once it shows anything. */
  const connected = async () => {
    const client = await socket();
    client.send(hello({ auth: { kind: 'password', password: info.token } }));
    await client.next(frame => frame.message?.payload?.status === 'server_info');
    return client;
  };
  /** Sends a request and waits for the reply that carries its requestId. */
  const ask = async (client, message) => {
    session(client, message);
    return (await client.next(frame => frame.message?.payload?.requestId === message.requestId)).message;
  };
  return { info, origin, socket, hello, session, connected, ask, root, agents, home };
}

test('alpd serves the built app: compressed bundles, the page for any route, nothing outside it', async t => {
  const { origin } = await setup(t);
  const page = await fetch(`${origin}/workspace/abc`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>ALP/);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const bundle = await fetch(`${origin}/_expo/static/js/web/index-1.js`, { headers: { 'accept-encoding': 'br' } });
  assert.equal(bundle.headers.get('content-encoding'), 'br');
  assert.equal(bundle.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(await bundle.text(), /^console\.log/);
  assert.equal((await fetch(`${origin}/_expo/static/js/web/missing.js`)).status, 404);
  // Encoded climbs stay inside the app's directory.
  const climb = await fetch(`${origin}/_expo/..%2f..%2f..%2fsecret.txt`);
  assert.equal(climb.status, 404);
});

test('the socket wants the token at hello, then speaks Paseo: server_info, pongs, and "in development" for the rest', async t => {
  const { socket, hello, session, info, home } = await setup(t);
  await assert.rejects(socket({ origin: 'https://attacker.example' }), /refused 403/);

  const anonymous = await socket();
  anonymous.send(hello());
  assert.equal((await anonymous.next(frame => frame.type === 'hello.rejected')).reason, 'password_required');
  assert.equal((await anonymous.closed).code, 4401);

  const wrong = await socket();
  wrong.send(hello({ auth: { kind: 'password', password: '0'.repeat(64) } }));
  assert.equal((await wrong.next(frame => frame.type === 'hello.rejected')).reason, 'incorrect_password');

  const client = await socket();
  client.send(hello({ auth: { kind: 'password', password: info.token } }));
  const serverInfo = await client.next(frame => frame.message?.payload?.status === 'server_info');
  assert.equal(serverInfo.message.payload.serverId, info.serverId);
  assert.match(info.serverId, /^alp-[0-9a-f]{16}$/);
  // Paseo's buttons that only act on a click show, and answer "in development" until ALP has them.
  assert.equal(serverInfo.message.payload.features.projectAdd, true);
  assert.equal(serverInfo.message.payload.features.ownedSubscriptions, undefined);
  // Voice and dictation say why they are off instead of waiting on an answer.
  assert.deepEqual(serverInfo.message.payload.capabilities.voice.dictation, { enabled: false, reason: 'Tính năng đang phát triển' });
  client.send({ type: 'ping' });
  await client.next(frame => frame.type === 'pong');
  session(client, { type: 'ping', requestId: 'p1', clientSentAt: 5 });
  assert.equal((await client.next(frame => frame.message?.type === 'pong')).message.payload.clientSentAt, 5);
  session(client, { type: 'create_terminal_request', requestId: 'r1', cwd: '/' });
  const refused = await client.next(frame => frame.message?.type === 'rpc_error');
  // The app shows the text as it is, in the user's language: Vietnamese unless settings say.
  assert.deepEqual(refused.message.payload, { requestId: 'r1', requestType: 'create_terminal_request', error: 'Tính năng đang phát triển', code: 'not_implemented' });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ language: 'English' }));
  session(client, { type: 'create_terminal_request', requestId: 'r2', cwd: '/' });
  assert.equal((await client.next(frame => frame.message?.payload?.requestId === 'r2')).message.payload.error, 'This feature is in development');
});

test('a browser may carry the token as the paseo.bearer subprotocol, and gets it echoed', async t => {
  const { socket, hello, info } = await setup(t);
  const client = await socket({ protocols: [`paseo.bearer.${info.token}`] });
  assert.equal(client.ws.protocol, `paseo.bearer.${info.token}`);
  client.send(hello());
  await client.next(frame => frame.message?.payload?.status === 'server_info');
});

test('what the app reads by itself gets the empty answer of a daemon without that feature', async t => {
  const { connected, ask, root } = await setup(t);
  const client = await connected();
  assert.deepEqual((await ask(client, { type: 'project_icon_request', requestId: 'i1', cwd: root })).payload, { requestId: 'i1', cwd: root, icon: null, error: null });
  assert.equal((await ask(client, { type: 'checkout_status_request', requestId: 'c1', cwd: root })).payload.isGit, false);
  assert.equal((await ask(client, { type: 'checkout_pr_status_request', requestId: 'c2', cwd: root })).payload.authState, 'no_remote');
  assert.deepEqual((await ask(client, { type: 'list_terminals_request', requestId: 't1', cwd: root })).payload.terminals, []);
  assert.equal((await ask(client, { type: 'subscribe_terminals_request', requestId: 't2', cwd: root })).type, 'terminals_changed');
  assert.equal((await ask(client, { type: 'workspace_setup_status_request', requestId: 'w1', workspaceId: root })).payload.snapshot, null);
  assert.equal((await ask(client, { type: 'get_daemon_config_request', requestId: 'd1' })).payload.config.pluginsEnabled, true);
  assert.deepEqual((await ask(client, { type: 'list_provider_features_request', requestId: 'p1', draftConfig: { provider: 'alp', cwd: root } })).payload.features, []);
  assert.deepEqual((await ask(client, { type: 'directory_suggestions_request', requestId: 's1', query: '' })).payload.directories, []);
});

test('the app starts an ALP session as an agent, sees it stream, reads its timeline and talks to it', async t => {
  const { connected, ask, root, agents } = await setup(t);
  const client = await connected();
  assert.deepEqual((await ask(client, { type: 'fetch_agents_request', requestId: 'f1' })).payload.entries, []);
  const providers = (await ask(client, { type: 'get_providers_snapshot_request', requestId: 'p1', cwd: root })).payload.entries;
  assert.deepEqual(providers.map(entry => [entry.provider, entry.status]), [['alp', 'ready']]);
  assert.ok(providers[0].models.some(model => model.isDefault));

  const created = await ask(client, { type: 'create_agent_request', requestId: 'a1', config: { provider: 'alp', cwd: root, title: 'List the files' }, initialPrompt: 'List the files', clientMessageId: 'm1', labels: {} });
  assert.equal(created.payload.status, 'agent_created');
  const agentId = created.payload.agentId;
  assert.equal(created.payload.agent.title, 'List the files');
  assert.equal(created.payload.agent.provider, 'alp');
  await until(() => agents[0]?.started.length === 1, 'the first turn');
  await client.next(frame => frame.message?.type === 'agent_stream' && frame.message.payload.event.type === 'turn_started');

  agents[0].finish('Two files: ALP.md and README.md.');
  await client.next(frame => frame.message?.type === 'agent_stream' && frame.message.payload.event.type === 'turn_completed');
  const streamed = client.frames.filter(frame => frame.message?.type === 'agent_stream' && frame.message.payload.event.type === 'timeline').map(frame => frame.message.payload);
  assert.ok(streamed.every(payload => payload.agentId === agentId && typeof payload.seq === 'number' && payload.epoch));
  assert.ok(streamed.some(payload => payload.event.item.type === 'assistant_message' && payload.event.item.text === 'Two files: ALP.md and README.md.'));

  const listed = (await ask(client, { type: 'fetch_agents_request', requestId: 'f2' })).payload.entries;
  assert.deepEqual(listed.map(entry => [entry.agent.id, entry.agent.cwd]), [[agentId, root]]);
  const timeline = (await ask(client, { type: 'fetch_agent_timeline_request', requestId: 'tl1', agentId })).payload;
  assert.equal(timeline.error, null);
  const items = timeline.entries.map(entry => [entry.item.type, entry.item.text]);
  assert.deepEqual(items.filter(([type]) => type === 'user_message' || type === 'assistant_message'), [['user_message', 'List the files'], ['assistant_message', 'Two files: ALP.md and README.md.']]);
  assert.equal(timeline.entries.find(entry => entry.item.type === 'user_message').item.messageId, 'm1');

  // Find in chat: the matching messages by their seq, with how often each matches, any case.
  const found = (await ask(client, { type: 'agent.timeline.search.request', requestId: 'q1', agentId, query: 'readme.MD' })).payload;
  assert.equal(found.error, null);
  assert.equal(found.epoch, timeline.epoch);
  assert.deepEqual(found.locations.map(location => [location.role, location.count]), [['assistant', 1]]);
  assert.deepEqual((await ask(client, { type: 'agent.timeline.search.request', requestId: 'q2', agentId, query: 'files' })).payload.locations.map(location => location.role), ['user', 'assistant']);
  assert.equal((await ask(client, { type: 'agent.timeline.search.request', requestId: 'q3', agentId: 'missing', query: 'x' })).payload.error, 'No agent missing');

  const sent = await ask(client, { type: 'send_agent_message_request', requestId: 's1', agentId, text: 'Thanks', messageId: 'm2' });
  assert.deepEqual(sent.payload, { requestId: 's1', agentId, accepted: true, error: null });
  await until(() => agents[0].started.length === 2, 'the second turn');
  assert.equal((await ask(client, { type: 'fetch_agent_timeline_request', requestId: 'tl2', agentId: 'missing' })).payload.error, 'No agent missing');

  const renamed = await ask(client, { type: 'update_agent_request', requestId: 'u1', agentId, name: 'Files' });
  assert.equal(renamed.payload.accepted, true);
  const archived = await ask(client, { type: 'archive_agent_request', requestId: 'r1', agentId });
  assert.equal(archived.type, 'agent_archived');
  assert.deepEqual((await ask(client, { type: 'fetch_agents_request', requestId: 'f3' })).payload.entries, []);

  // History keeps archived agents, and searches, sorts and pages them.
  const second = (await ask(client, { type: 'create_agent_request', requestId: 'a2', config: { provider: 'alp', cwd: root, title: 'Write the docs' }, labels: {} })).payload.agentId;
  const history = async (extra = {}) => (await ask(client, { type: 'fetch_agent_history_request', requestId: `h${Math.random()}`, ...extra })).payload;
  assert.deepEqual((await history()).entries.map(entry => entry.agent.title), ['Write the docs', 'Files']);
  assert.ok((await history()).entries[1].agent.archivedAt);
  assert.deepEqual((await history({ search: 'FILES' })).entries.map(entry => entry.agent.id), [agentId]);
  assert.deepEqual((await history({ sort: [{ key: 'title', direction: 'asc' }] })).entries.map(entry => entry.agent.id), [agentId, second]);
  assert.deepEqual((await history({ filter: { includeArchived: false } })).entries.map(entry => entry.agent.id), [second]);
  const first = await history({ page: { limit: 1 } });
  assert.deepEqual([first.entries.length, first.pageInfo.hasMore, first.pageInfo.nextCursor], [1, true, '1']);
  assert.equal((await history({ page: { limit: 1, cursor: '1' } })).entries[0].agent.id, agentId);
});

test('what an agent asks the user is a question card on its root, answered from the app or dismissed', async t => {
  const { connected, ask, session, root, agents } = await setup(t);
  const client = await connected();
  const created = await ask(client, { type: 'create_agent_request', requestId: 'a1', config: { provider: 'alp', cwd: root }, initialPrompt: 'Pick a colour', labels: {} });
  const agentId = created.payload.agentId;
  await until(() => agents[0]?.started.length === 1, 'the first turn');

  const answer = agents[0].call('alp_ask', { to: 'user', question: 'Which colour?', options: ['Red', 'Blue'] });
  const asked = (await client.next(frame => frame.message?.type === 'agent_permission_request')).message.payload;
  assert.equal(asked.agentId, agentId);
  assert.equal(asked.request.kind, 'question');
  const [question] = asked.request.input.questions;
  assert.equal(question.question, 'Which colour?');
  assert.deepEqual(question.options, [{ label: 'Red' }, { label: 'Blue' }]);
  assert.equal(question.allowOther, true);
  await client.next(frame => frame.message?.type === 'agent_stream' && frame.message.payload.event.type === 'attention_required' && frame.message.payload.event.reason === 'permission');
  const waiting = (await ask(client, { type: 'fetch_agent_request', requestId: 'g1', agentId })).payload.agent;
  assert.deepEqual(waiting.pendingPermissions.map(request => request.id), [asked.request.id]);
  assert.equal(waiting.attentionReason, 'permission');

  // The card answers as Paseo's does: the input back, with the answers by header.
  const response = { behavior: 'allow', updatedInput: { ...asked.request.input, answers: { [question.header]: 'Blue' } } };
  session(client, { type: 'agent_permission_response', agentId, requestId: asked.request.id, response });
  assert.equal((await answer).answer, 'Blue');
  const resolvedFrame = (await client.next(frame => frame.message?.type === 'agent_permission_resolved')).message.payload;
  assert.deepEqual(resolvedFrame, { agentId, requestId: asked.request.id, resolution: response });
  assert.deepEqual((await ask(client, { type: 'fetch_agent_request', requestId: 'g2', agentId })).payload.agent.pendingPermissions, []);

  const dismissed = agents[0].call('alp_ask', { to: 'user', question: 'Anything else?' });
  const second = (await client.next(frame => frame.message?.type === 'agent_permission_request' && frame.message.payload.request.id !== asked.request.id)).message.payload;
  assert.deepEqual(second.request.input.questions[0].options, []);
  session(client, { type: 'agent_permission_response', agentId, requestId: second.request.id, response: { behavior: 'deny', message: 'Dismissed by user' } });
  assert.equal((await dismissed).status, 'dismissed');
  await client.next(frame => frame.message?.type === 'agent_permission_resolved' && frame.message.payload.requestId === second.request.id);
});

test('projects and workspaces are kept by alpd: add, create with an agent, title, pin, labels, unread, archive, remove', async t => {
  const { connected, ask, root, agents, home } = await setup(t);
  const client = await connected();
  const empty = (await ask(client, { type: 'fetch_workspaces_request', requestId: 'w0' })).payload;
  assert.deepEqual([empty.entries, empty.emptyProjects, empty.pageInfo.hasMore], [[], [], false]);

  // The folder to add: typed as a path, its parent's folders that start so; a workspace's files by name.
  await mkdir(path.join(root, 'docs', 'guide'), { recursive: true });
  await writeFile(path.join(root, 'docs', 'guide', 'intro.md'), '# Intro');
  const typed = (await ask(client, { type: 'directory_suggestions_request', requestId: 's1', query: `${root}/do`, includeDirectories: true, includeFiles: false })).payload;
  assert.deepEqual(typed.entries, [{ path: path.join(root, 'docs'), kind: 'directory' }]);
  const files = (await ask(client, { type: 'directory_suggestions_request', requestId: 's2', cwd: root, query: 'intro', includeFiles: true, includeDirectories: false })).payload;
  assert.deepEqual(files.entries, [{ path: 'docs/guide/intro.md', kind: 'file' }]);
  const suffix = (await ask(client, { type: 'directory_suggestions_request', requestId: 's3', cwd: root, query: 'guide/intro.md', matchMode: 'suffix', includeFiles: true })).payload;
  assert.deepEqual(suffix.entries.map(entry => entry.path), ['docs/guide/intro.md']);

  // A project is a directory; one that is not there says so.
  const missing = (await ask(client, { type: 'project.add.request', requestId: 'p0', cwd: path.join(root, 'nope') })).payload;
  assert.deepEqual([missing.project, missing.errorCode], [null, 'directory_not_found']);
  const project = (await ask(client, { type: 'project.add.request', requestId: 'p1', cwd: root })).payload.project;
  assert.match(project.projectId, /^prj_[0-9a-f]{16}$/);
  assert.deepEqual([project.projectRootPath, project.projectDisplayName, project.projectKind], [root, 'project', 'non_git']);
  await client.next(frame => frame.message?.type === 'project.update' && frame.message.payload.project?.projectId === project.projectId);
  assert.equal((await ask(client, { type: 'project.add.request', requestId: 'p2', cwd: root })).payload.project.projectId, project.projectId);
  assert.deepEqual((await ask(client, { type: 'project.list.request', requestId: 'l1' })).payload.projects.map(entry => entry.projectId), [project.projectId]);
  assert.deepEqual((await ask(client, { type: 'fetch_workspaces_request', requestId: 'w1' })).payload.emptyProjects.map(entry => entry.projectId), [project.projectId]);

  // A workspace made with its first agent: the agent runs in it.
  const made = (await ask(client, { type: 'workspace.create.request', requestId: 'c1', source: { kind: 'directory', path: root, projectId: project.projectId }, agent: { config: { provider: 'alp', cwd: root }, initialPrompt: 'Hello', labels: {} } })).payload;
  assert.equal(made.error, null);
  const workspaceId = made.workspace.id;
  assert.match(workspaceId, /^wks_[0-9a-f]{16}$/);
  assert.deepEqual([made.workspace.projectId, made.workspace.name, made.workspace.workspaceKind], [project.projectId, 'project', 'directory']);
  assert.equal(made.agent.workspaceId, workspaceId);
  await until(() => agents[0]?.started.length === 1, 'the first turn');
  agents[0].finish('Hi.');
  await client.next(frame => frame.message?.type === 'workspace_update' && frame.message.payload.workspace?.status === 'attention');
  const listed = (await ask(client, { type: 'fetch_agents_request', requestId: 'f1' })).payload.entries;
  assert.deepEqual(listed.map(entry => [entry.agent.workspaceId, entry.project.projectKey]), [[workspaceId, project.projectId]]);
  // A worktree from the app is not in ALP yet.
  assert.equal((await ask(client, { type: 'workspace.create.request', requestId: 'c2', source: { kind: 'worktree', cwd: root } })).payload.error, 'Tính năng đang phát triển');

  const titled = await ask(client, { type: 'workspace.title.set.request', requestId: 't1', workspaceId, title: 'Docs' });
  assert.deepEqual([titled.payload.accepted, titled.payload.title], [true, 'Docs']);
  await client.next(frame => frame.message?.type === 'workspace_update' && frame.message.payload.workspace?.name === 'Docs');
  const pinned = (await ask(client, { type: 'workspace.pin.set.request', requestId: 'pin1', workspaceId, pinned: true })).payload;
  assert.ok(pinned.accepted && pinned.pinnedAt);
  await client.next(frame => frame.message?.type === 'workspace_update' && frame.message.payload.workspace?.pinnedAt === pinned.pinnedAt);

  // Labels: one catalog, each change the next seq of its generation.
  const assigned = (await ask(client, { type: 'workspace.label.assignment.set.request', requestId: 'lb1', workspaceId, label: { name: ' Urgent  work ', color: 'red' }, assigned: true })).payload;
  assert.deepEqual(assigned.workspaceLabels, ['Urgent work']);
  const first = (await client.next(frame => frame.message?.type === 'workspace.label.update')).message.payload;
  assert.deepEqual([first.kind, first.label, first.seq], ['upsert', { name: 'Urgent work', color: 'red' }, 1]);
  const catalog = (await ask(client, { type: 'workspace.label.list.request', requestId: 'lb2' })).payload;
  assert.deepEqual([catalog.labels, catalog.sync.mode, catalog.sync.headSeq, catalog.sync.generation], [[{ name: 'Urgent work', color: 'red' }], 'snapshot', 1, first.generation]);
  const renamed = (await ask(client, { type: 'workspace.label.update.request', requestId: 'lb3', name: 'urgent work', newName: 'Soon', color: 'amber' })).payload;
  assert.deepEqual([renamed.label, renamed.affectedWorkspaceCount], [{ name: 'Soon', color: 'amber' }, 1]);
  assert.equal((await client.next(frame => frame.message?.type === 'workspace.label.update' && frame.message.payload.seq === 2)).message.payload.previousName, 'Urgent work');
  assert.equal((await ask(client, { type: 'workspace.label.delete.inspect.request', requestId: 'lb4', name: 'SOON' })).payload.affectedWorkspaceCount, 1);
  assert.equal((await ask(client, { type: 'workspace.label.delete.request', requestId: 'lb5', name: 'Soon' })).payload.affectedWorkspaceCount, 1);
  assert.deepEqual((await ask(client, { type: 'fetch_workspaces_request', requestId: 'w2' })).payload.entries[0].labels, []);

  // Read, then unread again: the finished agent wants a look.
  const read = (await ask(client, { type: 'workspace.clear_attention.request', requestId: 'r1', workspaceId })).payload;
  assert.deepEqual([read.success, read.clearedAgentIds], [true, [made.agent.id]]);
  await client.next(frame => frame.message?.type === 'workspace_update' && frame.message.payload.workspace?.status === 'done');
  const unread = (await ask(client, { type: 'workspace.mark_unread.request', requestId: 'u1', workspaceId })).payload;
  assert.deepEqual([unread.success, unread.markedAgentId], [true, made.agent.id]);
  assert.equal((await ask(client, { type: 'fetch_agent_request', requestId: 'g1', agentId: made.agent.id })).payload.agent.requiresAttention, true);

  // Kept across restarts.
  const stored = JSON.parse(await readFile(path.join(home, 'state', 'web-workspaces.json'), 'utf8'));
  assert.deepEqual([stored.workspaces[0].id, stored.workspaces[0].title, stored.sessions[made.agent.id]], [workspaceId, 'Docs', workspaceId]);

  // Archiving archives its agents, and the project stays with no workspace.
  const archived = (await ask(client, { type: 'archive_workspace_request', requestId: 'a1', workspaceId })).payload;
  assert.ok(archived.archivedAt);
  const removal = (await client.next(frame => frame.message?.type === 'workspace_update' && frame.message.payload.kind === 'remove')).message.payload;
  assert.deepEqual([removal.id, removal.emptyProject?.projectId], [workspaceId, project.projectId]);
  assert.deepEqual((await ask(client, { type: 'fetch_agents_request', requestId: 'f2' })).payload.entries, []);
  const after = (await ask(client, { type: 'fetch_workspaces_request', requestId: 'w3' })).payload;
  assert.deepEqual([after.entries, after.emptyProjects.map(entry => entry.projectId)], [[], [project.projectId]]);

  // A folder made from the app is a project; removing one takes it away.
  const folder = (await ask(client, { type: 'project.create_directory.request', requestId: 'd1', parentPath: path.dirname(root), name: 'fresh' })).payload;
  assert.equal(folder.directoryPath, path.join(path.dirname(root), 'fresh'));
  assert.equal((await ask(client, { type: 'project.create_directory.request', requestId: 'd2', parentPath: path.dirname(root), name: '../x' })).payload.errorCode, 'invalid_name');
  const removed = (await ask(client, { type: 'project.remove.request', requestId: 'x1', projectId: folder.project.projectId })).payload;
  assert.equal(removed.accepted, true);
  await client.next(frame => frame.message?.type === 'project.update' && frame.message.payload.kind === 'remove' && frame.message.payload.projectId === folder.project.projectId);
  assert.deepEqual((await ask(client, { type: 'project.list.request', requestId: 'l2' })).payload.projects.map(entry => entry.projectId), [project.projectId]);
});

test("ALP's plugin runs in the app from alpd: its script, catalog and RPCs", async t => {
  const { connected, ask, root, origin } = await setup(t);
  // The plugin's code is a same-origin script, so the page needs no 'unsafe-eval'.
  const script = await fetch(`${origin}/alp-plugins.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  assert.doesNotMatch(script.headers.get('content-security-policy'), / 'unsafe-eval'/);
  const code = await script.text();
  assert.match(code, /^window\.__ALP_PLUGINS__ = Object\.assign\(window\.__ALP_PLUGINS__ \|\| \{\}, \{ "alp-provider": \(function\(require\)/);
  const factory = new Function('window', `${code}; return window.__ALP_PLUGINS__['alp-provider'];`)({});
  // Paseo's app calls it with its require shim and takes the default export as the plugin's setup.
  const anything = new Proxy(function () {}, { get: (_target, key) => key === '__esModule' ? undefined : anything, apply: () => anything, construct: () => anything });
  const shim = name => { if (['react', 'react/jsx-runtime', 'react-native', '@tanstack/react-query', 'zod'].includes(name) || name.startsWith('@getpaseo/plugin')) return anything; throw new Error(`not in the app: ${name}`); };
  assert.equal(typeof factory(shim).default, 'function');

  const client = await connected();
  const features = client.frames.find(frame => frame.message?.payload?.status === 'server_info').message.payload.features;
  assert.deepEqual([features.plugins, features.pluginSettings, features.providerSubagents], [true, true, true]);
  const [entry] = (await ask(client, { type: 'plugin.catalog.get.request', requestId: 'c1' })).payload.plugins;
  assert.equal(entry.id, 'alp-provider');
  assert.match(entry.clientBundle, /^alp-preloaded:alp-provider:[0-9a-f]{16}$/);
  assert.ok(entry.requirements.paseo);
  assert.equal((await ask(client, { type: 'plugin.list.request', requestId: 'l1' })).payload.plugins[0].status, 'running');

  const invoke = async (method, input) => (await ask(client, { type: 'plugin.rpc.invoke.request', requestId: `${method}-${Math.random()}`, pluginId: 'alp-provider', method, input })).payload;
  assert.deepEqual((await invoke('alp.tasks.list', { directory: root })).output.tasks, []);
  const added = (await invoke('alp.tasks.add', { directory: root, title: 'Write the docs' })).output;
  assert.match(added.id, /^t-/);
  assert.deepEqual((await invoke('alp.tasks.list', { directory: root })).output.tasks.map(task => task.title), ['Write the docs']);
  assert.equal((await invoke('alp.tasks.change', { directory: root, id: added.id, action: 'close' })).output.status, 'closed');
  assert.ok((await invoke('alp.library.list', { directory: root, kind: 'teams' })).output.entries.length > 0);
  // A bad call fails as Paseo's daemon fails it, and an unknown one says so.
  assert.equal((await invoke('alp.tasks.add', { directory: root, title: '' })).code, 'handler_error');
  assert.equal((await invoke('alp.nope', {})).code, 'method_not_found');
});

test('the team members a root runs are its subagents, each with its own timeline', async t => {
  const { connected, ask, root, agents } = await setup(t);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'] } }));
  const client = await connected();
  const agentId = (await ask(client, { type: 'create_agent_request', requestId: 'a1', config: { provider: 'alp', cwd: root }, initialPrompt: 'Delegate', labels: {} })).payload.agentId;
  await until(() => agents[0]?.started.length === 1, 'the first turn');
  const lead = agents[0].call('alp_delegate', { agent: 'lead', wait: true, task: 'Investigate the logs' });
  const opened = (await client.next(frame => frame.message?.type === 'agent.provider_subagents.update' && frame.message.payload.kind === 'upsert')).message.payload.subagent;
  assert.deepEqual([opened.parentAgentId, opened.parentSubagentId, opened.title, opened.status, opened.provider], [agentId, null, 'lead', 'running', 'alp']);
  await until(() => agents[1]?.started.length === 1, "the lead's turn");
  agents[1].finish('Found it.');
  await lead;
  await client.next(frame => frame.message?.type === 'agent.provider_subagents.update' && frame.message.payload.subagent?.status === 'completed');
  const live = client.frames.filter(frame => frame.message?.type === 'agent.provider_subagents.update' && frame.message.payload.kind === 'timeline').map(frame => frame.message.payload);
  assert.ok(live.every(payload => payload.parentAgentId === agentId && payload.subagentId === opened.id && payload.epoch));
  assert.ok(live.some(payload => payload.item.type === 'assistant_message' && payload.item.text === 'Found it.'));
  // Neither on the root's own timeline.
  assert.ok(!client.frames.some(frame => frame.message?.type === 'agent_stream' && frame.message.payload.event.item?.text === 'Found it.'));

  const [listed] = (await ask(client, { type: 'agent.provider_subagents.list.request', requestId: 's1', parentAgentId: agentId })).payload.subagents;
  assert.deepEqual([listed.id, listed.status], [opened.id, 'completed']);
  assert.match(listed.description, /Investigate the logs/);
  const timeline = (await ask(client, { type: 'agent.provider_subagents.timeline.get.request', requestId: 's2', parentAgentId: agentId, subagentId: opened.id })).payload;
  assert.equal(timeline.error, null);
  assert.ok(timeline.rows.some(row => row.item.type === 'assistant_message' && row.item.text === 'Found it.'));
  assert.equal((await ask(client, { type: 'agent.provider_subagents.timeline.get.request', requestId: 's3', parentAgentId: agentId, subagentId: 'missing' })).payload.error, 'No subagent missing');
});

test("a checkout's branch, its changes as the Changes panel shows them, and its files, read-only", async t => {
  const { connected, ask, root } = await setup(t);
  const repo = path.join(path.dirname(root), 'repo');
  await mkdir(path.join(repo, 'docs'), { recursive: true });
  const run = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=ALP', '-c', 'user.email=alp@example.com', ...args], { encoding: 'utf8' });
  run('init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'README.md'), 'one\ntwo\nthree\n');
  await writeFile(path.join(repo, 'docs', 'guide.md'), '# Guide\n');
  await writeFile(path.join(repo, 'old.txt'), 'moved\n');
  run('add', '.');
  run('commit', '-q', '-m', 'first');
  await writeFile(path.join(repo, 'README.md'), 'one\n2\nthree\n');
  await writeFile(path.join(repo, 'new.txt'), 'fresh\n');
  await writeFile(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 5]));
  await writeFile(path.join(repo, 'dot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  await symlink(path.dirname(root), path.join(repo, 'outside'));
  const client = await connected();
  // Asking for the teams of a folder only reads it: no ALP.md or .alp appear in someone's repository.
  const teams = (await ask(client, { type: 'get_providers_snapshot_request', requestId: 'p0', cwd: repo })).payload.entries[0].models.map(model => model.id);
  assert.ok(teams.includes('pho'));
  assert.deepEqual([existsSync(path.join(repo, 'ALP.md')), existsSync(path.join(repo, '.alp'))], [false, false]);

  const status = (await ask(client, { type: 'checkout_status_request', requestId: 'c1', cwd: repo })).payload;
  assert.deepEqual([status.isGit, status.currentBranch, status.isDirty, status.baseRef, status.hasRemote, status.error], [true, 'main', true, 'main', false, null]);
  assert.equal(status.repoRoot, execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
  assert.equal((await ask(client, { type: 'checkout_status_request', requestId: 'c2', cwd: root })).payload.isGit, false);

  const diff = (await ask(client, { type: 'subscribe_checkout_diff_request', requestId: 'd1', subscriptionId: 'legacy:1', cwd: repo, compare: { mode: 'uncommitted' } })).payload;
  assert.equal(diff.subscriptionId, 'legacy:1');
  const byPath = Object.fromEntries(diff.files.map(file => [file.path, file]));
  assert.deepEqual(Object.keys(byPath).sort(), ['README.md', 'blob.bin', 'dot.png', 'new.txt']);
  assert.deepEqual([byPath['README.md'].additions, byPath['README.md'].deletions, byPath['README.md'].isNew], [1, 1, false]);
  assert.deepEqual(byPath['README.md'].hunks[0].lines.map(line => [line.type, line.content]), [['header', '@@ -1,3 +1,3 @@'], ['context', 'one'], ['remove', 'two'], ['add', '2'], ['context', 'three']]);
  assert.deepEqual([byPath['new.txt'].isNew, byPath['new.txt'].additions], [true, 1]);
  assert.equal(byPath['blob.bin'].status, 'binary');

  // A change goes out to the subscriber when the panel refreshes (and on alpd's own poll).
  run('mv', 'old.txt', 'moved.txt');
  const refreshed = (await ask(client, { type: 'checkout.refresh.request', requestId: 'r1', cwd: repo })).payload;
  assert.equal(refreshed.success, true);
  const pushed = client.frames.filter(frame => frame.message?.type === 'checkout_diff_update').at(-1).message.payload;
  assert.equal(pushed.subscriptionId, 'legacy:1');
  assert.equal(pushed.files.find(file => file.path === 'moved.txt')?.oldPath, 'old.txt');

  // Against the base branch: what the branch committed since it left main.
  run('checkout', '-q', '-b', 'feature');
  run('add', '.');
  run('commit', '-q', '-m', 'second');
  const branch = (await ask(client, { type: 'checkout_status_request', requestId: 'c3', cwd: repo })).payload;
  assert.deepEqual([branch.currentBranch, branch.baseRef, branch.aheadBehind, branch.isDirty], ['feature', 'main', { ahead: 1, behind: 0 }, false]);
  const base = (await ask(client, { type: 'subscribe_checkout_diff_request', requestId: 'd2', subscriptionId: 'legacy:2', cwd: repo, compare: { mode: 'base', baseRef: 'main' } })).payload;
  assert.deepEqual(base.files.map(file => file.path).sort(), ['README.md', 'blob.bin', 'dot.png', 'moved.txt', 'new.txt', 'outside']);
  client.send({ type: 'session', message: { type: 'unsubscribe_checkout_diff_request', subscriptionId: 'legacy:2' } });

  // The Files panel: entries with their kind, text, images, binaries; nothing outside the workspace.
  const listing = (await ask(client, { type: 'file_explorer_request', requestId: 'f1', cwd: repo, path: '.', mode: 'list' })).payload;
  assert.equal(listing.directory.path, '.');
  const names = listing.directory.entries.map(entry => entry.name);
  assert.ok(names.includes('docs') && names.includes('.git') && !names.includes('outside'));
  assert.equal(listing.directory.entries.find(entry => entry.name === 'docs').kind, 'directory');
  const docs = (await ask(client, { type: 'file_explorer_request', requestId: 'f2', cwd: repo, path: 'docs', mode: 'list' })).payload.directory;
  assert.deepEqual([docs.path, docs.entries.map(entry => entry.path)], ['docs', ['docs/guide.md']]);
  const text = (await ask(client, { type: 'file_explorer_request', requestId: 'f3', cwd: repo, path: 'docs/guide.md', mode: 'file', acceptBinary: true })).payload.file;
  assert.deepEqual([text.kind, text.encoding, text.content, text.mimeType], ['text', 'utf-8', '# Guide\n', 'text/plain']);
  const image = (await ask(client, { type: 'file_explorer_request', requestId: 'f4', cwd: repo, path: 'dot.png', mode: 'file' })).payload.file;
  assert.deepEqual([image.kind, image.encoding, image.mimeType, image.content], ['image', 'base64', 'image/png', 'iVBORw0KGgo=']);
  const binary = (await ask(client, { type: 'file_explorer_request', requestId: 'f5', cwd: repo, path: 'blob.bin', mode: 'file' })).payload.file;
  assert.deepEqual([binary.kind, binary.encoding, binary.content], ['binary', 'none', undefined]);
  assert.equal((await ask(client, { type: 'file_explorer_request', requestId: 'f6', cwd: repo, path: 'README.md', mode: 'file', maxBytes: 3 })).payload.error, 'File is too large to display');
  assert.equal((await ask(client, { type: 'file_explorer_request', requestId: 'f7', cwd: repo, path: '../project', mode: 'list' })).payload.error, 'Access outside of workspace is not allowed');
  assert.equal((await ask(client, { type: 'file_explorer_request', requestId: 'f8', cwd: repo, path: 'outside', mode: 'list' })).payload.error, 'Access outside of workspace is not allowed');
  // Committing is not in ALP yet.
  assert.equal((await ask(client, { type: 'checkout_commit_request', requestId: 'k1', cwd: repo, message: 'x', addAll: true })).payload.code, 'not_implemented');
});
