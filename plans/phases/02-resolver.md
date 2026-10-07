# Phase 2 — Config, Discovery, and Resolution

## Objective

Resolve an agent from project files without any provider/runtime dependency.

## Tasks

1. Parse `.alp/settings.json`.
2. Discover agents by scanning `.alp/agents/*/`.
3. Resolve the selected agent using:
   - explicit CLI agent if supplied;
   - otherwise `defaultAgent`;
   - otherwise `main` as safe default if policy permits.
4. Read `ALP.md` as project instructions.
5. Read `<agent>/AGENT.md` as agent instructions.
6. Discover that agent's `skills/`, `hooks/`, and `.mcp.json`.
7. Return a provider-neutral object; do not launch anything yet.
8. Give precise errors for missing selected agent, malformed settings, and malformed MCP JSON.

## Important

Do not load full skill bodies unless required for metadata discovery. Preserve the progressive-disclosure direction.

## Tests

Cover:
- default `main`;
- explicit custom agent;
- missing agent;
- malformed settings;
- missing optional directories/files where allowed;
- multiple custom agents discovered from filesystem.

## Acceptance criteria

Agent discovery works without central registration and without provider-specific imports.
