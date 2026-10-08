# ALP provider for Paseo

Filesystem-defined agents backed by local Codex or Claude Code, with two workflows:

- **Smart**: main implements or delegates directly to peer.
- **Supervised**: main supervises lead, which implements or delegates to peer.

Both workflows support read-only oracle and reviewer agents. New projects default
to Smart and a maximum of two concurrent peers. Writing assignments in a shared
checkout remain serialized.

## Install

Requires Paseo 0.11.1, Node.js 20+, and an authenticated native Codex or
Claude Code executable on PATH. Enable plugins in Paseo Settings → Plugins, then:

```sh
paseo plugin add npm:alp-paseo-plugin
paseo provider models alp
```

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
