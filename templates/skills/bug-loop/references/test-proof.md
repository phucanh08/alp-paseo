# Evidence for a regression correction

Choose an observable boundary close enough to isolate the failure but broad enough
to exercise its real cause. A unit test of one caller cannot establish a bug that
depends on ordering across several callers.

Expected behavior comes from the user request, a supported contract, or independently
derived examples. Do not calculate the expected result using the implementation
being tested. Mock external boundaries only where doing so leaves the claimed
behavior under test.

Describe proof accurately:

- Green only: the current check passes; this alone does not show regression coverage.
- Red -> green: the check fails on broken behavior and passes after the correction.
- Fault injection: where justified by risk, restore the specific defect in an
  isolated copy, confirm failure, restore the fix, and confirm success again.

Fault injection is optional unless the assignment requires it. Never mutate another
writer's checkout, discard unrelated work, or leave deliberately broken code in the
deliverable. State an unavailable pre-fix run or missing test seam as a limitation.

Keep the actual commands, results, and relevant environment conditions. Screenshots,
logs, and manually observed behavior can supplement tests; do not relabel them as
automated proof. A passing check and an independent acceptance decision are separate.
