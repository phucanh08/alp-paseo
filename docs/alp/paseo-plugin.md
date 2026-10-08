# ALP Paseo provider

The server-only plugin in `plugins/paseo` registers `alp` through the public `ProviderRegistration` API. All Paseo SDK imports are isolated in `server/compat.ts`; core never imports the SDK. No Paseo fork or ACP shim is used. The selected runtime is local Codex app-server, implemented only inside the plugin to satisfy Phase 5's real session requirements. Phase 6 documents and experiments were not opened or implemented.

## Install

Prerequisites: Paseo 0.11.1, Node compatible with Paseo, and at least one authenticated runtime: Codex or Claude Code. Development dependencies are pinned to Paseo SDK 0.11.1 and Claude Agent SDK 0.3.292. `ALP_CODEX_BIN` and `ALP_CLAUDE_BIN` may select absolute native executables; shell launchers (`.cmd`, `.bat`, `.ps1`) are rejected.

From this repository:

```sh
npm ci
npm run check
npm run build
paseo daemon config set pluginsEnabled true
paseo plugin install /absolute/path/to/alp-workspace/plugins/paseo
paseo provider models alp
```

Select a Codex or Claude Code entry under **ALP** in Paseo. When a repository lacks `ALP.md` or the starter `main` agent, the provider automatically installs the missing ALP starter files (settings, agents, skills, hooks, and MCP files). Existing files are preserved, including partial and customized ALP setups. The picker mirrors the native catalogs with runtime-prefixed IDs: currently 7 `codex:` models and 17 `claude:` models. Other model names supported by the installed native runtime can be set through `.alp/settings.json`:

```json
{
  "runtime": {
    "provider": "claude",
    "model": "sonnet",
    "reasoning": "high"
  }
}
```

Codex CLI example:

```sh
paseo run --provider alp/gpt-5.6-sol --mode read-only --thinking low --cwd /absolute/project "Your task"
```

To select a custom folder, set `defaultAgent` in `.alp/settings.json` or use the public client:

```js
import { createPaseoClient } from '@getpaseo/client';
const client = createPaseoClient({ url: 'ws://127.0.0.1:6767/ws' });
await client.connect();
try {
  const agent = await client.agents.create({
    cwd: '/absolute/project',
    config: {
      provider: 'alp/gpt-5.6-sol',
      modeId: 'read-only',
      thinkingOptionId: 'low',
      options: { agent: 'your-agent' },
    },
  });
  console.log((await agent.run('Your task')).lastMessage);
} finally {
  await client.close();
}
```

Installation commands above target the selected user's daemon. Implementation verification used isolated homes under `.alp-test/`; it did not install the plugin into the user's existing Desktop daemon or change its configuration.

## Mapping and supported behavior

| Input | Behavior |
|---|---|
| `cwd` | Must be an existing absolute directory; used as ALP root and process/thread cwd. An empty repository is initialized from the bundled starter on first open |
| Agent | `providerOptions.agent` → restored agent identity → configured `defaultAgent` → `main` |
| Runtime | A `codex:` or `claude:` picker prefix → persisted runtime → `runtime.provider` → `codex` |
| Instructions | `ALP.md`, selected `AGENT.md`, lazy skill path index, then host system instructions become runtime developer instructions |
| Skills | Paths only until runtime needs the skill; bodies are not injected by discovery |
| Environment | Session env overrides plugin process env; parent thread and Paseo control environment entries are removed; each session gets a separate process |
| MCP | Agent-local and host servers are combined; collisions fail. stdio and HTTP supported; SSE rejected. Headers map to Codex `http_headers` |
| Model | Picker/session model → ALP runtime model → runtime default (`gpt-5.6-sol` or `sonnet`); arbitrary native model names pass through |
| Thinking | Explicit session choice → ALP reasoning → `medium`; `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| Mode | `read-only` by default; `workspace-write` also supported. Permissions can change while idle; advisors remain read-only and children cannot exceed parent permissions |
| Approval | `never`; interactive approval and per-tool policy are not advertised and are rejected |
| Persistence | Paseo stores versioned thread ID, agent identity, project root, runtime/model and workflow snapshot; the native runtime owns conversation storage |
| Refresh | Close then resume; reread ALP files and current launch config. Cross-project or cross-agent resume fails |
| Prompt | Text only; one result per message ID; duplicate IDs in the live session do not re-execute |
| Steering/cancel | Codex `turn/steer` and `turn/interrupt`; terminal events are deduplicated |
| Close | Graceful stdin shutdown, bounded forced shutdown fallback for the owned process |

After first-session initialization, ALP configuration files are read-only to the plugin. A model operating in `workspace-write` may edit project files as requested; the no-corruption lifecycle check uses `read-only` mode.

## Prototype limits

- Hooks, interactive permissions, images, structured commands, output schemas, live model/thinking changes, session listing, and revert are not supported or advertised.
- Delegated child sessions are supported through `alp_delegate` and the public `session.subsession` contract. See [team workflow](team-workflow.md) for routing, migration, lifecycle, and limits. Start a new main session after enabling delegation in an older project: old native threads may have no registered delegation tool.
- Live timeline mapping covers assistant text, shell commands, and dynamic delegation calls; other native tool item types are not yet rendered. This is not a complete Codex UI replacement.
- Replay uses the history returned by `thread/resume`; exhaustive pagination of very large native histories is not implemented.
- Runtime may load the user's normal Codex or Claude Code authentication. ALP does not replace global authentication or write credentials into project files.
- Claude Code runs through the Claude Agent SDK. ALP disables Claude's native multi-agent tools and exposes the ALP tools (`alp_delegate`, `alp_wait`, `alp_send`, `alp_ask`, `alp_handoff`) as in-process MCP tools so the same configured delegation graph and Paseo child-session lifecycle apply to both runtimes.
- SDK 0.11.1 does not provide the newer documented `connect.launch` environment field or process helper exports; the compatibility wrapper targets the actual installed contracts. Runtime process code uses native executables with argument arrays and no shell.
- There is no custom client UI. Provider selection/catalog/session behavior was verified through the real daemon and public client/CLI, not by a Desktop screenshot.

## Repeat verification

`npm test` uses fixture transports and real public SDK schemas. It makes no model calls. `node scripts/runtime-e2e.mjs` is an opt-in real Codex lifecycle check; set `ALP_CODEX_BIN` if necessary. `npm run test:e2e` invokes the real model through an already running isolated Paseo daemon with the plugin installed. It creates a new fixture project, runs main/custom/reload, archives test agents, and compares every fixture file byte-for-byte.

E2E variables:

- `ALP_TEST_PASEO_URL`: default `ws://127.0.0.1:16767/ws`.
- `ALP_TEST_PASEO_CLI`: path to the selected CLI's JS executable for reload. Use a CLI matching the daemon.

Use `paseo daemon run --home /isolated/home` with a loopback `daemon.listen` setting. Enable plugins in that isolated home. Disable relay, voice and dictation for the test daemon. Stop that daemon after testing. The E2E scripts never provision or modify the default user daemon.

Sources checked during implementation: [Paseo provider guide](https://paseo.sh/docs/plugins/providers), installed public SDK declarations for 0.9.2 and 0.10.3, [Codex app-server](https://learn.chatgpt.com/docs/app-server), and protocol types generated by the local Codex 0.160.1 binary. The requested model ID follows [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol).
