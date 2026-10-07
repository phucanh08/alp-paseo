# Phase 1 — Core Project Layout

## Objective

Implement the minimal ALP filesystem contract and `alp init` behavior.

Amended by the user's 2026-10-07 request: scaffold main, lead, and peer, with main as
active supervisor. Real Paseo execution is covered by `../TEAM_UPDATE.md`.

## Read

- `reference/TARGET_LAYOUT.md`

## Tasks

1. Add an `alp init` command or equivalent project initializer.
2. It must create only:

```text
ALP.md
.alp/settings.json
.alp/agents/main/AGENT.md
.alp/agents/main/skills/
.alp/agents/main/hooks/
.alp/agents/main/.mcp.json
.alp/agents/lead/AGENT.md
.alp/agents/lead/skills/
.alp/agents/lead/hooks/
.alp/agents/lead/.mcp.json
.alp/agents/peer/AGENT.md
.alp/agents/peer/skills/
.alp/agents/peer/hooks/
.alp/agents/peer/.mcp.json
```

3. Initial settings should remain minimal:

```json
{
  "defaultAgent": "main",
  "delegation": { "main": ["lead"], "lead": ["peer"] }
}
```

4. Scaffold only the requested `main`, `lead`, and `peer` starter. No additional named role library.
5. Make initialization idempotent or fail safely without overwriting user content.
6. Add tests for a clean directory and a partially initialized directory.
7. As subsequently requested by the user, populate each starter's `skills/` using
   `templates/role-skills.json`, including the selected skill's relative references.

## Acceptance criteria

- A new project gets exactly three starter agents: `main`, `lead`, and `peer`.
- Existing files are not silently overwritten.
- Generated JSON is valid.
- Empty `skills/` and `hooks/` remain valid for custom agents; starter skills are now populated.
- `.mcp.json` has a valid minimal shape chosen by the implementation and documented by tests.

## Stop

Stop after Phase 1 tests pass.
