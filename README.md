# ALP prototype

Provider-neutral filesystem agent resolution with a server-side Paseo provider. Includes project initialization and the existing Phases 2–5 prototype. Editors that speak the Agent Client Protocol use ALP through `alp acp`.

## Install

Requires Node.js 20+ and an authenticated Codex or Claude Code executable on PATH.

```sh
npm install -g @anhlp/alp
alp doctor          # checks Codex and Claude, settings, and leftovers; --fix repairs the safe ones
alp daemon start
```

The package provides the `alp` command and `alpd`, the per-user daemon that runs ALP sessions. To view and drive sessions in Paseo, also install the [Paseo plugin](plugins/paseo/README.md).

## Initialize a project

Run `node /path/to/alp/src/cli.js init [directory]` (or `alp init [directory]` when the package command is installed). The directory defaults to the current working directory.

When the Paseo plugin opens an ALP session in a repository that lacks `ALP.md` or `.alp/settings.json`, it performs this initialization automatically. Initialization fills missing scaffold files and never replaces existing files, so partial and customized ALP setups are preserved.

Initialization creates `ALP.md` and `.alp/settings.json`. The six agents `main`, `lead`, `peer`, `oracle`, `reviewer` and `supervisor` are built into ALP and follow its updates; a project does not copy them. To change one, make an agent of the same name in your library (`~/.alp/agents/`) or in the project (`.alp/agents/`); see [agent library](docs/alp/agent-library.md). Main owns delivery; Phở lets main implement or call peer, while Cafe assigns technical execution to lead. Oracle and reviewer provide read-only advice and review; the supervisor reviews main's process after each turn.

The default settings select main with the Phở team. Main runs on Opus 5.5 with high effort and full access unless settings or the caller choose otherwise. Paseo exposes an `alp_delegate` tool that executes real child sessions and returns their evidence. See [Phở and Cafe teams](docs/alp/team-workflow.md).

Six [role skills](docs/alp/role-skills.md) cover intake, research, planning, delegation briefs, bug diagnosis, and commit packaging. They live in your skill library in `$ALP_HOME` (default `~/.alp`), seeded on first use, together with `role-skills.json`, which assigns six to main, five to lead and three to peer. Edit either freely: app updates replace only library files you have not changed. Each agent selects directly from its skills and loads contents only when needed.

Repeated runs fill in missing files and preserve existing file contents, including custom settings. Conflicting filesystem entry types cause an error; files already created before an error remain available for a later retry. Run `npm run test:init` to verify initialization independently.

For projects created with an earlier scaffold, run `node /path/to/alp/src/cli.js upgrade [directory]`. This backs up and updates recognized original instructions, adds profile settings, renames the old `smart`/`supervised` profiles to `pho`/`cafe`, and archives project copies of skills that still match the shipped ones, so the library applies. Copies of the built-in agents that are still as ALP shipped them are put away too, so the project uses the built-ins; a copy you edited, or added skills, MCP servers or hooks to, stays as the project's override. The old shipped graph migrates to Cafe; custom graphs and customized instructions/skills remain unchanged.

## Development

Use Node 20+ and an npm version compatible with your Node installation:

```sh
npm ci
npm run check
npm test
```

`npm test` builds the Paseo bundle and the runtime bundle (`dist/runtime`) before running tests. `npm run build` builds both. The runtime in `src/runtime` owns native harnesses, sessions, delegation, and mail without importing Paseo; `alpd` hosts it, and the plugin is a viewer over the daemon ([design](plans/reference/ALPD.md)). Core has no external dependencies and can be tested without installing Paseo:

```sh
node --test test/init.test.js test/upgrade.test.js test/delegation.test.js test/resolver.test.js test/ir.test.js test/adapter.test.js
```

Runtime tests drive scripted agents from `test/support/fake-agent.js` instead of Codex or Claude: they call ALP tools, report context fill, hand off slowly, crash mid-turn or hit a usage limit on cue. `test/golden.test.js` compares what `alp log`, `alp ps` and `alp task report` print with `test/golden/*.txt`; after checking an intended change, accept it with `ALP_UPDATE_GOLDEN=1 node --test test/golden.test.js`.

## Project files

```text
your-project/
  ALP.md
  .alp/
    settings.json
    tasks/            # one JSON file per task; commit it with the project
    agents/           # optional: project agents, and overrides of built-in or library ones
      your-agent/AGENT.md
      your-agent/agent.json
    skills/ mcp/ hooks/   # optional: project entries; each overrides a library entry of its name
```

`alp agents`, `alp skills`, `alp mcp` and `alp hooks` list what a project can use: ALP's built-ins, your library in `~/.alp`, and the project's own entries, with what each overrides and which agents use it. `alp agent|team|skill|mcp|hook new|edit|cp|mv|rm` change them, in your library or with `--project` in the project, and `alp mcp test` and `alp hook test` try one out ([editing](docs/alp/agent-library.md#editing)).

Example `.alp/settings.json`:

```json
{
  "defaultAgent": "main",
  "workflow": { "mode": "pho" },
  "runtime": { "provider": "codex", "model": "gpt-5.6-sol", "reasoning": "low" }
}
```

`workflow.mode` names a team: `pho`, `cafe` or your own (`smart` and `supervised`, Phở and Cafe's names before 0.4, are still accepted); `workflow.supervisor: false` turns the supervisor off. `runtime.provider` selects `codex` or `claude` behind the ALP Paseo plugin; the Paseo provider ID itself is `alp`. Without `runtime.provider` and `runtime.model`, main runs on `claude:claude-opus-5-5` with `high` effort; setting either replaces that default. `runtime.model` is passed through to the selected native harness, so it accepts any model name supported by that installed Codex or Claude Code version. Core treats these strings as provider-neutral data. An agent's `agent.json` can pick its own provider, model, thinking and mode, and name the skills, MCP servers and hooks it uses ([agent library](docs/alp/agent-library.md)). ALP runs hooks itself at its own events, the same for Codex and Claude; a project's hooks run after you trust the workspace once ([hooks](docs/alp/agent-library.md#hooks)). Besides Codex and Claude, an agent can run on any agent that speaks the Agent Client Protocol, such as Gemini CLI or opencode, added to your library with `alp provider add` ([ACP providers](docs/alp/agent-library.md#acp-providers)).

For example, select Claude Code and one of its model aliases in `.alp/settings.json`:

```json
{
  "defaultAgent": "main",
  "workflow": { "mode": "pho", "maxPeers": 2 },
  "runtime": { "provider": "claude", "model": "sonnet", "reasoning": "high" }
}
```

The Paseo model picker shows the teams, Phở and Cafe first; a session's model and effort follow from the team and are not chosen in Paseo. `runtime.model` in `.alp/settings.json`, or `--model` and `--thinking` on `alp run`, still override them. Those take runtime-prefixed IDs such as `codex:gpt-6.1-sol` or `claude:claude-opus-5-5`, or any native model name the installed Codex or Claude Code accepts.

`permissions` in `.alp/settings.json` (and in `$ALP_HOME/settings.json`) gives agents permission profiles with Claude Code-style rules. A profile caps an agent's mode, lets it run commands beyond that mode, asks you before others (`ask`, or `"beyondMode": "ask"` for anything the mode refuses), or refuses them in any mode. You answer Allow once, Always allow (written to the profile) or Deny, in Paseo or with `alp answer`. For example, a read-only reviewer may run the tests:

```json
"permissions": {
  "profiles": { "review": { "base": "read-only", "allow": ["Bash(npm test:*)"], "deny": ["Bash(rm:*)"] } },
  "agents": { "reviewer": "review" }
}
```

On Claude, read-only and workspace-write profiles also put Bash in the OS sandbox, so a read-only reviewer can run tests that only read. With `"workdir": "copy"` an agent works in a disposable copy of your tree, where it may build and test without touching yours. `alp permissions` shows each agent's profile, and `alp permissions check <agent> "<command>"` tests a rule. Details: [Permission profiles](docs/alp/team-workflow.md#permission-profiles).

Use `resolveAgent(projectRoot, { agent: 'your-agent' })` from `src/core/resolver.js` to resolve an agent without starting a runtime. Explicit selection overrides settings; missing settings default to `main`. There is no central agent registry.

## Daemon and CLI

`alpd` hosts ALP sessions for all projects of a user. After `npm run build`:

```sh
node src/cli.js daemon start          # or: status | stop | restart | install | uninstall
node src/cli.js doctor [--fix]        # what ALP needs here, and what earlier runs left behind
node src/cli.js run --profile cafe "Your task"   # streams the agent tree; Ctrl-C interrupts
node src/cli.js ps [--all]            # live sessions as a tree; --all adds closed ones
node src/cli.js top [session]         # live dashboard: who runs, who waits, questions, worktrees, leases
node src/cli.js attach <session>      # follow a running tree, or print a closed one
node src/cli.js send <session> "More context"   # resumes a closed root first; to an agent, mail from you
node src/cli.js questions             # questions agents asked you
node src/cli.js answer <question> "Your answer"   # or: --dismiss [--reason R]
node src/cli.js log <session>         # delegations, mail, handoffs, worktrees, pins and questions of a tree
node src/cli.js board [--project DIR] # the project board: claims, decisions and findings
node src/cli.js tasks [ready]         # the project's tasks; ready: what nothing blocks
node src/cli.js task add "Title" -p 1 --after t-91c2   # also: show | edit | close | reopen | dep
node src/cli.js formula pour release --var version=0.4.0   # also: list | show; tasks export | import for beads
node src/cli.js verify [--task t-77e0]   # run the project's verify commands; --task records the result
node src/cli.js recall <assignment|task> "Why did you…?"   # ask a finished assignment about its work
node src/cli.js pause [codex|claude] [--now]   # hold delegation; --now parks running assignments
node src/cli.js resume [codex|claude]          # parked assignments continue
node src/cli.js interrupt <session>
```

You talk with main. Main can ask you a question with `alp_ask` without ending its turn; `run`, `attach` and `send` show it and, in a terminal, read the answer, and `alp answer` answers from anywhere by question id or a unique prefix. In Paseo the question appears as a question prompt. Other agents do not talk to you unless you write to them first with `alp send <agent session>`; ALP then tells the agent that assigned them, and they may ask you questions too.

Agents on one project share a board, even when they belong to different trees. Each one claims the paths it is about to change, and an overlapping claim from another tree is refused. Agents also pin decisions and findings, which reach other agents that are working and start every new assignment. `alp board` shows the board.

Each project keeps its tasks in `.alp/tasks`, one JSON file per task, modelled on [beads](https://github.com/gastownhall/beads): types, priorities 0–4, `blockedBy`, epic parents, and a ready list of open tasks that nothing blocks. Only you and main create or change tasks: you with `alp task`, main with its `alp_task` tool. Other agents read them and report work they find to their requester. Main gives a task to lead or peer with `alp_delegate { taskId }`: the task starts, its paths are claimed, and the handoff moves it to review until main accepts it. Each of main's turns starts with what waits for review and what is ready, and Paseo shows the tasks a session worked on as a task list. When every child of an epic is closed, main closes the epic, and you get a report of what it came to: tasks, time, rework and verification. `alp task report <epic>` shows it at any time.

A gate holds a task back until it clears:
- `human`: you approve it with `alp task gate clear` or in Paseo.
- `timer`: a time passes.
- `gh:pr`: a pull request merges.
- `gh:run`: a workflow run succeeds.

Formulas are workflow templates, as in beads: a `<name>.formula.toml` (or `.json`) file in `.alp/formulas`, `$ALP_HOME/formulas` or `.beads/formulas` lists steps with `needs` and `{{vars}}`. `alp formula pour release --var version=0.4.0`, or main with `alp_task pour`, turns one into an epic with a task per step; a `human` step waits for your approval. `alp tasks export` and `alp tasks import` move tasks to and from beads' JSONL (`bd export` / `bd import`, default `.beads/issues.jsonl`).

`alp tasks gates` and main's turns check the GitHub gates. `alp tasks compact` shrinks tasks closed more than 30 days ago. In Paseo, each workspace has a **Tasks** panel: you approve gates, add tasks, and accept or reopen them there. The CLI writes the files directly, so it works without alpd.

`ALP_HOME` selects the daemon's directory (default `~/.alp`); `ALP_RUN_LOG_DIR` overrides where assignment logs go (default `$ALP_HOME/runs`). alpd records sessions, their timelines, and prompt receipts under `$ALP_HOME/state`, project boards under `$ALP_HOME/boards`, and its own location in `$ALP_HOME/alpd.json`. After a restart, or a crash, a root can be resumed with `send` or imported into Paseo; work that was running is marked `daemon_restarted`. A task an assignment held goes back to open at main's next turn, with the branch that kept the assignment's work, and main's task list shows it as interrupted.

With `"verify": { "test": "npm test" }` (also `setup`, `typecheck`) in `.alp/settings.json`, alpd runs the project's checks itself:
- before `alp_merge` applies a worktree change; if they fail, nothing is applied and main can fix the change with `alp_delegate { continueFrom }`;
- in the checkout after a shared writer finishes;
- on demand with `alp_verify` or `alp verify`.

The result is recorded on the task, and an agent cannot close a task as done after a failed check without saying why. A timed-out command gets SIGTERM before SIGKILL, `idleSec` stops a silent one, and a step exiting 75 counts as could-not-run (skipped), not failed. Details: [Verification gates](docs/alp/team-workflow.md#verification-gates).

Text one agent wrote reaches another without `<system-reminder>` tags, so a peer cannot pose as the harness.

Work survives alpd: after a crash, `alp daemon stop` or `alp daemon restart`, the next alpd reopens trees that were working, by itself, and their assignments continue with their thread, worktree and task. When a Codex or Claude process dies under a session, ALP restarts it and the session continues; three restarts in a row with no progress end it. `alp daemon install` runs alpd as a login service (launchd on macOS, systemd on Linux) that starts it again after a crash. Details: [Crashes and restarts](docs/alp/team-workflow.md#crashes-and-restarts).

When a runtime hits its usage limit, ALP pauses it by itself. Assignments the limit stopped are parked instead of failed, and every open session shows a notice saying when the limit resets. Agents on the other runtime keep working. alpd asks the paused runtime every minute, and at once when an agent delegates to it. It resumes the runtime as soon as the runtime says the limit lifted, and the parked assignments continue. With `"limits": { "autoResume": false }` in `$ALP_HOME/settings.json`, ALP only tells you, and `alp resume codex` continues. Details: [Pause and usage limits](docs/alp/team-workflow.md#pause-and-usage-limits).

Agents and ALP write to you in the language set in Settings → ALP → General → Language, or with `alp language English`; unset, it is Vietnamese. That covers replies, questions, approval requests and notices. Details: [The user's language](docs/alp/team-workflow.md#the-users-language).

Finished assignments stay recallable for 14 days: main, or the agent that assigned one, asks it with `alp_recall` why it did something, and you ask with `alp recall <assignment|task> "question"`. ALP forks the assignment's session read-only, asks, and drops the fork; the question never changes the assignment's own session. ALP keeps the native threads of assignments for this, and deletes them after 14 days. The Paseo plugin keeps the same daemon running while Paseo runs: it starts alpd with Paseo and again whenever alpd goes down, except after `alp daemon stop`, and its sessions reconnect.

## Editors (ACP)

`alp acp` serves ALP over the [Agent Client Protocol](https://agentclientprotocol.com) on stdio, so an editor such as Zed or a JetBrains IDE can use ALP as its agent. In Zed's `settings.json`:

```json
{
  "agent_servers": {
    "ALP": { "type": "custom", "command": "alp", "args": ["acp"], "env": {} }
  }
}
```

- Each editor thread is an ALP session in its project, worked by a team. Choose the team (Phở, Cafe, or your own) and the permission mode in the thread's options before the first prompt; the team is fixed after that.
- Main's replies, commands and tool calls stream into the thread, and so do the steps its team reports back after the prompt ended. Delegations show as tool calls.
- When an agent asks you something, the question appears in the thread: reply with `/answer <text>`, or `/dismiss`.
- Stop cancels main's turn and the work it started. Closing the editor leaves running work to finish in alpd; the thread's history lists ALP sessions of the project, and opening one shows its history.
- MCP servers the editor offers are given to the agents beside their own.

Details: [ALPD §60](plans/reference/ALPD.md#60-alp-as-an-acp-agent-2026-10-10).

## Paseo

See [installation and runtime behavior](docs/alp/paseo-plugin.md) and [phase acceptance evidence](docs/alp/phase-2-5-results.md). The plugin is verified with Paseo 0.11.1 and live Codex and Claude Code permission changes.

**Settings → ALP** manages your library of teams, agents, skills, MCP servers, hooks and ACP providers, and the **ALP project** workspace panel manages a project's overrides ([settings screen](docs/alp/paseo-plugin.md#alp-settings-and-the-project-panel)).

### Build and add the plugin to Paseo

Prerequisites: Node.js 20+, Paseo 0.11.1 or a later 0.11 release (the Tasks panel needs its plugin client API), and a logged-in Codex CLI and/or Claude Code installation. Set `ALP_CODEX_BIN` or `ALP_CLAUDE_BIN` to an absolute native executable path when it is not available on `PATH`.

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

### Phở and Cafe

New projects default to Phở: main works directly or delegates to peer. Cafe
keeps main as supervisor while lead implements or delegates. In both, main runs on
Opus 5.5 with high effort and full access, and starts a supervisor on Sonnet 5
that reviews its process after each turn and asks main about mistakes; main records
lessons it follows in later sessions. Main can distill recurring lessons into a
skill for the roles it chooses, and open or comment on GitHub issues of the
project or of ALP; the user approves each skill and each post first. Both use read-only oracle/reviewer. Phở and Cafe
are ALP's built-in teams; you can make your own, with its own main, members,
delegation and house rules ([teams](docs/alp/agent-library.md#teams)). Select the
team in the Paseo model picker, with `alp run --team`, or in
`.alp/settings.json` → `workflow.mode`; `alp teams` lists them. The default concurrent peer limit is 2;
raise `workflow.maxPeers` only at the user's request. Writers in the shared checkout
run one at a time, across all sessions; writing peers can run in parallel in their own
git worktrees (`isolation: "worktree"`) and are merged with `alp_merge`. Oracle runs
on Fable (`claude:claude-fable-5-1`) or Astra (`codex:gpt-6-astra`); main may ask
both in parallel for two opinions. Runtime catalog and available plan/usage snapshots
inform coordination. See [team configuration and migration](docs/alp/team-workflow.md).
