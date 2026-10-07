# Phase 5 — Paseo Plugin Integration

## Objective

Use Paseo as the first runtime host without forking Paseo.

## Tasks

1. Create an ALP Paseo plugin package using Paseo's public plugin SDK.
2. Start with server-side functionality; UI is optional.
3. Register a provider directly with `ProviderRegistration` when native control is needed.
4. Use `runAcpProvider()` only for agents that already speak ACP.
5. Map Paseo session-open data to ALP adapter inputs without leaking Paseo types into ALP core.
6. Validate:
   - cwd;
   - system/project instructions;
   - agent instructions;
   - environment;
   - MCP servers;
   - model/mode/thinking selection;
   - persistence;
   - steering/cancel where supported.
7. Keep a compatibility wrapper around Paseo SDK imports because the plugin API is evolving.

## Prototype acceptance criteria

- Paseo can discover/select the ALP provider.
- A session can be created in a real project.
- The ALP resolver selects `main` by default.
- The effective instructions contain both `ALP.md` and `main/AGENT.md` semantics.
- A custom agent folder can be selected without changing ALP core code.
- Session close/reload does not corrupt ALP project files.

## Fork decision gate

Do not fork Paseo unless a concrete blocker remains after trying the public plugin/provider APIs. Record the exact missing extension point before proposing a fork.
