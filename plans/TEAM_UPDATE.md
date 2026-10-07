# Active supervisor and Paseo delegation

User request, 2026-10-07: adapt the responsibilities from phucanh08/alp-claude;
make main the primary user-facing owner with execution authority; add lead and peer;
implement actual delegation on Paseo now.

Sequential scope:

1. Read the reference role definitions and current scaffold/runtime boundaries.
2. Add editable provider-neutral role templates; update starter and preserve custom files.
3. Add configured delegation routes and validation without a fixed core role enum.
4. Implement adapter-owned child execution and results through the actual runtime tool protocol.
5. Verify routing, mode inheritance, duplicate calls, failure/timeout/cancellation, and migration.
6. Run real read-only and workspace-write workflows through the isolated Paseo daemon.
7. Document usage, evidence, and implementation limits.

Acceptance: only main needs user interaction for normal tasks; main can delegate to lead,
lead can delegate to peer, and real evidence returns to main. Child sessions must be
visible to Paseo. Incorrect routes and permission escalation fail; interruption releases
descendants. Existing project instructions/settings are preserved unless the explicit
upgrade recognizes the original starter, in which case it saves a backup before updating.

This change does not implement a distributed scheduler, arbitrary asynchronous mailboxes,
durable resumption of active child trees, or provider-independent process isolation.

Completed: all seven steps above. Validation: 51 automated tests, TypeScript check,
and real read-only/write E2E on the isolated Paseo daemon passed. Evidence and
implementation limits are recorded in `../docs/alp/team-results.md`. No remaining
blocker within this scope; unrelated roadmap work remains unstarted by this update.

## Follow-up: role skills

The user subsequently requested the skills for these roles. Scope: adapt the seven
alp-claude workflow methods to active main and the current synchronous runtime;
assign main seven, lead six (no user intake), and peer four; install portable local
skill packages; migrate known shipped role definitions with backups while preserving
custom content. Keep bodies/references lazy. Verify installation, migration, resource
links, and adapter loading. See `../docs/alp/role-skills.md` for the exact mapping.

Completed: seven skills passed the skill-creator validator; 56/56 automated tests,
the Paseo build, and TypeScript check passed. The existing `.alp-test/manual-phase1`
project was upgraded with backups and its resolved role skill lists were verified.
This follow-up did not rerun real-model E2E; lazy skill exposure was checked through
the actual Paseo adapter. No blocker remains in the requested skill-installation scope.

The user subsequently removed the router skill because skills are already scoped
per agent. The active starter now has six methods: main gets six, lead five, peer
three. Retire the shipped router from existing projects with a backup and update
known role instructions; preserve customized files and report them for review.
