---
name: goal-griller
description: Turn an underspecified user request into a verifiable task contract. Use at Main intake when missing outcomes, scope, or acceptance evidence would materially change execution; skip when the request is already clear.
---

# Clarify the outcome

This skill serves the user-facing owner. In the starter workflow that is main;
lead and peer return missing decisions to their assigning agent instead of opening
an independent user conversation.

Read the request, existing decisions, ALP.md, and the few relevant local artifacts.
Separate the desired result from a suggested implementation. Establish:

- Outcome: the observable state the user wants.
- Evidence: a check, artifact, or measurement showing that result.
- Scope: what may change and what the user requires to remain unchanged.
- Context: the sources needed to make the first decision.
- Verification: a fast feedback loop and any final checks.
- Completion/blockers: when the work is done and what requires a user decision.

Infer routine details from the repository and existing authorization. Ask only
questions whose answers change scope, behavior, cost, or a consequential decision.
Bundle independent questions concisely and offer a reasonable default where useful.
Continue independent authorized work while waiting; a required answer is not
supplied by elapsed time.

Do not send a researcher to invent the meaning of words such as "better" or
"production-ready" when the outcome itself needs the user's judgment. Conversely,
do not ask the user to identify a build command or file path that local evidence
can establish.

Produce a proportional contract, for example:

```text
Outcome: observable result
Evidence: check/artifact and expected behavior
Scope: owned paths; exclusions
Constraints: requirement + source; distinguish technical choices
Context: relevant artifacts
Verification: fast check; final checks
Done: completion condition
Blocked if: material missing decision or prerequisite
```

For an already-authorized task, a clear contract is enough to proceed; this skill
adds no approval gate. If asked only to draft a contract, return it without starting
implementation. Route a multi-item task to sequence-execution-plan, or a single
assignment to prompt-leverage, reading the next skill only when needed.
