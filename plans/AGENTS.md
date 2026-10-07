# Codex Instructions for Implementing ALP

You are implementing ALP according to this repository-local execution plan.

## Progressive-disclosure rule

Do not read every planning file up front.

1. Read `PLAN.md`.
2. Read `reference/DECISIONS.md` once before changing architecture.
3. Open only the current phase file from `phases/`.
4. Open `reference/TARGET_LAYOUT.md` or `reference/IR.md` only when the current phase explicitly requires them.
5. Do not preload future phase files.

Keep the active context focused on the current phase, code touched by that phase, and directly required references.

## Execution behavior

- Work phase by phase.
- Before editing, inspect the existing repository and preserve compatible structure.
- Prefer the smallest implementation satisfying the current phase acceptance criteria.
- Do not implement future-phase abstractions early unless they are strictly required to avoid rework.
- The user-authorized starter contains `main`, `lead`, and `peer`. Keep role instructions in templates and delegation routes in project configuration; do not hard-code these names in core resolution or runtime authorization.
- Do not couple ALP core types to Paseo, Claude, Codex, or ACP.
- Keep provider/runtime-specific behavior behind adapters.
- Add tests for parsing, resolution, precedence, and adapter boundaries as soon as those concepts appear.
- At the end of each phase, report: files changed, tests run, acceptance criteria status, and any blocker.

## Stop condition

After completing the current phase, stop and wait for the user to request the next phase unless explicitly instructed to continue through multiple phases.
