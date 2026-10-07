---
name: bug-loop
description: Diagnose a bug or regression through a reproducible feedback loop, competing explanations, and verified correction. Use for failing tests, incorrect behavior, or performance regressions; read-only assignments stop before modifying project artifacts.
---

# Establish a failing loop, then fix the cause

Start from the reported behavior and the assigned scope. Find the smallest useful
command, request, replay, or test that distinguishes the bug from correct behavior.
Run it and record the actual result before claiming reproduction. For intermittent
failures, record conditions, seed when applicable, and observed failure frequency.

If reproduction needs unavailable credentials, hardware, data, or a user action,
report the specific gap to the assigning agent; main handles user communication.
Continue useful in-scope investigation, but label an unconfirmed hypothesis as such.
Do not claim a fix was verified without a meaningful observable check.

Reduce the reproducer without removing the failure. Form competing explanations
where the cause is uncertain, each with an observable prediction. Probe the few
points that distinguish them; change one variable at a time. Prefer measured
evidence over accumulating workarounds for the same unexplained symptom.

Use isolated scratch space for disposable experiments. A read-only assignment can
inspect and diagnose; it does not authorize instrumentation edits to project code.
For performance work, compare equivalent workloads and record relevant conditions
so that a timing difference is not mistaken for a causal improvement.

Once a cause is established and writing is authorized:

1. Put a regression check at the seam that reproduces the actual failure.
2. Confirm that the check fails for the reported reason on the broken behavior.
3. Make the smallest correction consistent with the intended contract.
4. Run the check again, then relevant surrounding checks and the original scenario.
5. Remove temporary instrumentation and restore any deliberate fault injection.

Read [test proof](references/test-proof.md) when designing/reviewing the regression
test or when it passes before the fix. Do not weaken expectations, skip failing
checks, or mock away the behavior to manufacture a pass. A changed requirement must
be established independently of what the implementation currently returns.

Return the reproduction command and result, established cause or remaining
hypotheses, changed artifacts, before/after checks, limits, and unresolved risks.
A peer returns to lead; lead returns to main. Read-only investigation returns
diagnostic evidence and a proposed correction, not an imaginary code change.
