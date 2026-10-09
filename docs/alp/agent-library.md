# Agent library

ALP finds agents, skills, MCP servers and hooks in three layers. A later layer replaces an
entry of the same name from an earlier one:

1. **Built-in:** shipped with ALP and updated with it. These are the agents `main`, `lead`,
   `peer`, `oracle`, `reviewer` and `supervisor`.
2. **Library:** yours, in `$ALP_HOME` (default `~/.alp`), shared by every project.
3. **Project:** in the project's `.alp/`, for that project only.

```text
~/.alp/  or  <project>/.alp/
  agents/<name>/AGENT.md       instructions
  agents/<name>/agent.json     optional: what the agent runs on and uses
  skills/<name>/SKILL.md
  mcp/<name>.json              one MCP server
  hooks/<name>.json            one hook
```

Projects no longer get copies of the built-in agents. `alp upgrade` puts away copies that
are still as ALP shipped them, with a backup in `.alp/backups/`. A copy you edited, or added
skills, MCP servers or hooks to, stays and keeps overriding the built-in.

## Agents

An agent replaces the one it overrides whole. A project `main` with only `AGENT.md` does not
inherit the library main's `agent.json`. A library directory without `AGENT.md` is not an
agent.

`agent.json` is optional:

```json
{
  "description": "Writes release notes",
  "provider": "claude",
  "model": "claude-sonnet-5-5",
  "thinking": "medium",
  "mode": "workspace-write",
  "skills": ["style"],
  "mcp": ["docs"],
  "hooks": ["tests"]
}
```

- `provider` is `codex`, `claude`, or an [ACP provider](#acp-providers) of your library.
- `provider`, `model` and `thinking` apply when nothing earlier chooses. The order is: the
  caller (such as `alp run --model` or a delegation's model), then settings' `runtime`,
  then the session's team for that member, then `agent.json`.
- `mode` is the agent's default permission mode when its caller does not choose one. A
  permission profile still caps it.
- `skills`, `mcp` and `hooks` name entries of the project, else the library. A name that
  resolves to neither fails with the `agent.json` path, and so does an unknown key, with a
  suggestion for a likely typo.
- The skills come after the role's skills from `role-skills.json`. The agent's own
  `skills/` directory comes last and replaces a skill of the same name.
- The MCP servers come before the agent's own `.mcp.json`. A server named in both is an
  error.

## MCP servers

`mcp/<name>.json` holds one server, in the same form as an entry of `.mcp.json`:
`{ "command", "args", "env", "cwd" }` for stdio, or `{ "url", "headers" }` for HTTP. A
relative `cwd` is relative to the file's directory.

## Hooks

`hooks/<name>.json` is a shell command ALP runs at one of its events:

```json
{ "event": "handoff", "command": "npm test", "blocking": true, "timeoutSec": 600 }
```

- `event` is one of `session.start`, `turn.end`, `assignment.start`, `assignment.end`,
  `handoff`, `task.close` or `merge`.
- Only `handoff`, `task.close` and `merge` hooks can block.
- `timeoutSec` is from 1 to 3600.
- `match` can limit a hook to an `agent` or a task `label`.

ALP runs an agent's hooks itself, whatever runtime the agent is on (ALPD §45):
- **When:**
  - `session.start` when a session of the agent opens;
  - `turn.end` after each of its turns;
  - `assignment.start` and `assignment.end` around an assignment it does;
  - `handoff` when it calls `alp_handoff`;
  - `task.close` when it closes a task;
  - `merge` before `alp_merge` applies a worktree change.
- **How:**
  - The command runs with `/bin/sh` in the session's directory. The event comes as
    JSON on stdin, and `ALP_EVENT`, `ALP_SESSION`, `ALP_AGENT`, `ALP_TASK` and
    `ALP_PROJECT` are set.
  - It runs in its own process group, which is stopped whole at the timeout (default
    60 s).
- **Blocking:** a blocking hook that fails refuses the handoff, the close or the merge.
  The end of its output (stderr, else stdout) is the reason the agent reads, so it can
  fix the problem and try again. Other hooks run in the background and only record.
- **Logging:** each run is in the run log, and `alp log` shows it.
- **Trust:**
  - A hook from the project's `.alp/` comes with the repository, so ALP asks you once
    per workspace before running it ("Trust this workspace" or "Not now").
  - Once you agree, that project's hooks run from then on without asking, including
    hooks added or changed later. ALP keeps this in `$ALP_HOME/state/trust.json`.
  - "Not now" skips the project's hooks for that session's tree, and a blocking one
    does not block.
  - `alp trust [--project DIR]` trusts a workspace ahead of time, `alp trust --revoke`
    forgets it, and `alp trust --list` shows them.
  - Hooks in your library are always trusted.
- `alp doctor` lists the hooks agents use, whether the project's are trusted, and
  hooks whose program is not found.

## ACP providers

An ACP provider is any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com)
on stdio, such as Gemini CLI or opencode. `providers/<id>.json` in your library
defines one:

```json
{
  "kind": "acp",
  "label": "Gemini",
  "command": "gemini",
  "args": ["--experimental-acp"],
  "env": {},
  "models": [{ "id": "gemini-2.5-pro" }]
}
```

- **Where they live:** providers live only in your library, never in a project. A
  project's provider would run a command from its repository on your machine.
  `codex`, `claude` and `acp` cannot name a provider.
- **Using one:** an agent runs on a provider with `"provider": "<id>"` in its
  `agent.json`, optionally with a `model`. The model `acp:<id>` or `acp:<id>/<model>`
  also chooses one, in `alp run --model`, in a team member's model, and in
  `alp_delegate`.
  - With `models`, only those model ids are accepted.
  - ALP asks the agent to switch models only when the agent offers a choice.
  - ACP agents choose their own effort, so `thinking` does not apply.
- **What ALP does for an ACP agent:**
  - It sends the agent's instructions with its first prompt.
  - It shows the agent's messages and tool calls in the timeline, and its context use.
  - It gives the agent ALP's tools (`alp_handoff`, `alp_delegate`, `alp_task` and the
    others) as an MCP server named `alp`, beside the agent's own MCP servers.
  - It answers the agent's permission requests by the session's mode:
    - read-only allows reading and searching;
    - workspace-write also allows running commands, and changing files inside the
      workspace;
    - full access allows everything.
  - A permission profile's `Bash(...)` rules apply to the commands the agent asks to
    run. Anything beyond the mode is refused, or goes to the user with
    `"beyondMode": "ask"`.
- **Limits** (`alp doctor` warns about them):
  - ALP has no sandbox around an ACP agent. It holds the mode only by answering the
    permission requests the agent sends, so a command the agent runs without asking
    runs unchecked.
  - Mail waits for the turn to end, since ACP cannot steer a running turn.
  - A session resumes only when the agent supports `session/load`.
  - `alp_recall` cannot ask a finished ACP assignment, and review copies cannot run on
    one.
- **Commands:**
  - `alp provider add <id> --command C [--arg A]... [--env K=V]... [--models a,b]`
    adds a provider;
  - `alp providers` lists them, with the agents that use each;
  - `alp provider test <id>` starts the agent, runs `initialize`, and reports what it
    supports.

## Teams

A team is `teams/<id>/team.json` with an optional `HOUSE_RULES.md`, in the same three
layers: Phở (`pho`) and Cafe (`cafe`) are built in, and a library or project team of
the same id replaces one whole.

```json
{
  "label": "Docs",
  "description": "An architect plans; writers write.",
  "main": "architect",
  "members": {
    "architect": { "model": "claude:claude-sonnet-5-5", "thinking": "low" },
    "writer": { "role": "peer" },
    "reviewer": { "role": "reviewer" }
  },
  "delegation": { "architect": ["writer", "reviewer"] },
  "maxPeers": 3,
  "supervisor": { "agent": "watcher", "model": "codex:gpt-6-sol", "thinking": "low" }
}
```

- `main` is the agent the user talks with. In a session of the team it has main's
  powers: full access by default, the task graph, issues, lessons and a supervisor.
- Every other member has a `role`: `lead`, `peer`, `advisor` or `reviewer`. Members
  with role `peer` count toward `maxPeers`; peers and advisors may run in parallel.
- `model` and `thinking` on a member come before the agent's own `agent.json`.
  Settings' `runtime` and the caller still come first.
- `delegation` says who may assign work to whom. It names only members, never
  assigns to main, and must have no cycle.
- `supervisor` is `false`, or the agent that reviews main's process after each turn
  and what it runs on. It is not a member.
- `HOUSE_RULES.md` is prose that every member of a session reads after
  `Profile: <id>; fixed for this session.` Phở and Cafe's house rules are the text
  ALP gave main before teams. A project with a custom `delegation` graph and no team
  follows Phở's house rules, and its main runs as Phở's does.

`alp teams [--project DIR] [--json]` lists them with members, delegation and
supervisor, and Paseo offers them in its model picker.

## Editing

The CLI changes your library in `~/.alp`, or with `--project [DIR]` the project's
`.alp/`. It never changes a built-in. To change one, copy it (`cp`), or save an entry
of its name in the library or the project, which overrides it.

```sh
alp agent new writer -d "Docs writer" --model claude:claude-sonnet-5-5 --skills style
alp agent edit main --project --instructions main.md   # the project's own main
alp team new docs --from pho --label Docs --main writer --member reviewer=reviewer \
  --delegate writer=reviewer --member-model writer=claude:claude-opus-5-5 --rules rules.md
alp skill new style --file style.md
alp mcp add docs --url https://example.test/mcp --header Authorization="Bearer …"
alp hook add tests --event handoff --command "npm test" --blocking --timeout 600
alp agent show main            # the entry that applies, where from, and who uses it
alp agent cp main architect    # built-ins too
alp hook mv tests checks
alp mcp rm docs
```

- **Editing a lower layer's entry:** `edit` on an entry that only a lower layer has
  (a built-in, or the library's for `--project`) creates this scope's override from it.
- **What an entry names must exist where it lives:**
  - a library agent can name only library skills, MCP servers and hooks;
  - a project agent can name the project's and the library's;
  - a team names agents that exist.
- **Removing or renaming:** refused while an agent, a team or the project's settings
  use the entry, and the error lists them. Removing an override is always allowed:
  the entry below it applies again.
- **Testing:**
  - `alp mcp test <name>` starts the server, lists its tools, and stops it;
  - `alp provider test <id>` starts an ACP agent, runs `initialize`, and stops it;
  - `alp hook test <name>` runs the hook once, with a sample event on stdin and
    `ALP_EVENT`, `ALP_SESSION`, `ALP_AGENT`, `ALP_TASK` and `ALP_PROJECT` set, and
    says whether a blocking hook would refuse the action.
- **Concurrent edits:** every save checks the entry's revision from when it was read,
  so two editors cannot overwrite each other. Files are written through a temporary
  file and a rename.

The Paseo plugin offers the same operations to its settings screen as `alp.library.*`
RPC.

## Listing

```sh
alp agents [--project DIR] [--json]
alp skills [--project DIR] [--json]
alp mcp    [--project DIR] [--json]
alp hooks  [--project DIR] [--json]
```

Each line names an entry, where it comes from (built-in, library or project), what it
overrides, and which agents use it. `alp doctor` reports an agent that cannot start because
a reference does not resolve, and notes each agent the project or library overrides.
