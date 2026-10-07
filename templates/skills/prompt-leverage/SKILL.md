---
name: prompt-leverage
description: Convert a task into a self-contained delegation brief without changing user intent or predetermining the solution. Use before Main assigns Lead or Lead assigns Peer, or when asked to improve an execution prompt.
---

# Prepare an actionable brief

Identify the requested result and the recipient's responsibility. Preserve actual
user constraints, but distinguish them from current design choices the recipient
may question. Do not seed a reviewer's verdict or turn a preferred implementation
into an invented requirement.

A useful brief supplies the root, outcome, relevant context, owned/excluded paths,
authority, important dependencies, resources, verification, and expected handoff.
Use [the brief format](references/brief-template.md) for substantial assignments;
combine fields for a small task. A real base SHA is useful in a Git repository but
is not required for a plain file project. Never fabricate one.

Verification must describe the observable behavior and, when known, its executable
check. If a command still needs discovery, state how it should be established from
the repository. Do not invent a test command just to fill a field.

Choose the relevant installed skill by task type and mention it in the brief:
research -> xia; diagnosis/regression -> bug-loop; an authorized commit handoff ->
smart-commits. Do not require skills absent from the recipient's package. A reviewer
can inspect an existing candidate without additional skill ceremonies.

On current Paseo, pass the full brief as alp_delegate.task with an authorized agent
and optional mode. Model and reasoning inherit from the parent; there is no model
argument on this tool. Request read-only for research/review where appropriate.
Implementation requires workspace-write on the parent and child. The call waits
for a final handoff, so include everything needed to work without a live Q&A channel.

This skill grants no new authority and never bypasses the configured routing graph.
If asked only to improve a prompt, return the prompt. If assignment is authorized,
send it using the actual runtime tool after preparing it. Missing capabilities
must be reported, not simulated.
