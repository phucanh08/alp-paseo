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

