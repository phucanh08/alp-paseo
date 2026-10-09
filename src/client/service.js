import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './command.js';

/**
 * alpd as a user service (ALPD §37): a LaunchAgent on macOS, a systemd user unit on
 * Linux. The service manager starts alpd at login and starts it again after a crash;
 * a clean stop (`alp daemon stop`, exit 0) stays stopped until `alp daemon start`.
 * Paths can be redirected for tests: ALP_SERVICE_DIR for the definition's directory,
 * ALP_LAUNCHCTL and ALP_SYSTEMCTL for the managers.
 */

/** Variables alpd reads, carried into the service when the installing shell sets them. */
const CARRIED = ['ALP_RUN_LOG_DIR', 'ALP_CODEX_BIN', 'ALP_CLAUDE_BIN', 'ALP_GH_BIN'];

const escapeXml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const quoteUnit = value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Where and how alpd for `home` is defined as a service on `platform`, or undefined
 * where ALP has no service support. Each ALP_HOME gets its own service.
 */
export function serviceFor({ home, env = process.env, platform = process.platform, uid = process.getuid?.() ?? 0 }) {
  const custom = path.resolve(home) !== path.join(os.homedir(), '.alp');
  const suffix = custom ? createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 8) : '';
  if (platform === 'darwin') {
    const label = `com.alp.alpd${suffix ? `.${suffix}` : ''}`;
    const directory = env.ALP_SERVICE_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents');
    const launchctl = env.ALP_LAUNCHCTL || 'launchctl';
    const target = `gui/${uid}/${label}`;
    const file = path.join(directory, `${label}.plist`);
    return {
      kind: 'launchd', name: label, file,
      install: [[launchctl, ['bootout', target], { ignore: true }], [launchctl, ['bootstrap', `gui/${uid}`, file]]],
      start: [[launchctl, ['kickstart', target]]],
      uninstall: [[launchctl, ['bootout', target], { ignore: true }]],
    };
  }
  if (platform === 'linux') {
    const name = `alpd${suffix ? `-${suffix}` : ''}`;
    const directory = env.ALP_SERVICE_DIR || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
    const systemctl = env.ALP_SYSTEMCTL || 'systemctl';
    return {
      kind: 'systemd', name, file: path.join(directory, `${name}.service`),
      install: [[systemctl, ['--user', 'daemon-reload']], [systemctl, ['--user', 'enable', '--now', `${name}.service`]]],
      start: [[systemctl, ['--user', 'start', `${name}.service`]]],
      uninstall: [[systemctl, ['--user', 'disable', '--now', `${name}.service`], { ignore: true }]],
      afterUninstall: [[systemctl, ['--user', 'daemon-reload'], { ignore: true }]],
    };
  }
  return undefined;
}

/** The service definition that runs `entry` with `execPath` for `home`. */
export function serviceDefinition(service, { home, entry, execPath = process.execPath, env = process.env }) {
  const variables = { ALP_HOME: path.resolve(home), PATH: env.PATH ?? '' };
  for (const name of CARRIED) if (env[name]) variables[name] = env[name];
  const program = [execPath, entry, '--service'];
  const fatal = path.join(path.resolve(home), 'logs', 'alpd.service.log');
  if (service.kind === 'launchd') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(service.name)}</string>
  <key>ProgramArguments</key>
  <array>
${program.map(arg => `    <string>${escapeXml(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(variables).map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(fatal)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(fatal)}</string>
</dict>
</plist>
`;
  }
  return `[Unit]
Description=ALP daemon (alpd) for ${path.resolve(home)}

[Service]
ExecStart=${program.map(quoteUnit).join(' ')}
${Object.entries(variables).map(([key, value]) => `Environment=${quoteUnit(`${key}=${value}`)}`).join('\n')}
Restart=on-failure
RestartSec=10
StandardOutput=append:${fatal}
StandardError=append:${fatal}

[Install]
WantedBy=default.target
`;
}

/** The program an installed definition runs: [node, alpd.js], or undefined when it is not installed. */
export async function installedProgram(service) {
  const text = await readFile(service.file, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  if (service.kind === 'launchd') {
    const array = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
    const unescape = value => value.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => unescape(match[1])).slice(0, 2);
  }
  const line = text.match(/^ExecStart=(.*)$/m)?.[1] ?? '';
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => match[1].replace(/\\(.)/g, '$1')).slice(0, 2);
}

async function runAll(steps, run) {
  for (const [command, args, { ignore = false } = {}] of steps) {
    const result = await run(command, args);
    if (result.code !== 0 && !ignore) throw new Error(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  }
}

/** Writes the definition and loads it, which starts alpd. */
export async function installService(service, options, run = runCommand) {
  await mkdir(path.dirname(service.file), { recursive: true });
  await mkdir(path.join(path.resolve(options.home), 'logs'), { recursive: true, mode: 0o700 });
  await writeFile(service.file, serviceDefinition(service, options), { mode: 0o644 });
  await runAll(service.install, run);
}

/** Starts an installed service's alpd. */
export async function startService(service, run = runCommand) {
  await runAll(service.start, run);
}

/** Unloads the service, which stops its alpd, and removes the definition; false when none was installed. */
export async function uninstallService(service, run = runCommand) {
  if (await installedProgram(service) === undefined) return false;
  await runAll(service.uninstall, run);
  await unlink(service.file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await runAll(service.afterUninstall ?? [], run);
  return true;
}
