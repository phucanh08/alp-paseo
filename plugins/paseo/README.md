# ALP provider for Paseo

Filesystem-defined agents backed by local Codex or Claude Code. The model picker
offers two profiles, and nothing else:

- **Phở**: main implements or delegates directly to peer.
- **Cafe**: main supervises lead, which implements or delegates to peer.

In both, main runs on Opus 5.5 with high effort and full access, and starts a
supervisor on Sonnet 4.6, shown as a child session, that reviews main's process
after each turn and asks main about mistakes; main records lessons it follows in
later sessions. Both profiles support read-only reviewer and oracle agents; oracle
runs on Fable or Astra, and main may ask both for two opinions. New projects default
to Phở and a maximum of two concurrent peers. Writing assignments in the shared
checkout run one at a time; in a git repository, writing peers can run in parallel,
each in its own worktree, and their changes are merged back with `alp_merge`.

## Tasks panel

Each workspace gets a **Tasks** panel (also in the command center as "Open ALP
tasks") showing the tasks of its ALP project, in `.alp/tasks`:
- First, what waits for you: human gates you approve there. Then tasks in review
  with their handoff, in progress, ready, and blocked or waiting.
- Recently closed tasks are folded away.
- You can add a task with a priority, close a task, accept one in review, or
  reopen one.

The panel reads and writes the task files through the plugin's server, so it
works without alpd, and it refreshes every five seconds while open.

On a phone, where the workspace's panels are out of reach, the same board opens
as a full screen from the chat:
- the **Tasks** pill in the composer of each ALP agent (for example "Tasks · 3")
  lists the open tasks. Tapping one opens it; **All tasks** opens the board.
- `/tasks` opens the board, and `/tasks <id>` opens that task.

## Install

Requires Paseo 0.11.1 or a later 0.11 release, Node.js 20+, and an authenticated native Codex or
Claude Code executable on PATH.

ALP sessions run in `alpd`, a per-user daemon from the `@anhlp/alp` package; Paseo
only views them. Install the CLI and start the daemon once, so it records where
it is installed:

```sh
npm install -g @anhlp/alp
alp daemon start
```

Then enable plugins in Paseo Settings → Plugins and add the provider:

```sh
paseo plugin add npm:alp-paseo-plugin
paseo provider models alp
```

From then on the plugin keeps alpd running while Paseo runs. It starts alpd when
Paseo starts, checks every 5 seconds, and starts it again when alpd is down; with
`alp daemon install`, it starts alpd through that service. Sessions open in Paseo
stay open across the restart: the plugin reconnects, shows that it lost and
regained alpd, and a session alpd did not reopen resumes from its thread at the
next prompt. After `alp daemon stop` the plugin leaves alpd stopped until you
prompt in Paseo, run `alp daemon start`, or start Paseo again. Set
`ALP_SUPERVISE=0` in the Paseo daemon's environment to turn the watching off. If the provider
reports that alpd.js was not found, run `alp daemon start` once, or set
`ALP_DAEMON_ENTRY` to the absolute path of `alpd.js` in the Paseo daemon's
environment. `ALP_HOME` (default `~/.alp`) selects the daemon's directory and
must match between the CLI and Paseo.

Closing an agent in Paseo stops watching it; work in progress finishes in
alpd. Use interrupt to stop work. You talk with main: when main asks you a
question with `alp_ask`, Paseo shows it as a question prompt; your answer, or a
dismissal, goes back to main. Other agents reach you only through main, unless
you write to one of them with `alp send`. `alp top` shows the whole tree live. Sessions started with `alp run` can be
imported into Paseo with their child agents.

Select ALP and a profile, Phở or Cafe, when creating a new session. There is no
Workflow setting, and model and effort are not chosen in Paseo; the permission mode
defaults to full access. Missing ALP starter files are initialized automatically.
The profile stays fixed for the session. To change main's model, set `runtime.model`
in `.alp/settings.json`:

```json
{
  "defaultAgent": "main",
  "workflow": { "mode": "cafe", "maxPeers": 2 },
  "runtime": { "model": "claude:claude-fable-5-1", "reasoning": "high" }
}
```

Skills and the skills each role gets live in your library in `ALP_HOME`
(`skills/` and `role-skills.json`), seeded on first use; app updates do not
overwrite what you changed.
`ALP_CODEX_BIN` and `ALP_CLAUDE_BIN` can select absolute native executables.

See [workflow and migration documentation](https://github.com/phucanh08/alp-paseo/blob/main/docs/alp/team-workflow.md)
for existing projects, model selection, permissions, and runtime limitations.
