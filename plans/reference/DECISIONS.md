# Stable Architecture Decisions

These decisions are authoritative unless the user explicitly changes them.

## D1 — Project instructions

`ALP.md` is the project-level instruction source.

## D2 — Project configuration

`.alp/settings.json` contains ALP configuration such as `defaultAgent` and runtime/provider defaults. It should not contain large prompt bodies.

## D3 — Built-in agents

Updated by explicit user request on 2026-10-07: `alp init` creates `main`, `lead`, and `peer` as editable starter agent packages. `main` remains the default user-facing agent.

`main` is an active supervisor and outcome owner: it frames work, assigns lead, makes in-scope decisions, unblocks, reviews, integrates, and may implement. Lead owns technical execution and peer acceptance. Peer owns a bounded assignment. Normal communication is user -> main -> lead -> peer, with evidence returning in reverse order. Direct user contact with other roles is exceptional.

The starter is not a closed role enum. Core discovers arbitrary agent directories and applies the configured delegation graph without assigning hidden semantics to their names.

## D4 — Self-contained agent package

Each agent lives at:

```text
.alp/agents/<name>/
├── AGENT.md
├── skills/
├── hooks/
└── .mcp.json
```

An agent directory should be portable without requiring registration in a central agent list.

## D5 — Discovery

Filesystem discovery is the agent registry. Do not require every agent to be duplicated inside `settings.json`.

## D6 — Effective instructions

The runtime combines:

```text
ALP.md
+
selected agent/AGENT.md
+
runtime/provider-specific launch material
```

Do not duplicate `ALP.md` into every agent folder.

## D7 — Provider neutrality

ALP core owns semantics. Claude, Codex, Paseo, and ACP are integrations/adapters.

Core types must not import provider-specific SDK types.

## D8 — Paseo first

Use a Paseo plugin/provider integration as the first runtime host because Paseo already supplies session lifecycle, workspace/worktree handling, persistence, timeline/events, steering/cancel, and provider infrastructure.

Do not fork Paseo unless the plugin boundary proves insufficient for a concrete requirement.

Superseded by D12 on 2026-10-08: Paseo validated the runtime path and remains the primary viewer, but it is no longer the runtime host.

## D9 — ACP later

Do not make ACP the canonical ALP config format. Implement standalone ALP ACP only after `ResolvedAgent` and the ALP session/event model are stable.

Updated 2026-10-08: ACP is an adapter over the `alpd` API (D12), not the daemon's primary protocol, because ACP cannot represent mailbox and delegation trees faithfully.

## D10 — Progressive disclosure

Skills and planning content should be loaded lazily. Avoid injecting all skill bodies and all future planning files into context.

## D11 — Explicit delegation and active supervision

The user authorized real Paseo delegation on 2026-10-07. `.alp/settings.json` may contain a provider-neutral `delegation` adjacency map. The starter maps `main` to `lead`, and `lead` to `peer`; missing configuration disables delegation. This map is authorization for delegation, not an agent registry.

The Paseo adapter owns runtime tool calls and child session lifecycle. It binds sender identity to the active session, validates targets, inherits or narrows permissions, and returns real child results. The first implementation is synchronous and bounded: one child per parent, no delegation cycles, at most four agents in a chain and sixteen child assignments per root turn. Child sessions close on handoff, timeout, parent cancellation, or parent steering.

Updated by explicit user decision on 2026-10-08: delegation may be asynchronous, with two-way mail along the delegation tree (`alp_wait`, `alp_send`, `alp_ask`). Siblings never address each other directly; the requester relays. Direct sibling mail is deferred until parallel writers are isolated. User steering no longer closes children; interrupt, inactivity, and parent shutdown still close the subtree. Idle requesters are woken by mail.

Main's expanded authority does not elevate sandbox permissions or override user constraints. Authorship and independent review remain distinct. Role instructions are behavioral contracts; the runtime enforces delegation routes and modes, not arbitrary prose ownership rules or per-file access controls.

## D12 — Native ALP daemon

Decided by the user on 2026-10-08. ALP runs as `alpd`, one native daemon per user that serves many projects. `alpd` owns native runtimes (Codex, Claude), session lifecycle, delegation trees, mailbox, persistence, and later file leases/worktrees. Agent-to-agent calls stay inside `alpd` and never round-trip through a viewer.

`alpd` exposes ALP's own JSON-RPC API with a provider-neutral event stream over a user-only local socket. Clients are views: the Paseo plugin becomes a thin RPC client that may create, prompt, steer, and interrupt sessions, all forwarded to `alpd`; the `alp` CLI proves headless operation; ACP is a later adapter (D9). Paseo stores only a pointer to the ALP session. Clients auto-start the daemon when it is not running.

Migration is incremental, with existing e2e evidence kept green at each step: (1) extract runtimes, delegation, and mailbox from the Paseo plugin into a Paseo-free in-process runtime (Phase 8); (2) host that runtime in `alpd` behind the socket and reduce the plugin to a client, adding CLI commands; (3) move persistence to `alpd`; (4) build phase C (leases/worktrees) in the daemon. The daemon precedes phase C.

## D13 — Parallel writers through worktrees and checkout leases

Built on 2026-10-09 as phase C in alpd, at the user's request to proceed on the proposed design. Writing assignments run in parallel only when each has its own git worktree (`isolation: "worktree"`); the requester applies a finished change to its checkout with `alp_merge` (uncommitted, conflicts left as markers) or drops it with `alp_discard`. In a shared checkout, alpd grants one write lease per checkout to assignments across all trees, shared with assignments nested under the holder. Work is never deleted silently: unmerged or interrupted work stays on its `alp/<assignment>` branch. Advisory per-path leases within a shared checkout are deferred. Details: [alpd §16](ALPD.md).

## D14 — The user talks with main

Built on 2026-10-09 as phase D; the rule below was set by the user on 2026-10-09. By default the user talks only with main. Other agents do not talk to the user unless the user writes down to them first. When the user writes to an agent, that agent must let its requester know; ALP posts the note itself, so it cannot be forgotten. Main asks the user with `alp_ask`, without ending its turn. An assignment's `alp_ask` to the user is refused until the user has written to it, and the answers it then gets are also reported to its requester. Routing between agents still goes through requesters (D11). Questions appear in Paseo as question prompts and in the CLI; trees are observable with `alp top` and `alp log`. Details: [alpd §17](ALPD.md).

## D15 — Findings go to a project group channel (built as the project board)

Noted from the user on 2026-10-09. This replaces the deferred "direct sibling messaging" item of D11. Each project or workspace gets one group, and agents pin what they find to its chat channel instead of mailing siblings. Built the same day as the project board (ALPD §18). Agents pin claims on the paths they change, decisions and findings. An overlapping claim from another line of delegation is refused, so agents working independently do not edit each other's files. New pins reach agents whose turns are running, and new assignments start with a digest of the board. A channel for pinning tasks, and tools to show the board to the user in Paseo, are left for a later phase.

## D16 — Phở and Cafe profiles, a supervisor, and the user's skill library

Decided by the user on 2026-10-09. The workflows Smart and Supervised are renamed Phở (`pho`) and Cafe (`cafe`); the old names stay accepted in settings and resumed sessions, and `alp upgrade` renames them. Paseo shows only the two profiles in its model picker and no Workflow setting. Main runs on Opus 5.5 with high effort; Paseo cannot change that, while `runtime.model` in settings or `alp run --model` still can. Main has full access by default (Claude `bypassPermissions`, Codex `danger-full-access`); children never exceed their requester. Oracle runs on Fable or Astra, and main may consult both at once for two opinions. In both profiles main's runtime starts a supervisor on Sonnet 4.6. It reviews main's process after each turn and asks main about mistakes; main answers and records lessons for this project or for every project, and later sessions follow them. Skills and their assignment to roles move from each project to the user's library in `~/.alp`. It is seeded on first install as the current set, and app updates never overwrite what the user changed. Details: [alpd §19](ALPD.md).

## D17 — Main turns lessons into skills and raises issues, with the user's approval

Decided by the user on 2026-10-09. When lessons pile up on one theme or recur, the supervisor suggests and main proposes a skill distilled from them, scoped to the roles it guides: main itself, lead, peer, oracle, reviewer, the supervisor, or a custom agent. Approved skills go to the user's library (D16) and replace the lessons they absorb. Main also searches, comments on and opens GitHub issues, both of the project it works on and of ALP itself, when a problem outside the task is worth tracking. Every skill and every post waits for the user's approval of the full draft; ALP enforces this in the tool, not only in instructions. Details: [alpd §19](ALPD.md).

## D18 — A task graph in the project, changed only by the user and main

Decided by the user on 2026-10-09, after reviewing [beads](https://github.com/gastownhall/beads). This resumes the task channel that D15 left for later. ALP keeps its own task graph built on beads' model rather than running beads. The model covers hash ids, types, priorities 0–4, blocking and parent relations, a computed ready list, and an atomic start. Tasks are stored in the project as `.alp/tasks/<id>.json`, one file per task, so they are committed with the code. Only the user and main create or change tasks. Other agents read them and report work they find to their requester, who records it.

The user also accepted these proposals:
- Ids are `t-` plus a short hash (`t-a3f8`), with numbered children (`t-a3f8.1`).
- A finished handoff moves a task to a separate `review` status until main accepts it.
- Main creates tasks without asking the user. The supervisor watches how it does this.
- Delegating a task that lists paths claims them on the board.

The work runs in four steps, one PR each:
1. Model, storage, `alp_task` and the CLI.
2. Linking tasks to delegation, handoff, board claims, main's turn context, the supervisor, and Paseo `todo` items.
3. A Paseo panel, gates and compaction.
4. Optional beads import/export and formulas.

Details: [alpd §20](ALPD.md).

For step 3 the user raised the Paseo requirement to `>=0.11.1 <0.12.0` on 2026-10-09. The Tasks panel uses the plugin client API that the spike verified on 0.11.1. Details: [alpd §22](ALPD.md).

Step 4 adds beads JSONL import and export and formulas. TOML formulas use `smol-toml`, ALP's first runtime dependency besides the Claude SDK. The core stays free of packages: the CLI and the runtime pass the parser in. Details: [alpd §23](ALPD.md).

## D19 — Permission profiles instead of fixed read-only agents

Decided by the user on 2026-10-09. A read-only reviewer could not run tests. Claude refused Bash, and Codex's read-only sandbox refused every write, even to the temp directory. Instead of a fixed list of read-only agents, settings give agents permission profiles. A profile has a base mode that caps the agent, and allow, ask and deny rules in Claude Code's syntax for both runtimes. Profiles come from the project's `.alp/settings.json` and the user's `$ALP_HOME/settings.json`; deny wins. Without settings, behavior is unchanged. Only the user answers an `ask`: once, always (written to settings), or no. Main cannot grant permissions.

The work runs in three steps, one PR each:
1. Profiles and allow/deny rules, replacing the fixed list.
2. `ask`, answered by the user.
3. The OS sandbox as a floor (Claude's SDK sandbox, Codex's writable roots and network) and a disposable copy of the tree, so a reviewer can build and test without touching it.

Details: [alpd §24](ALPD.md).

