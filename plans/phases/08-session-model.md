# Phase 8 — Session/Event Model Stabilization

## Objective

Extract the stable ALP runtime semantics learned from Paseo and native adapters.

## Tasks

1. Identify the smallest ALP-owned session concepts required across runtimes.
2. Define provider-neutral events only after observing real Claude/Codex/Paseo behavior.
3. Cover create/open, prompt, turn lifecycle, cancel, persistence/resume, usage, permissions, and child-session relationships only when evidence requires them.
4. Avoid copying ACP or Paseo schemas wholesale.
5. Keep capability negotiation explicit.

## Acceptance criteria

Paseo and at least one non-Paseo adapter can map to the same ALP session/event model without losing essential lifecycle information.
