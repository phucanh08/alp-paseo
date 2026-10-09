# Phase 12 — Gas City ideas kept for later (D21)

These come from the Gas City review of 2026-10-09 (`gastownhall/gascity` at `ad1f07c`). None is scheduled.

Build one only when its trigger shows up in real use, and then propose it to the user first. Each entry gives:
- what Gas City does, and where to read it;
- what ALP has today;
- the smallest ALP version.

Paths are in the Gas City repository.

## D1. Global event journal

- **Trigger:** a dashboard, or automation that reacts to events, needs one stream across sessions.
- **Gas City:** one append-only JSONL file with a strictly increasing `seq`.
  - Clients follow from a cursor.
  - Rotated files carry their seq range in the file name, and an `events.rotated` anchor starts the new file.
  - The latest seq doubles as the index for blocking queries.
  - Sources: `internal/events`, `internal/api/blocking.go`.
- **ALP today:** a timeline per tree and a run log per root.
- **Smallest version:** `$ALP_HOME/events.jsonl` with `seq`, and `alp events --follow --after N`.

## D2. Orders: formulas on a schedule

- **Trigger:** recurring work, such as a nightly cleanup or a periodic PR check.
- **Gas City:** triggers are cooldown, cron, condition, event or manual.
  - A tracking bead is written before dispatch, so an order never runs twice at once.
  - A missed cron run is made up later.
  - A condition check that cannot run fails closed.
  - Sources: `internal/orders`, `cmd/gc/order_dispatch.go`.
- **ALP today:** `timer` gates on tasks.
- **Smallest version:** `.alp/orders/<name>.toml` pours a formula on a cron or condition. alpd checks the orders on its watchdog tick, with a task as the lock.

## D3. Transient retries for formula steps

- **Trigger:** steps that fail on network errors or flaky tests.
- **Gas City:** one stable logical bead plus one bead per attempt.
  - The worker reports `failure_class` as `transient` or `hard`.
  - A crash before the worker reports does not use up an attempt.
  - Sources: `engdocs/design/formula-v2-transient-retries.md`, `internal/dispatch/retry.go`.
- **ALP today:** main decides whether to delegate again.
- **Smallest version:** `retry = { max, onExhausted }` on a step, and `failureClass` in the handoff.

## D4. Review quorum

- **Trigger:** large changes where two reviewers on different models are worth the cost.
- **Gas City:** two read-only lanes, reduced to one verdict:
  - any hard failure → fail;
  - any transient failure → blocked;
  - any findings → pass with findings.
  - Read-only is checked by `git status` before and after.
  - Sources: `internal/reviewquorum`, `mol-review-quorum.toml`.
- **ALP today:** one reviewer per assignment.
- **Smallest version:** run two reviewers and reduce their verdicts with the same rules. This builds on C7's verdict format.

## D5. Settings reload

- **Trigger:** `$ALP_HOME/settings.json` changes often.
- **Gas City:** `gc reload` returns `applied`, `no_change`, `failed`, `busy` or `timeout`. A config that fails to load leaves the old one in place. Source: `engdocs/design/gc-reload-design.md`.
- **ALP today:** `limits` and `recovery` are read when alpd starts.
- **Smallest version:** `alp daemon reload`, and SIGHUP.

## D6. PR monitor with head-SHA dedupe

- **Trigger:** `gh:pr` gates where CI keeps failing and repair work repeats.
- **Gas City:** classifies each PR as failed, conflicted, behind, blocked, pending or clean.
  - Creates one repair bead per owner, repo, PR and head SHA.
  - Refreshes an open repair bead instead of creating another.
  - Sources: `internal/githubmonitor`, `cmd/gc/cmd_github.go`.
- **ALP today:** `gh:pr` and `gh:run` gates wait.
- **Smallest version:** a failed run on a gated PR creates one repair task per head SHA.

## D7. Mail dedupe keys

- **Trigger:** agents get the same alert many times.
- **Gas City:** `DedupSender` suppresses a message while an identical one is still unread. Source: `internal/mail/mail.go`.
- **ALP today:** every post is a mail.
- **Smallest version:** a `dedupeKey` on mail ALP sends itself.

## D8. Left over from D20 (Gas Town)

- **Integration branch per epic.** Trigger: parallel worktree peers on one epic conflict or depend on each other.
- **Formula overlays.** Trigger: a shared formula needs per-project changes.
- **Per-agent and per-model statistics.** Trigger: choosing between models or agents needs data.
