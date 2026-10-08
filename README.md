# ALP prototype

Provider-neutral filesystem agent resolution with a server-side Paseo provider. Includes project initialization and the existing Phases 2–5 prototype. A standalone ACP server is not implemented.

## Initialize a project

Run `node /path/to/alp/src/cli.js init [directory]` (or `alp init [directory]` when the package command is installed). The directory defaults to the current working directory.

When the Paseo plugin opens an ALP session in a repository that lacks `ALP.md` or the starter `main` agent, it performs this initialization automatically. Initialization fills missing scaffold files and never replaces existing files, so partial and customized ALP setups are preserved.

Initialization creates `ALP.md`, `.alp/settings.json`, and five editable agent packages: `main`, `lead`, `peer`, `oracle`, and `reviewer`, each containing `AGENT.md`, assigned workflow skills, an empty `hooks/` directory, and `.mcp.json` with `{ "mcpServers": {} }`. Main owns delivery; Smart lets main implement or call peer, while Supervised assigns technical execution to lead. Oracle and reviewer provide read-only advice and review.

The default settings select main with the Smart workflow. Paseo exposes an `alp_delegate` tool that executes real child sessions and returns their evidence. See [team workflow and migration](docs/alp/team-workflow.md).

Six [role skills](docs/alp/role-skills.md) cover intake, research, planning, delegation briefs, bug diagnosis, and commit packaging. Main receives six, lead five, and peer three; each agent selects directly from its scoped skills and loads contents only when needed.

Repeated runs fill in missing files and preserve existing file contents, including custom settings. Conflicting filesystem entry types cause an error; files already created before an error remain available for a later retry. Run `npm run test:init` to verify initialization independently.

For projects created with the original main-only or team scaffold, run `node /path/to/alp/src/cli.js upgrade [directory]`. This installs missing skills, backs up and updates recognized original instructions, and adds workflow settings. The old shipped graph migrates to Supervised; custom graphs and customized instructions/skills remain unchanged.

## Development

Use Node 20+ and an npm version compatible with your Node installation:

```sh
npm ci
npm run check
npm test
```

`npm test` builds the Paseo bundle before running tests. `npm run build` builds only the plugin. Core has no external dependencies and can be tested without installing Paseo:

```sh
node --test test/init.test.js test/upgrade.test.js test/delegation.test.js test/resolver.test.js test/ir.test.js test/adapter.test.js
```

## Project files

```text
your-project/
  ALP.md
  .alp/
    settings.json
    agents/
      main/AGENT.md
      lead/AGENT.md
      peer/AGENT.md
      your-agent/AGENT.md
```

Example `.alp/settings.json`:

```json
{
  "defaultAgent": "main",
  "workflow": { "mode": "smart", "maxPeers": 2 },
  "runtime": { "provider": "codex", "model": "gpt-5.6-sol", "reasoning": "low" }
}
```

`runtime.provider` selects `codex` or `claude` behind the ALP Paseo plugin; the Paseo provider ID itself is `alp`. `runtime.model` is passed through to the selected native harness, so it accepts any model name supported by that installed Codex or Claude Code version. Core treats these strings as provider-neutral data. Optional agent-local `skills/<name>/SKILL.md`, `hooks/*`, and `.mcp.json` are discovered by core. This prototype rejects agents with hooks rather than executing them without a defined hook contract.

For example, select Claude Code and one of its model aliases in `.alp/settings.json`:

```json
{
  "defaultAgent": "main",
  "workflow": { "mode": "smart", "maxPeers": 2 },
  "runtime": { "provider": "claude", "model": "sonnet", "reasoning": "high" }
}
```

The Paseo model picker mirrors all models advertised by the installed native providers: currently 7 Codex models and 17 Claude Code models. ALP prefixes their IDs with `codex:` or `claude:` so a selection also chooses its runtime, for example `codex:gpt-6.1-sol` or `claude:claude-opus-5-5`. Configure another native model name in `runtime.model` when it is not listed in the picker.

Use `resolveAgent(projectRoot, { agent: 'your-agent' })` from `src/core/resolver.js` to resolve an agent without starting a runtime. Explicit selection overrides settings; missing settings default to `main`. There is no central agent registry.

## Paseo

See [installation and runtime behavior](docs/alp/paseo-plugin.md) and [phase acceptance evidence](docs/alp/phase-2-5-results.md). The plugin is verified with Paseo 0.11.1 and live Codex and Claude Code permission changes.

### Build and add the plugin to Paseo

Prerequisites: Node.js 20+, Paseo 0.11.1, and a logged-in Codex CLI and/or Claude Code installation. Set `ALP_CODEX_BIN` or `ALP_CLAUDE_BIN` to an absolute native executable path when it is not available on `PATH`.

Install dependencies, type-check the plugin, and build its server bundle:

```sh
npm ci
npm run check
npm run build
```

The build output is written to `plugins/paseo/server/dist/index.js`. Paseo plugins are trusted, unsandboxed code, so enable plugins only on a daemon where you trust this repository. In Paseo, open **Settings → Plugins** and turn on **Enable plugins**.

For a headless daemon, run `paseo daemon status --json` to find its `home`, set the root `pluginsEnabled` field in `<home>/config.json` to `true`, preserve the rest of the file, then apply the change:

```sh
paseo reload --json
```

Paseo requires an absolute path when adding a local plugin. From the repository root, run one of the following commands.

PowerShell:

```powershell
paseo plugin add (Resolve-Path .\plugins\paseo).Path
```

macOS/Linux:

```sh
paseo plugin add "$(pwd)/plugins/paseo"
```

Confirm that `alp-provider` is running and that the `alp` provider is available:

```sh
paseo plugin ls
paseo provider models alp
```

After changing the plugin source, rebuild and reload the installed plugin:

```sh
npm run check
npm run build
paseo plugin reload alp-provider
```

If loading fails, inspect the plugin process output with `paseo plugin logs alp-provider`. A full daemon restart is not required for source changes.

### Smart and Supervised

New projects default to Smart: main works directly or delegates to peer. Supervised
keeps main as supervisor while lead implements or delegates. Both use read-only
oracle/reviewer. Select at session creation with `options.workflow`, or set
`.alp/settings.json` → `workflow.mode`. The default concurrent peer limit is 2;
raise `workflow.maxPeers` only at the user's request. Shared-checkout writers remain
serialized. Oracle requires an explicit premium model choice and effort, without
hardcoded model names. Runtime catalog and available plan/usage snapshots inform
coordination. See [workflow configuration and migration](docs/alp/team-workflow.md).
