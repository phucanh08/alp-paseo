# Phase 13 — ALP settings in Paseo: teams, agents, skills, MCP, hooks, ACP providers

**Status:** approved by the user on 2026-10-09 as decision D23, with the answers below. Built one step per PR.

## What the user asked for

- An ALP settings screen in Paseo.
- That screen adds ACP providers, beyond Codex and Claude, to ALP.
- It creates agent teams, agents, skills, MCP servers and hooks.
- An agent selects its own skills, hooks and MCP servers.
- A team groups agents and has a workflow, and house rules for that workflow.
- Phở and Cafe are teams.
- Later, the mains of different teams talk to each other to get work done. That part is only noted, in [phase 14](14-team-of-teams.md).

## Decided with the user (2026-10-09)

1. **Where definitions live:** a library in `~/.alp` serves every project. A project can override any entry in its own `.alp/`, and on the same name the project wins. The settings screen edits the library, and a workspace panel edits the current project's overrides.
2. **Hooks** are run by ALP (alpd), not by each runtime. They are shell commands at ALP's own events. They work the same for Codex, Claude and every ACP agent, and a hook either blocks or only records.
3. **ACP:** a general provider framework, where a provider is a command, its arguments and its environment. It is tested with a scripted fake ACP agent. No real ACP agent is wired or live-tested in this phase. Gemini CLI, opencode and Copilot CLI are installed on the user's machine and can be added later as plain providers.
4. **Process:** write the plan for approval first, then build it one step per PR.

## Where things stand

- **Agents** are per project: `.alp/agents/<name>/AGENT.md`, an optional `skills/` and `.mcp.json`. The resolver already collects a `hooks/` directory, and nothing runs it (the adapter reports hooks as `unsupported`).
- **Skills** are in the `~/.alp/skills` library. `~/.alp/role-skills.json` assigns them by role, and an agent's own `skills/` replaces a library skill of the same name.
- **Phở and Cafe** are hard-coded:
  - their labels in `src/core/workflow.js` (`profiles`), and their delegation graphs in `workflowGraphs`;
  - main's model and effort in the runtime;
  - the coordination text in `nativeSessionConfig` (`runtime.ts`).
  - Paseo shows them in place of models (`mapping.ts`, `profileModels`).
- **Runtimes:** `CodexTransport` (app-server, dynamic tools) and `ClaudeTransport` (Agent SDK, ALP tools through an in-process MCP server). `phases/09-acp.md` is the opposite direction, ALP as an ACP server, and stays separate.
- **Paseo 0.11.1** gives plugins `addSettingsScreen` and `addScreen`, settings components (`SettingsSection`, `SettingsRow`, `SettingsSwitch`, `SettingsSelect`, `SettingsInput`, `SettingsAction`), workspace panels, and typed RPC to the plugin server. The Tasks panel already uses the panel and the RPC.

## Data model

```
~/.alp/                                   <project>/.alp/   (same layout; an entry here overrides the library)
  agents/<name>/AGENT.md                  instructions, as today
  agents/<name>/agent.json                { description, provider, model, thinking, mode,
                                            skills: [..], mcp: [..], hooks: [..], permissions? }
  skills/<name>/SKILL.md                  as today
  mcp/<name>.json                         one server: { command, args, env } or { url, headers }
  hooks/<name>.json                       { event, command, blocking, timeoutSec, match? }
  providers/<id>.json                     { kind: "acp", label, command, args, env, models? }
  teams/<id>/team.json                    { label, description, main, members, delegation,
                                            maxPeers, supervisor, review?, formula? }
  teams/<id>/HOUSE_RULES.md               the team's rules and process, in prose
```

- **Built-ins** ship read-only in the package (`templates/`), and "Duplicate" makes an editable copy. They are:
  - the agents main, lead, peer, oracle, reviewer and supervisor;
  - the skills;
  - the providers `codex` and `claude`;
  - the teams `pho` and `cafe`.
- **Agent:** `agent.json` is optional. Without it, an agent behaves as today. Its `skills`, `mcp` and `hooks` name library or project entries, and the resolver checks that each one exists. The agent's own `skills/` and `.mcp.json` keep working and come after the named ones.
- **Team:**
  - **Workflow** is the structured part:
    - who is main;
    - the members and their roles (main, lead, peer, advisor, reviewer, supervisor);
    - the delegation graph, which must stay acyclic as today;
    - `maxPeers`, and whether a supervisor reviews and on which model;
    - optionally, the review policy (when reviewer is required) and a formula to pour for a standard run.
  - **House rules** (`HOUSE_RULES.md`) are prose added to every member's instructions under "Team house rules". Main's coordination guidance moves there from `runtime.ts`.
  - One agent can belong to several teams.
- **Migration** (`alp upgrade`, with a backup):
  - `role-skills.json` becomes the `skills` lists of the built-in agents;
  - `settings.json` `workflow.mode` (`pho`/`cafe`) becomes `team`;
  - a custom `delegation` graph becomes a project team named `custom`.
  - Projects keep their `.alp/agents/*`, which now count as overrides.
  - `alp init` no longer copies the built-in agents into new projects (open question 1).

## Steps (one PR each, after approval)

### Step 1 — Library model and resolution

- **Core:** resolve agents, skills, MCP servers, hooks, providers and teams from the built-ins, then the library, then the project, with the project winning on the same name.
- **Validation:** `agent.json`, `mcp/*.json`, `hooks/*.json`, `providers/*.json` and `team.json`, with messages that name the file and the key, and with C5's did-you-mean suggestions.
- **CLI:** `alp agents|skills|mcp|hooks|providers|teams [--project DIR] [--json]` lists the entries, showing where each comes from (built-in, library or project) and what it overrides.
- `alp doctor` checks that every reference resolves.
- No behaviour changes: existing projects resolve the same agents with the same instructions. The C4 instructions digests stay equal on the fixtures.

### Step 2 — Teams; Phở and Cafe become teams

- `templates/teams/pho` and `templates/teams/cafe` hold `team.json` and `HOUSE_RULES.md`. The rules are the text the runtime hard-codes today, moved and not rewritten.
- The runtime takes from the session's team:
  - the graph;
  - the roles and the supervisor;
  - the models main and the advisors run on;
  - the house rules.
- `profiles` and `workflowGraphs` go away.
- Paseo's model list shows every team: the built-ins, then the library's, then the project's.
- Sessions:
  - `alp run --team <id>` starts a session in a team, and `--profile` stays as an alias;
  - existing sessions with `pho` or `cafe` resume unchanged.
- Golden test: main's instructions for Phở and Cafe are the same before and after the move, apart from the section heading.

### Step 3 — Editing API and CLI

- **Core** functions to create, update, duplicate, rename and delete each kind:
  - validate first, then write atomically, with a revision check so two editors do not overwrite each other;
  - never edit a built-in;
  - deleting an entry another one references fails and lists who uses it.
- **CLI:**
  - `alp agent new|edit|rm`, `alp team new|edit|rm`, `alp skill new|rm`, `alp mcp add|rm|test`, `alp hook add|rm|test`, `alp provider add|rm|test`;
  - each takes `--project` to write an override in the project instead of the library.
- **Plugin server:** typed RPC contracts `alp.library.*` (list, get, save, delete, duplicate, test) over the same core functions, as the Tasks panel does.

### Step 4 — The ALP settings screen in Paseo

- **`addSettingsScreen`, titled "ALP".** It has six sections: Teams, Agents, Skills, MCP servers, Hooks and Providers. Each section is a list with badges for built-in, library and overridden entries, plus New and Duplicate.
- **Agent editor:**
  - name and description;
  - provider, model and thinking, drawn from the provider's catalog;
  - the default permission mode;
  - instructions (`AGENT.md`);
  - checklists of skills, MCP servers and hooks.
- **Team editor:**
  - label and description;
  - members chosen from the agents, each with a role;
  - the delegation graph as a matrix of who may delegate to whom, with cycles refused;
  - maxPeers and the supervisor;
  - the review policy;
  - house rules (`HOUSE_RULES.md`).
- **Other editors:**
  - a skill's `SKILL.md`, and the agents using it;
  - an MCP server (stdio or HTTP), with a Test button that starts it and lists its tools;
  - a hook: event, command, blocking or not, timeout, and Test with a sample payload;
  - an ACP provider: command, arguments and environment, with a Test button that runs `initialize` and shows its capabilities and models.
- **"ALP project" workspace panel:**
  - it shows what the current project overrides;
  - "Override in this project" copies an entry into `.alp/`;
  - "Use library" removes the override.
- Changes apply to new sessions. A running session keeps the definitions it started with: its C4 digest records them.

### Step 5 — Hooks run by ALP

- **Events:**
  - `session.start`, `turn.end`;
  - `assignment.start`, `assignment.end`;
  - `handoff`, which can block: for example, refuse a handoff until the tests pass;
  - `task.close`, which can block;
  - `merge`, before `alp_merge` applies a worktree.
- **How a hook runs:**
  - The command runs in the session's working directory. It gets the event as JSON on stdin and `ALP_EVENT`, `ALP_SESSION`, `ALP_AGENT`, `ALP_TASK` and `ALP_PROJECT` in its environment. It has a timeout, and B2's graceful stop applies.
  - A blocking hook that exits non-zero refuses the action, and its stderr becomes the reason the agent reads. A non-blocking hook only records.
  - Each run is logged in the run log as `hook`, and `alp log` shows it.
- **Trust:** a project hook comes with the repository, so a cloned project could run commands. alpd asks the user once per hook file and content digest (`alp_ask` to the user, or Paseo's question prompt), and remembers the answer in `$ALP_HOME/state/trust.json`. Library hooks are trusted, since the user wrote them.
- `alp doctor` reports hooks that are not trusted and commands that are missing.

### Step 6 — ACP providers

- **`AcpTransport`**, beside the Codex and Claude transports, behind the same runtime interface:
  - it spawns the provider's command and speaks JSON-RPC over stdio: `initialize`, `session/new` with `cwd` and `mcpServers`, `session/prompt` and `session/cancel`, and `session/load` where the agent advertises it, for recovery (§31) and recall;
  - it maps `session/update` to ALP's items (messages, tool calls, plan, usage), so the timeline, context fill (C1) and the logs work;
  - `session/request_permission` is answered from the permission profile (D19), or asks the user.
- **ALP tools for ACP agents:**
  - Every ACP agent must support stdio MCP servers, so `session/new` includes a stdio bridge, `alp mcp-bridge --session <id>`. It connects to alpd's socket and offers the session's ALP tools: `alp_handoff`, `alp_delegate`, `alp_send` and the others.
  - The agent's own MCP servers are passed through as well.
- **Limits, stated in the session and in `alp doctor`:**
  - ACP has no steer, so mail waits for the turn to end.
  - ALP cannot sandbox an ACP agent's own tools, so `read-only` and `workspace-write` depend on the agent asking permission. Reviewer copies (§26) need an agent that does.
- Providers are added in Settings or with `alp provider add`. An agent then picks `provider: "<id>"` and a model.
- **Tests:** a scripted fake ACP agent in `test/support` that streams messages, calls ALP tools through the bridge, asks permission, gets cancelled, loads a session and crashes. No real agent is used (decision 3).

## Answers to the open questions (2026-10-09)

1. **New projects:** `alp init` stops copying the built-in agents. A new project uses the built-in and library agents. Copies that existing projects already have are overrides, and `alp upgrade` puts away the unedited ones, with a backup.
2. **Team models:** both, as proposed. An agent sets its own model and effort, and a team may set them per member, overriding the agent's.
3. **Hook trust:** ALP asks once per workspace (project). Once the user agrees, that project's hooks run from then on without asking again, including hooks added or changed later. Library hooks are always trusted.
4. **ACP permission modes:** all three modes, as proposed. The limit is stated in the session's instructions, and `alp doctor` warns about it.

Built-in agents, teams and providers are read from the package's templates, so they follow ALP updates. To change one, duplicate it, or make a library or project entry with the same name, which overrides it.

## Not in this phase

- [Phase 14](14-team-of-teams.md): mains of different teams working together.
- ALP as an ACP server ([phase 9](09-acp.md)).
- Wiring Gemini CLI, opencode or Copilot CLI as tested providers. This needs one short PR each after step 6, when the user asks.
