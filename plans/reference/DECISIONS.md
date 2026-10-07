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

## D9 — ACP later

Do not make ACP the canonical ALP config format. Implement standalone ALP ACP only after `ResolvedAgent` and the ALP session/event model are stable.

## D10 — Progressive disclosure

Skills and planning content should be loaded lazily. Avoid injecting all skill bodies and all future planning files into context.

## D11 — Explicit delegation and active supervision

The user authorized real Paseo delegation on 2026-10-07. `.alp/settings.json` may contain a provider-neutral `delegation` adjacency map. The starter maps `main` to `lead`, and `lead` to `peer`; missing configuration disables delegation. This map is authorization for delegation, not an agent registry.

The Paseo adapter owns runtime tool calls and child session lifecycle. It binds sender identity to the active session, validates targets, inherits or narrows permissions, and returns real child results. The first implementation is synchronous and bounded: one child per parent, no delegation cycles, at most four agents in a chain and sixteen child assignments per root turn. Child sessions close on handoff, timeout, parent cancellation, or parent steering.

Main's expanded authority does not elevate sandbox permissions or override user constraints. Authorship and independent review remain distinct. Role instructions are behavioral contracts; the runtime enforces delegation routes and modes, not arbitrary prose ownership rules or per-file access controls.
