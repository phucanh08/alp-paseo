# ALP Implementation Plan

## Goal

Build a small provider-neutral ALP core, integrate it with Paseo first, then stabilize the runtime/session model before adding a standalone ACP surface.

## Roadmap

| Phase | Goal | Read next |
|---|---|---|
| 0 | Repository reconnaissance and baseline | `phases/00-foundation.md` |
| 1 | Project layout + starter agent scaffold | `phases/01-core-layout.md` |
| 2 | Config + agent discovery/resolution | `phases/02-resolver.md` |
| 3 | Internal representation and validation | `phases/03-ir.md` |
| 4 | Provider adapter boundary | `phases/04-adapters.md` |
| 5 | Paseo plugin runtime integration | `phases/05-paseo-plugin.md` |
| 6 | Claude/Codex native adapter experiments | `phases/06-native-providers.md` |
| 7 | Multi-agent/custom-agent support | `phases/07-custom-agents.md` |
| 8 | Session/event model stabilization | `phases/08-session-model.md` |
| 9 | Standalone ALP ACP implementation | `phases/09-acp.md` |
| 10 | Native `alpd` daemon (D12): runtime extraction, daemon + CLI, persistence | `reference/ALPD.md` §11 |

## Non-goals for early phases

Do not build a marketplace, broad preset role library, distributed scheduler, or custom desktop UI. The Paseo plugin path is validated (v0.2.0); the native `alpd` daemon is now authorized by D12. The explicitly requested main/lead/peer starter is in scope.

## Authorized team workflow update — 2026-10-07

The user explicitly extended the original Phase 1-only request to include main/lead/peer definitions and real main -> lead -> peer execution on Paseo. Follow `TEAM_UPDATE.md` for this bounded change. This does not authorize preloading or implementing unrelated future phase plans.

## Definition of success for v0

A user can initialize ALP in a project, run the default `main` agent, add another agent by creating a folder, and have the selected runtime resolve the same provider-neutral agent definition without changing ALP core semantics.
