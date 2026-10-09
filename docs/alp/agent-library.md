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

- `provider`, `model` and `thinking` come before the project's `runtime` settings. A caller's
  explicit choice, such as `alp run --model` or a delegation's model, still comes first.
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

ALP checks hook files when an agent names them. It does not run hooks yet (phase 13,
step 5), so an agent with hooks is refused when a session starts.

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
