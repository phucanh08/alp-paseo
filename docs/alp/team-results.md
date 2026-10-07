# Team workflow verification — 2026-10-07

Implemented scope: editable main/lead/peer templates, initializer and explicit legacy
upgrade, provider-neutral delegation graph validation, and actual nested child
execution through the Paseo provider's Codex adapter.

## Acceptance evidence

| Requirement | Result |
|---|---|
| Main receives the user task and delegates to lead | Real Paseo main turn invoked alp_delegate; lead appeared as a direct child |
| Lead delegates to peer | Paseo recorded peer with parentSubagentId pointing to lead |
| Real results return to main | Read-only peer-only token returned through both tool calls |
| Main participates in delivery | Write test used the shipped roles: peer wrote, lead verified, main independently verified and answered |
| Work is constrained to the assignment | Script compared all fixture bytes; read-only changed nothing, write changed only team-proof.txt |
| Existing projects can migrate | Unit tests cover original template backup, runtime setting preservation, custom instruction/graph preservation, idempotence, malformed settings |
| Runtime controls delegation | Unit tests cover targets, caller identity, mode restriction, duplicate calls, concurrency, root call limit, timeout, failure, steering, interruption, and closing during child initialization |

## Commands and artifacts

- `node scripts/build-paseo.mjs`
- `node --test` — 51/51 passed.
- `node node_modules/typescript/bin/tsc -p tsconfig.paseo.json` — passed.
- Node 24: `node scripts/team-e2e.mjs` — passed on isolated Paseo at 127.0.0.1:16767.
- Node 24: `node scripts/team-e2e.mjs --write` — passed on the same daemon.

Local artifacts (not credentials): `.alp-test/team-e2e.json` and
`.alp-test/team-write-e2e.json`. Each records the root agent, child records, final
answer, and parent timeline. Fixture directories are recorded in those files.
The test agents were archived after verification. The already-running isolated
daemon was left running and its existing ALP plugin was reloaded with the new build.

The write run encountered a Windows PowerShell launch denial inside the runtime;
the agents successfully used the available command shell to verify bytes. This is
an environment limitation to account for when choosing project verification commands.

## Practical limits

See [team workflow](team-workflow.md): synchronous one-child delegation; no live
child-tree recovery after restart; fresh parent sessions needed after changing the
registered tool target list. Role prose is not a per-file security boundary. No
Desktop screenshot/UI interaction was used as evidence; verification used the real
daemon, public provider events, client API, and filesystem artifacts.
