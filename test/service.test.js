import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installedProgram, serviceDefinition, serviceFor } from '../src/client/service.js';
import { lockAlive, readLock } from '../src/client/index.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const ENTRY = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));

test('the service keeps alpd up after a crash but not after a clean stop, with the environment alpd needs', async () => {
  const home = '/tmp/a home & co';
  const env = { PATH: '/opt/bin:/usr/bin', ALP_CODEX_BIN: '/opt/codex', ALP_SERVICE_DIR: '/tmp/agents', UNRELATED: 'x' };
  const mac = serviceFor({ home, env, platform: 'darwin', uid: 501 });
  assert.match(mac.name, /^com\.alp\.alpd\.[0-9a-f]{8}$/, 'a custom ALP_HOME gets its own service');
  assert.equal(serviceFor({ home: path.join(homedir(), '.alp'), env, platform: 'darwin', uid: 501 }).name, 'com.alp.alpd');
  assert.equal(mac.file, path.join('/tmp/agents', `${mac.name}.plist`));
  assert.deepEqual(mac.install.map(([, args]) => args[0]), ['bootout', 'bootstrap']);
  const plist = serviceDefinition(mac, { home, entry: '/opt/alp/dist/alpd.js', execPath: '/opt/node', env });
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>Crashed<\/key>\s*<true\/>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ALP_HOME<\/key>\s*<string>\/tmp\/a home &amp; co<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/opt\/bin:\/usr\/bin<\/string>/);
  assert.match(plist, /<key>ALP_CODEX_BIN<\/key>/);
  assert.doesNotMatch(plist, /UNRELATED/);

  const linux = serviceFor({ home, env, platform: 'linux' });
  assert.match(linux.name, /^alpd-[0-9a-f]{8}$/);
  const unit = serviceDefinition(linux, { home, entry: '/opt/a "b"/alpd.js', execPath: '/opt/node', env });
  assert.match(unit, /^ExecStart="\/opt\/node" "\/opt\/a \\"b\\"\/alpd\.js" "--service"$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^Environment="ALP_HOME=\/tmp\/a home & co"$/m);
  assert.equal(serviceFor({ home, env, platform: 'win32' }), undefined);

  // What is installed reads back as the program it runs.
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-service-'));
  try {
    for (const [service, text] of [[{ ...mac, file: path.join(directory, 'a.plist') }, plist], [{ ...linux, file: path.join(directory, 'a.service') }, unit]]) {
      assert.equal(await installedProgram(service), undefined);
      await writeFile(service.file, text);
      assert.deepEqual(await installedProgram(service), ['/opt/node', service.kind === 'launchd' ? '/opt/alp/dist/alpd.js' : '/opt/a "b"/alpd.js']);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('alp daemon install runs alpd under its service until uninstall', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-svc-'));
  const home = path.join(directory, 'home');
  const calls = path.join(directory, 'calls');
  t.after(async () => {
    // Only the alpd of this test's home.
    const lock = await readLock(home).catch(() => undefined);
    if (lockAlive(lock)) process.kill(lock.pid, 'SIGTERM');
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  // A service manager that starts alpd as launchd or systemd would, and stops it with SIGTERM.
  const manager = path.join(directory, 'manager');
  await writeFile(manager, `#!/bin/sh
echo "$*" >> "${calls}"
case "$*" in
  bootstrap*|kickstart*|*"enable --now"*|*" start "*)
    "${process.execPath}" "${ENTRY}" --service < /dev/null >> "$ALP_HOME/logs/alpd.service.log" 2>&1 &
    ;;
  bootout*|*disable*)
    pid=$(sed -n 's/.*"pid":\\([0-9]*\\).*/\\1/p' "$ALP_HOME/alpd.lock" 2>/dev/null)
    [ -n "$pid" ] && kill "$pid"
    ;;
esac
exit 0
`);
  await chmod(manager, 0o755);
  const env = { ...process.env, ALP_HOME: home, ALP_SERVICE_DIR: path.join(directory, 'agents'), ALP_LAUNCHCTL: manager, ALP_SYSTEMCTL: manager };
  const alp = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const service = serviceFor({ home, env });

  assert.match(alp('daemon', 'install'), /alpd installed as .*\nalpd .* running \(pid \d+\); it starts at login and again after a crash/);
  assert.deepEqual(await installedProgram(service), [process.execPath, ENTRY]);
  const first = await readLock(home);
  assert.ok(lockAlive(first) && first.ready);
  // Under the service alpd writes its own log, as when it runs detached.
  assert.match(await readFile(path.join(home, 'logs', 'alpd.log'), 'utf8'), /alpd .* ready on /);
  assert.match(alp('daemon', 'status'), new RegExp(`managed by (launchd|systemd) as ${service.name.replace(/\./g, '\\.')}`));
  assert.ok(JSON.parse(alp('doctor', '--json')).checks.some(check => check.id === 'service' && check.status === 'ok'));

  assert.match(alp('daemon', 'stop'), /alpd stopped; its service starts it again at login, or with alp daemon start/);
  assert.match(alp('daemon', 'start'), /alpd .* running \(pid \d+\)/);
  const second = await readLock(home);
  assert.notEqual(second.pid, first.pid);
  assert.match(await readFile(calls, 'utf8'), /kickstart|--user start/, 'start goes through the service');

  assert.match(alp('daemon', 'uninstall'), /alpd service .* removed and alpd stopped/);
  await assert.rejects(access(service.file));
  assert.equal(lockAlive(await readLock(home)), false);
  assert.match(alp('daemon', 'uninstall'), /not installed as a service/);
});
