# Phase 7 — User-Defined Agents

## Objective

Make custom agents a first-class user feature while keeping core role-agnostic.

## Tasks

1. Add `alp agent list` from filesystem discovery.
2. Add `alp agent create <name>` as a neutral scaffold only.
3. Optionally add `alp agent validate <name>`.
4. Never generate role-specific content beyond a minimal generic `AGENT.md` unless the user requests a template.
5. Support setting `defaultAgent` to any discovered agent.

## Acceptance criteria

Adding an agent folder is sufficient for discovery; no source-code changes or registry edits are required.
