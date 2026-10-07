# Target Project Layout

```text
my-project/
│
├── ALP.md
│
├── .alp/
│   ├── settings.json
│   │
│   └── agents/
│       ├── main/
│       │   ├── AGENT.md
│       │   ├── skills/
│       │   ├── hooks/
│       │   └── .mcp.json
│       ├── lead/                 # same package layout
│       └── peer/                 # same package layout
│
├── src/
└── ...
```

After users add agents:

```text
.alp/agents/
├── main/
├── lead/
├── peer/
├── android-expert/
└── reviewer/
```

Main, lead, and peer are editable starter packages. Delegation edges live in
settings.json; core discovery does not attach hidden semantics to agent names.
