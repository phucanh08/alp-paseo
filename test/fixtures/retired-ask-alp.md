---
name: ask-alp
description: Select the next ALP workflow skill based on the current role, task state, and actual runtime capabilities. Use when the next step or responsibility is unclear, or when asked which skill to use.
---

# Choose the next ALP skill

Identify your role from the active agent definition and runtime identity, then the
current task state. A skill describes a method; it cannot grant authority, change
the assignment, or make a missing runtime tool available.

## Role responsibilities

| Role | Owns | Reports to |
|---|---|---|
| Main | User intent, overall plan, assignment to lead, decisions in scope, integration and delivery; may also implement | User |
| Lead | Technical execution, decomposition, peer briefs and peer acceptance; may also implement | Main |
| Peer | One bounded implementation, research, design, or review assignment | Lead |

Main is an active supervisor. It can use execution skills; the observer-only
supervisor restrictions from other ALP implementations do not apply here.
Authorship is separate from independent review: lead reviews peer work, main reviews
lead work, and main-authored work should obtain independent review when available.

## Route by need

| Situation | Skill | Available to |
|---|---|---|
| Material uncertainty about the user's desired outcome or proof | goal-griller | Main |
| Unfamiliar code, reuse question, version-sensitive integration | xia | Main, lead, peer |
| Multiple dependent work items or evidence requiring a revised plan | sequence-execution-plan | Main, lead |
| Prepare a self-contained assignment for another agent | prompt-leverage | Main, lead |
| Reproducible bug, unexplained failure, performance regression | bug-loop | Main, lead, peer |
| Package owned changes into local Git commits when requested/assigned | smart-commits | Main, lead, peer with write authority |

Read only the chosen SKILL.md from the current agent's skills directory or the
runtime's advertised skill index. Supporting references are relative to that
skill's folder. Do not load all skills to begin a task. These files are usable
through normal file-reading tools; no native Skill command is required.

## Workflow and exceptions

For a substantial task: establish the outcome, research unknowns, order dependent
work, prepare a brief, execute and verify, then return a candidate for review.
Skip steps that add no information. A clear one-file edit needs no interview or
separate plan document. Commit packaging applies only when a commit is part of the
authorized task; a file artifact is a valid candidate in a non-Git project.

Lead missing a material user decision returns the question to main. Peer missing
scope or authority reports it to lead. Neither starts a separate user interview.
With synchronous delegation, include questions/blockers in the returned handoff;
do not wait for an upstream mailbox that does not exist.

Use only exposed delegation tools and authorized targets. In the current Paseo
adapter, alp_delegate waits for one child's handoff; it accepts agent, task, and
optional mode. Plan sequential work, and inherit or narrow permissions. Do not
invent a model-selection argument, parallel worker API, or persistent child memory.

On a rejected candidate or changed premise, update the affected plan and brief.
Do not call completion, idle state, or passing tests an independent ACCEPT verdict.
