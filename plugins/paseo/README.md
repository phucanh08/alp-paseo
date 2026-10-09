# ALP provider for Paseo

Filesystem-defined agents backed by local Codex or Claude Code, with two workflows:

- **Smart**: main implements or delegates directly to peer.
- **Supervised**: main supervises lead, which implements or delegates to peer.

Both workflows support read-only oracle and reviewer agents. New projects default
to Smart and a maximum of two concurrent peers. Writing assignments in the shared
checkout run one at a time; in a git repository, writing peers can run in parallel,
each in its own worktree, and their changes are merged back with `alp_merge`.

## Install

Requires Paseo 0.11.1, Node.js 20+, and an authenticated native Codex or
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

From then on the plugin starts alpd by itself when needed. If the provider
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

Select ALP when creating a new session. Missing ALP starter files are initialized
automatically. To select Supervised for new sessions, set `.alp/settings.json`:

```json
{
  "defaultAgent": "main",
  "workflow": { "mode": "supervised", "maxPeers": 2 }
}
```

You can also set `options.workflow` to `smart` or `supervised` when creating a
session through the Paseo client. Workflow stays fixed for the session.
`ALP_CODEX_BIN` and `ALP_CLAUDE_BIN` can select absolute native executables.

See [workflow and migration documentation](https://github.com/phucanh08/alp-paseo/blob/main/docs/alp/team-workflow.md)
for existing projects, model selection, permissions, and runtime limitations.
