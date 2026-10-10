import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  assert.equal((await ask(client, { type: 'checkout_pr_status_request', requestId: 'c2', cwd: root })).payload.authState, 'unavailable');
  assert.deepEqual((await ask(client, { type: 'list_terminals_request', requestId: 't1', cwd: root })).payload.terminals, []);
  assert.equal((await ask(client, { type: 'subscribe_terminals_request', requestId: 't2', cwd: root })).type, 'terminals_changed');
  assert.equal((await ask(client, { type: 'workspace_setup_status_request', requestId: 'w1', workspaceId: root })).payload.snapshot, null);
  assert.equal((await ask(client, { type: 'get_daemon_config_request', requestId: 'd1' })).payload.config.pluginsEnabled, false);
  assert.deepEqual((await ask(client, { type: 'list_provider_features_request', requestId: 'p1', draftConfig: { provider: 'alp', cwd: root } })).payload.features, []);
  assert.deepEqual((await ask(client, { type: 'directory_suggestions_request', requestId: 's1', query: 'src' })).payload.directories, []);
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
