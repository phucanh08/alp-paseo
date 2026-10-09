# Phase 14 — Mains of different teams working together (noted, not planned)

**Status:** noted at the user's request on 2026-10-09. Nothing here is designed or scheduled. It builds on phase 13's teams.

## What the user wants later

Each team has a main. Later, the mains of different teams communicate with each other to handle work together. For example, a Cafe team building a feature could ask a review team or a documentation team to take part of the work, and get the result back.

## What already exists to build on

- **Mail** between agents (`alp_send`). Today it follows the delegation tree only: siblings talk through their parent.
- **Project board and tasks**, shared by every tree on a project (D15, D18). A task can already be handed from one tree to another through the task list.
- **`alp_recall`**, to ask a finished assignment about its work (D20).
- **The user rule (D14):** the user talks with main. Under that rule, a second team's main is another "main" the user may talk to.

## Questions to settle before designing it

1. **How mains connect.** Directly, through main-to-main mail (`alp_send to: "team:<id>"`)? Or through a coordinator above the teams? Or only through tasks: one team files a task with a `team:` label, and the other team's main picks it up?
2. **Who starts the other team.** May a main open a session of another team by itself, or only ask the user to?
3. **What the other team returns.** A structured handoff (with a verdict for review teams, C7)? Or a task moved to review, with acceptance staying with the requesting main?
4. **Limits.** The same caps as delegation (maxPeers, pause, usage limits), counted across teams? And how does the supervisor see a conversation between teams?
5. **The user's view.** Paseo shows each team's root. How does the user follow work that crosses teams: one combined thread, or links between roots?

## When to plan it

After phase 13 step 2, once teams exist, and when the user asks.
