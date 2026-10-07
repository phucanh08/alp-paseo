# Phase 9 — Standalone ALP ACP Surface

## Objective

Expose ALP through ACP only after ALP semantics are stable.

## Tasks

1. Implement ACP as an adapter/transport around ALP core and session model.
2. Do not replace `.alp` canonical configuration with ACP-specific config.
3. Map ALP capabilities to ACP and explicitly mark unsupported/emulated behavior.
4. Allow external ACP clients such as Paseo-compatible clients to launch/control ALP.
5. Keep native Claude/Codex adapters available for features ACP cannot represent faithfully.

## Acceptance criteria

An ACP client can open an ALP-backed session and use the stable subset without changing the canonical project structure or ALP core semantics.
