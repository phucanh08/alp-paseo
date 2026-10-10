# ALP Paseo provider

The server-only plugin in `plugins/paseo` registers `alp` through the public `ProviderRegistration` API. All Paseo SDK imports are isolated in `server/compat.ts`; core, the runtime, and the daemon never import the SDK. No Paseo fork or ACP shim is used. Sessions run in `alpd`, the per-user ALP daemon (see [alpd](../../plans/reference/ALPD.md)): the plugin starts it when needed (`ALP_HOME`, default `~/.alp`), forwards Paseo inputs to it, and projects its events back to Paseo. Closing an agent in Paseo only stops watching it; running work finishes in alpd, which then closes the session. Use interrupt to stop work. To start alpd, the plugin uses `ALP_DAEMON_ENTRY`, the path recorded when it was built, the path alpd records in `$ALP_HOME/alpd.json` each time it starts, or the ALP CLI (`alp`) on `PATH`; if none is found, the provider reports that the CLI must be installed and started once with `alp daemon start`.

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

Select a team under **ALP** in Paseo's model picker: Phở and Cafe, then the teams of your library, then the project's. When a repository lacks `ALP.md` or `.alp/settings.json`, the provider creates them; agents, skills and teams come from ALP's built-ins and your library, so nothing else is copied. Existing files are preserved. A team fixes its members' models; other model names supported by the installed native runtime can be set through `.alp/settings.json`:

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

## ALP settings and the project panel

**Settings → ALP** edits your library in `$ALP_HOME` (default `~/.alp`), which every
project uses. The screen has two columns:
- The aside on the left starts with General (Language), then lists the kinds in three
  groups: Organisation (Teams, Agents), Capabilities (Skills, MCP servers, Hooks) and
  Runtimes (Providers). Each kind shows
  its count and, opened, its entries with a dot for where they come from. It stays
  in place, so you always see where you are and switch with one click.
- The aside folds to icons with its toggle, and folds on its own when the screen is
  narrower than 640 px. On a phone it opens from **Menu** over the screen.
- The working area has a breadcrumb, and a secondary menu on top: the source filters
  (All, Built-in, Library, Project) on a kind's list, or the parts of an entry
  (General, Members, Delegation, Supervisor, House rules for a team) in its editor.
  The editor keeps Save and Remove in a bar at the bottom.
- Each entry shows where it comes from: built-in, or library, possibly overriding a
  built-in. It also shows who uses it.
- Each section has New, and each entry Duplicate.
- Opening an entry edits it:
  - **Agent:** description, provider, model, thinking, default mode, instructions
    (`AGENT.md`), and switches for the skills, MCP servers and hooks it uses. The
    skills your library gives an agent by name (`role-skills.json`; main, lead and
    peer start with ALP's six) show on, marked "Default for this agent". Changing
    them in Settings → ALP saves `role-skills.json`, so a built-in agent keeps
    following ALP's instructions. In the ALP project panel they show locked.
  - **Team:** label, main, members and their roles, each member's model and
    thinking, who may delegate to whom (a cycle is shown and refused), the most
    peers at once, the supervisor and its model, and the house rules.
  - **Skill:** `SKILL.md`.
  - **MCP server:** a command with arguments, environment and working directory, or
    a URL with headers. **Test** starts it and lists its tools.
  - **Hook:** its event and command, whether it blocks (only for events before an
    action), its timeout, and an agent or task label it is limited to. **Test** runs it
    once with a sample event.
  - **Provider:** an ACP agent's label, command, arguments, environment and models.
    **Test** starts it and shows what it supports ([ACP providers](agent-library.md#acp-providers)).
    The agent form's Provider list offers the library's providers.
- Built-ins are read-only. **Save as my own** makes the library's entry of that name,
  which overrides the built-in. Removing it brings the built-in back.
- **General → Language** is the language you read (ALPD §54). Main writes its replies,
  questions, approval requests and task titles in it; other agents ask you in it; ALP
  asks for approvals and writes its notices in it. Pick one from the list, or Other to
  type a name. Unset, Vietnamese applies; **Reset** goes back to it. It is `language`
  in `$ALP_HOME/settings.json`, also set with `alp language`.

The **ALP project** workspace panel shows the same lists for the workspace's project,
except Providers, which live only in the library:
- **Override in this project** copies an entry into `.alp/`.
- **Use library** removes the project's copy.
- Opening an entry edits the project's copy.

Both use the `alp.library.*` RPC (ALPD §43), the same functions as `alp agent|team|skill|mcp|hook|provider`.
Each save checks the entry's revision, so two windows cannot overwrite each other.
Changes apply to new sessions; running sessions keep what they started with.

## Mapping and supported behavior

| Input | Behavior |
|---|---|
| `cwd` | Must be an existing absolute directory; used as ALP root and process/thread cwd. An empty repository is initialized from the bundled starter on first open |
| Agent | `providerOptions.agent` → restored agent identity → configured `defaultAgent` → `main` |
| Runtime | Persisted runtime → a `codex:`/`claude:` prefix on the model → `runtime.provider` → `codex`. Main with neither `runtime.provider` nor `runtime.model` runs on Claude (its profile model) |
| Instructions | `ALP.md`, selected `AGENT.md`, lazy skill path index, then host system instructions become runtime developer instructions |
| Skills | Paths only until runtime needs the skill; bodies are not injected by discovery |
| Environment | Session env overrides plugin process env; parent thread and Paseo control environment entries are removed; each session gets a separate process |
| MCP | Agent-local and host servers are combined; collisions fail. stdio and HTTP supported; SSE rejected. Headers map to Codex `http_headers` |
| Model | The picker lists two profiles, `pho` (Phở) and `cafe` (Cafe); the selection picks the profile, not a model (`providerOptions.workflow` and `settings.workflow` are still accepted, including the old names `smart`/`supervised`). The session model is `runtime.model` → main's profile model `claude:claude-opus-5-5` → runtime default (`gpt-5.6-sol` or `sonnet`). A root's config shows its profile; a child's shows its own model. Changing the profile or model of an open session fails |
| Thinking | Not chosen in Paseo: `runtime.reasoning` → `high` for main's profile model (and oracle) → `medium` |
| Mode | `full-access` by default in Paseo (main's default elsewhere too); `read-only` and `workspace-write` also supported. `full-access` runs Claude with `bypassPermissions` and Codex with the `danger-full-access` sandbox. Permissions can change while idle; oracle, reviewer and supervisor remain read-only and children cannot exceed parent permissions |
| Approval | `never`; interactive approval and per-tool policy are not advertised and are rejected |
| Persistence | Paseo stores a version 2 handle naming the alpd session, its agent and project root; alpd keeps the native thread, workflow snapshot and timeline, and resumes them on reopen. Version 1 handles (native thread in Paseo) are adopted on open. Roots started outside Paseo, for example with `alp run`, appear in Paseo's import list with their children |
| Refresh | Close then resume; reread ALP files and current launch config. Cross-project or cross-agent resume fails |
| Prompt | Text only; one result per message ID; duplicate IDs in the live session do not re-execute |
| Steering/cancel | Codex `turn/steer` and `turn/interrupt`; terminal events are deduplicated |
| Close | Graceful stdin shutdown, bounded forced shutdown fallback for the owned process |

After first-session initialization, ALP configuration files are read-only to the plugin. A model operating in `workspace-write` may edit project files as requested; the no-corruption lifecycle check runs against a fake native runtime, so no model edits files.

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

Sources checked during implementation: [Paseo provider guide](https://paseo.sh/docs/plugins/providers), installed public SDK declarations for 0.9.2, 0.10.3 and 0.11.1 (the plugin requires 0.11.1 since the Tasks panel), [Codex app-server](https://learn.chatgpt.com/docs/app-server), and protocol types generated by the local Codex 0.160.1 binary. The requested model ID follows [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol).
