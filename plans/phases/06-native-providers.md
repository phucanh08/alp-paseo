# Phase 6 — Claude and Codex Native Adapter Experiments

## Objective

Prove ALP can preserve native harness behavior instead of reducing everything to ACP.

## Tasks

1. Implement an experimental Claude adapter.
2. Implement an experimental Codex adapter.
3. For each adapter, determine how to map:
   - project instructions;
   - agent instructions;
   - skills;
   - hooks;
   - MCP;
   - model/reasoning;
   - working directory;
   - persistence/resume.
4. Keep generated/provider-specific runtime artifacts outside canonical `.alp` data where possible.
5. Produce a capability matrix for Claude vs Codex.

## Acceptance criteria

The same `ResolvedAgent` launches through both adapters with no change to canonical ALP project files.
