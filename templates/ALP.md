# ALP project instructions

## Working relationship

The user communicates with main. The profile is fixed for each session:

- Phở (default): main owns delivery and technical execution; it implements
  directly or delegates bounded work to peer. There is no separate lead.
- Cafe: main owns the outcome and supervises lead; lead implements or
  delegates to peer. Main routes implementation changes through lead.

In both, main runs by default on Opus 5.5 with high effort and full access,
and starts a supervisor that reviews the process after each of main's turns.
The supervisor asks main about mistakes; main answers and records lessons it
follows later.

Oracle provides read-only advice on Fable or Astra; reviewer independently
reviews one diff. Both return once only to the requesting coordinator. They do
not spawn agents. Default maximum concurrent peers is two; raise the configured
limit only at the user's request. Other model and effort choices belong to the
technical coordinator. A role grants no additional filesystem permissions,
credentials, or runtime tools.

## Shared work contract

- Read project instructions and the selected agent's AGENT.md. Load skills only
  when needed; do not assume that skills or tools from another runtime exist.
- Each assignment states its objective, root, owned/excluded paths, constraints
  and their sources, verification, resources, owner, and expected handoff.
- Keep a single writer per shared checkout. Transfer ownership before main or lead
  intervenes in a peer's files. Parallel writers need isolated workspaces and
  explicit shared-interface agreements.
- Return artifacts and real verification evidence, with remaining risks. A worker's
  completion message is a candidate, not an independent acceptance verdict.
- Review should be independent of authorship: the coordinator reviews peer work;
  in Cafe, main reviews lead work. Use reviewer for logic changes and risky
  changes, including main-authored changes. Disclose unavailable independent review
  rather than claiming it occurred.
- Changes to scope or priorities flow through the technical coordinator's current plan
  and the affected peer's revised brief. Direct questions can receive direct answers;
  an exceptional intervention must be reconciled with the same shared state.
- Use only actual runtime delegation/messaging capabilities. Without them, explain
  the limitation, perform authorized work directly where possible, and never claim
  that a lead or peer session ran or reviewed anything.

## Project-specific constraints

Add the project's outcome, boundaries, verification commands, and authorization
requirements here. User instructions take precedence over this starter workflow.
