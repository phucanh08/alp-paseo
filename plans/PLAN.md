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
| 9 | Standalone ALP ACP implementation — D30 step 1, `alp acp` | `phases/09-acp.md`, `reference/ALPD.md` §60 |
| 10 | Native `alpd` daemon (D12): runtime extraction, daemon + CLI, persistence | `reference/ALPD.md` §11 |
| 11 | Gas City hardening (D21): crash resilience, hardening, then the next seven | `reference/DECISIONS.md` D21, `reference/ALPD.md` §31 and after |
| 12 | Later, on demand (D21): event journal, orders, retries, review quorum, reload, PR monitor, mail dedupe, D20 leftovers | `phases/12-gascity-later.md` |
| 13 | D23, building: ALP settings in Paseo — teams (Phở and Cafe become teams), agents, skills, MCP, ALP-run hooks, ACP providers | `phases/13-settings-teams-acp.md` |
| 14 | Noted for later: mains of different teams working together | `phases/14-team-of-teams.md` |
| 15 | D30: ALP as an ACP agent (step 1), then a local web app served by alpd (steps 2–3) | `reference/DECISIONS.md` D30, `reference/ALPD.md` §60–§61 |
| 16 | D31: the web app becomes Paseo's app over alpd: build pipeline and protocol core (steps 1–2), agents and timelines (step 3), questions as cards (step 4), "in development" for the rest, history and find in chat (step 5), projects and workspaces (step 6), ALP's panels and the team as subagents (step 7), a checkout's changes and files read-only (step 8), then packaging | `reference/DECISIONS.md` D31, `reference/ALPD.md` §62 |

## Non-goals for early phases

Do not build a marketplace, broad preset role library, distributed scheduler, or custom desktop UI (D30 allows a local web app). The Paseo plugin path is validated (v0.2.0); the native `alpd` daemon is now authorized by D12. The explicitly requested main/lead/peer starter is in scope.

## Authorized team workflow update — 2026-10-07

The user explicitly extended the original Phase 1-only request to include main/lead/peer definitions and real main -> lead -> peer execution on Paseo. Follow `TEAM_UPDATE.md` for this bounded change. This does not authorize preloading or implementing unrelated future phase plans.

## Definition of success for v0

A user can initialize ALP in a project, run the default `main` agent, add another agent by creating a folder, and have the selected runtime resolve the same provider-neutral agent definition without changing ALP core semantics.
