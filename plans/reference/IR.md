# Draft ALP Internal Representation

This is a direction, not a frozen API. Keep it small until Phase 3.

```ts
export interface ResolvedAgent {
  name: string;
  projectRoot: string;

  instructions: {
    project: string;
    agent: string;
  };

  skills: ResolvedSkill[];
  hooks: ResolvedHook[];
  mcp: ResolvedMcpConfig;

  runtime: {
    provider?: string;
    model?: string;
    reasoning?: string;
  };
}
```

Rules:
- no Paseo/Claude/Codex/ACP types here;
- filesystem paths are resolved before runtime adapters receive the object;
- adapters may produce provider-specific compiled launch material;
- preserve room for future global-agent overlay without requiring it in v0.
