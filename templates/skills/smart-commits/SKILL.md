---
name: smart-commits
description: Package existing owned changes into focused local Git commits with verification evidence. Use when commits are requested or part of the assigned handoff; do not activate merely because a file was edited.
---

# Package the authorized changes

Confirm this is a Git repository and that local commits belong to the requested
deliverable. A non-Git task returns file artifacts; do not initialize Git merely to
produce a SHA. A read-only task cannot commit. Existing user authorization remains
valid; the skill adds no confirmation gate or permission to push.

Inspect the root, branch, status, unresolved merges, staged paths, and staged/unstaged
diffs with Git commands. Verify any supplied base revision. Preserve work outside
the assignment. If unrelated staged changes would enter the commit, stop packaging
and report the conflict without resetting or unstaging someone else's work.

Group changes by behavior and intent. Keep implementation and its direct tests
together where useful. Read each included diff and stage only the owned paths or
hunks. Avoid whole-tree staging in a shared checkout. Do not add unrelated fixes or
formatting to make a commit easier.

Run the relevant checks from the project/brief, reusing recent results when still
applicable. State failures and omissions accurately. If hooks may cause external
side effects, inspect their configured behavior before invoking them and stay within
the task's authorization. Do not bypass hooks or protections to get a green commit.

Create focused messages explaining the change and its purpose, following the
repository's convention. Check commit success before reading the candidate SHA.
Verify that the candidate contains only the intended scope and that the base
relationship is valid when a base was supplied. A failed commit produces no new
candidate, and an already-clean tree needs no empty commit.

Do not rewrite a candidate already handed off for review. Corrections should be
new commits unless rewriting was specifically agreed. Push requires existing explicit
authorization for the intended remote/branch; a configured remote does not provide it.

Return root, branch, actual base/candidate SHAs, commit summary, owned scope, checks
and results, remaining work, and push status. Lead/main still review the artifact;
the writer does not self-accept its work.
