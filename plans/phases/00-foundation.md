# Phase 0 — Repository Reconnaissance

## Objective

Understand the existing codebase before creating ALP structures.

## Read

- `PLAN.md`
- `reference/DECISIONS.md`

Do not read later phase files yet.

## Tasks

1. Inspect package manager, language, build scripts, tests, CLI entrypoints, and current config conventions.
2. Find any existing references to ALP, Paseo, ACP, Claude, Codex, agents, skills, hooks, or MCP.
3. Identify the smallest package/module where provider-neutral ALP core should live.
4. Record conflicts between existing conventions and `reference/DECISIONS.md`.
5. Do not change architecture yet unless needed to add a minimal test fixture.

## Deliverable

Create `docs/alp/phase-0-findings.md` with:
- repository map relevant to ALP;
- proposed location for ALP core;
- test command(s);
- risks/blockers;
- files likely to change in Phase 1.

## Acceptance criteria

- Existing build/test commands are known.
- ALP integration location is justified.
- No provider-specific design has leaked into core yet.

## Stop

Stop after the report and ask to proceed to Phase 1.
