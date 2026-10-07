# Phase 4 — Runtime/Provider Adapter Boundary

## Objective

Define an integration seam around ALP core before connecting Paseo.

## Tasks

1. Introduce a small adapter interface, for example:

```ts
interface AlpRuntimeAdapter {
  id: string;
  capabilities(): AdapterCapabilities;
  compile(agent: ResolvedAgent): Promise<CompiledAgent>;
}
```

2. Keep session lifecycle out of the interface until required by Paseo integration.
3. Implement a fake/test adapter.
4. Verify core tests run without Paseo installed.
5. Document capability values as `native | emulated | unsupported` where a capability matrix becomes necessary.

## Acceptance criteria

- Core does not import Paseo.
- Adapter code depends on core, not the reverse.
- A fake adapter can compile `main` and a custom agent.
