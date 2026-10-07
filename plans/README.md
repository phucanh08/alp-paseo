# ALP — Codex CLI Progressive Plan

This package is a progressive-disclosure implementation plan for building ALP with Codex CLI.

## Start

From the target repository root:

```bash
codex
```

Then give Codex this instruction:

```text
Read AGENTS.md first. Follow PLAN.md progressively. Start only with Phase 0. Do not preload later phase files unless the current phase explicitly asks for them.
```

## Core decisions

- `ALP.md` is the project-level instruction file.
- `.alp/settings.json` is ALP project configuration.
- Core ships only one agent: `main`.
- Each agent is self-contained under `.alp/agents/<name>/`.
- Each agent owns its own `AGENT.md`, `skills/`, `hooks/`, and `.mcp.json`.
- Other agents are user-defined; ALP core must not hard-code `lead`, `reviewer`, `researcher`, etc.
- Paseo plugin/runtime integration comes before building a standalone ALP ACP implementation.
- ALP core must not depend on Paseo-specific types.
- Claude/Codex/Paseo/ACP are adapters/runtime integrations around a provider-neutral ALP core.

## Package layout

- `AGENTS.md` — instructions for Codex itself.
- `PLAN.md` — short roadmap and phase index.
- `phases/` — implementation phases; open one at a time.
- `reference/DECISIONS.md` — stable architectural decisions.
- `reference/TARGET_LAYOUT.md` — target filesystem layout.
- `reference/IR.md` — draft ALP internal representation.
