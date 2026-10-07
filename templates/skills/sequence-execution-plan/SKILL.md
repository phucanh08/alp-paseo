---
name: sequence-execution-plan
description: Order multiple ALP work items by real dependencies, verification, and writer ownership. Use when Main or Lead coordinates several outcomes or must replan after a blocker, changed premise, or rejection.
---

# Order executable work

Use the task contract and available evidence. Planning authority comes from the
current assignment: main coordinates the overall outcome; lead plans technical
execution within its assigned scope. A peer reports dependencies instead of
reassigning ownership or widening the plan.

Separate urgency from dependency order. A lower-priority prerequisite may need to
run first, but it does not close the higher-priority outcome. A mitigation reduces
current impact; it is not proof of a durable fix.

Build small work items that each deliver observable progress. Keep implementation
and its direct verification together. Split when an unresolved decision blocks one
part, separate outcomes need independent acceptance, or a resource/human wait would
stall unrelated work. Do not impose a fixed task count on a simple change.

For each item identify the result, owner, owned/excluded paths, true prerequisites,
verification seam, completion evidence, and current state. Distinguish necessary
foundations from optional improvements and speculative future abstractions.

Arrange Now, Next, and Later using causal explanations: which prerequisite blocks
which outcome, which check validates it, and which decision opens the next branch.
Read [the plan format](references/plan-template.md) when a durable multi-item plan
helps. Use the project's existing plan location; do not create unrelated ignore
rules or a new planning hierarchy just to satisfy this skill.

Current Paseo delegation is sequential: each parent waits for one child's result.
Do not promise parallel workers or live upstream mailboxes. A shared checkout has
one writer at a time; main intervention requires ownership to be released first.
Allocate ports, scratch paths, and other exclusive resources if the assignment uses
them. Separate worktrees alone do not isolate ports or a shared database.

Replan when evidence changes a premise, a dependency blocks work, the user changes
scope, or repeated rejection reveals that the assignment needs restructuring.
Update the facts and constraints before issuing a revised brief. Preserve unfinished
acceptance criteria when merging items. Candidate remains candidate until the
responsible reviewer has evaluated the actual evidence.
