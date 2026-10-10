import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_LANGUAGE, languageSetting, setLanguage, userLanguage } from '../src/core/user-settings.js';
import { initProject } from '../src/core/init.js';
import { CHOICES, createAlpRuntime, isVietnamese, words } from '../dist/runtime/index.js';
import { fakeTransport, tree, until } from './support/fake-agent.js';

/**
 * The user's language (ALPD §54): set in $ALP_HOME/settings.json, Vietnamese when unset.
 * Agents write what the user reads in it, and ALP writes its approvals and notices in it.
 */
async function home(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-language-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('the language defaults to Vietnamese and is set or cleared in settings.json, keeping its other keys', async t => {
  const dir = await home(t);
  assert.equal(DEFAULT_LANGUAGE, 'Vietnamese');
  assert.equal(await userLanguage(dir), 'Vietnamese');
  assert.equal(await userLanguage(undefined), 'Vietnamese');
  assert.deepEqual(await languageSetting(dir), { language: null, applies: 'Vietnamese', default: 'Vietnamese' });
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ limits: { autoResume: true } }));
  assert.deepEqual(await setLanguage(dir, '  English '), { language: 'English', applies: 'English', default: 'Vietnamese' });
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')), { limits: { autoResume: true }, language: 'English' });
  assert.equal(await userLanguage(dir), 'English');
  for (const bad of ['', '   ', 'x'.repeat(41), 7]) await assert.rejects(setLanguage(dir, bad), /at most 40 characters/);
  assert.deepEqual(await setLanguage(dir, null), { language: null, applies: 'Vietnamese', default: 'Vietnamese' });
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')), { limits: { autoResume: true } });
  // A broken file never stops a session: the default applies.
  await writeFile(path.join(dir, 'settings.json'), '{ nope');
  assert.equal(await userLanguage(dir), 'Vietnamese');
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ language: 42 }));
  assert.equal(await userLanguage(dir), 'Vietnamese');
});

test('ALP has Vietnamese and English words, and accepts answers in either', () => {
  for (const name of ['Vietnamese', 'vi', 'Tiếng Việt', 'tieng viet']) assert.ok(isVietnamese(name), name);
  assert.equal(isVietnamese('English'), false);
  const vi = words('Vietnamese');
  assert.deepEqual([vi.approve, vi.reject, vi.allowOnce, vi.alwaysAllow, vi.deny], ['Duyệt', 'Từ chối', 'Cho phép lần này', 'Luôn cho phép', 'Từ chối']);
  assert.match(vi.limitReached('Codex', '12:35', 'Claude', true, 'codex'), /^Codex đã hết hạn mức sử dụng; hạn mức đặt lại lúc 12:35\. .*các agent Claude vẫn làm tiếp\. ALP tự chạy lại/);
  // Languages without a word table get English from ALP.
  assert.equal(words('Japanese').approve, 'Approve');
  assert.ok(CHOICES.allowOnce.includes('cho phép lần này') && CHOICES.allowOnce.includes('allow once'));
  assert.ok(CHOICES.trust.includes('tin cậy workspace này') && CHOICES.trust.includes('trust this workspace'));
});

test('main writes for the user in Vietnamese by default; an assignment asks the user in it', async t => {
  const { agents, main } = await tree(t, { options: () => ({ checkInMs: 0 }) });
  assert.match(main.config.developerInstructions, /The user reads Vietnamese\. Write in Vietnamese everything the user reads: your replies, questions you ask with alp_ask \(and their options\), approval requests/);
  await main.call('alp_delegate', { agent: 'peer', task: 'Look around', mode: 'read-only' });
  await until(() => agents[1]?.started.length, 'the peer to start');
  assert.match(agents[1].config.developerInstructions, /The user reads Vietnamese\. A question you put to the user with alp_ask, and its options, must be in Vietnamese/);
  assert.doesNotMatch(agents[1].config.developerInstructions, /Write in Vietnamese everything the user reads/);
});

test('the user\'s setting picks the language of main\'s instructions', async t => {
  const directory = await home(t);
  const root = path.join(directory, 'project');
  const library = path.join(directory, 'home');
  await initProject(root);
  await setLanguage(library, 'English');
  const agents = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(agents), supervisor: false, libraryDir: library });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root });
  assert.match(agents[0].config.developerInstructions, /The user reads English\. Write in English everything the user reads/);
  // A later session reads the setting again.
  await setLanguage(library, 'Japanese');
  await runtime.open('second', { cwd: root });
  assert.match(agents[1].config.developerInstructions, /The user reads Japanese\. Write in Japanese/);
});

test('alp language shows, sets and resets the language', async t => {
  const dir = await home(t);
  const { execFile } = await import('node:child_process');
  const cli = (...args) => new Promise((resolve, reject) => execFile(process.execPath, ['src/cli.js', 'language', ...args], { env: { ...process.env, ALP_HOME: dir } }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
  assert.equal(await cli(), 'Language: Vietnamese (the default; not set)');
  assert.equal(await cli('English'), 'Language: English');
  assert.deepEqual(JSON.parse(await cli('--json')), { language: 'English', applies: 'English', default: 'Vietnamese' });
  assert.equal(await cli('--reset'), 'Language: Vietnamese (the default; not set)');
  await assert.rejects(cli('x'.repeat(41)));
});
