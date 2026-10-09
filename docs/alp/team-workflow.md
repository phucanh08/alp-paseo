# Smart and Supervised workflows

ALP has five filesystem-defined agents: main, lead, peer, oracle, and reviewer.
The workflow is separate from Paseo's read-only/workspace-write permission mode.

| Workflow | Technical coordinator | Execution | Separate supervisor |
| --- | --- | --- | --- |
| Smart (new project default) | main | main or peer | none |
| Supervised | lead | lead or peer | main |

Smart does not spawn lead. Supervised main delegates execution to lead, never
straight to peer. Main and lead can ask oracle or reviewer; these advisors return
once to their requester and cannot delegate. Lead can implement small tasks itself.

Oracle advises on significant uncertainty, architecture, or difficult bugs.
Reviewer reviews one diff for logic changes and risky changes; trivial formatting
or typo changes can skip review. These call decisions are agent instructions, not
an automatic mandatory review gate.

## Select a workflow

New project `.alp/settings.json`:

```json
{
  "defaultAgent": "main",
  "workflow": { "mode": "smart", "maxPeers": 2 }
}
```

Set `workflow.mode` to `supervised` before creating a new session, or override it
for a single session through the public Paseo client:

```js
const agent = await client.agents.create({
  cwd: '/absolute/project',
  config: {
    provider: 'alp/codex:gpt-6.1-sol',
    modeId: 'workspace-write',
    options: { agent: 'main', workflow: 'supervised' },
  },
});
```

The provider also accepts `settings.workflow` in its native `session.open` contract.
Workflow and peer limit are persisted; resume cannot change the workflow, and child
sessions inherit the parent's snapshot. Start a new session for changes. The
session configuration reports the selected workflow; this release does not support
changing it through an in-session settings control. No custom Desktop UI is added.

Default maximum simultaneous peers is **2**. Increase `workflow.maxPeers` only at
the user's request, then start a new session. Peer limits count across the root
session's live tree. Advisors and lead do not consume peer slots. Concurrent peers
must be read-only or isolated.

## Parallel writers

In a git repository, `alp_delegate` with `mode: "workspace-write"` and
`isolation: "worktree"` gives a writing assignment its own git worktree, so several
writing peers can run at once. The worktree starts from the requester's current
state: `HEAD` plus uncommitted changes to tracked files (untracked files are not
copied). The assignment's sandbox can write only inside its worktree.

When it ends, alpd commits its work to the branch `alp/<assignment id>` and the
result lists the branch, the changed files and a diff summary. The requester then
calls `alp_merge` to apply the change to its own checkout, uncommitted, or
`alp_discard` to drop it. A merge applies the patch as is when it fits; otherwise
each file is merged three ways against the requester's current file and conflicts
are left as markers, with the branch kept. A deleted or binary file that conflicts
keeps the requester's version. An assignment without changes leaves nothing behind.

Writers in the shared checkout (the default, `isolation: "shared"`) hold the
checkout's write lease: alpd allows one at a time per checkout across all sessions,
except for assignments nested under the holder. A second session's shared writer
is refused with a hint to wait or use a worktree. Root sessions themselves are not
leased. Work is never deleted silently: changes not merged when their requester
closes stay on their branch, and after a crash alpd commits work left in worktrees
to their branches and removes the directories.

## Talking to the user

The user talks with main. Main asks the user with `alp_ask` (for a root session
the question goes to the user) and waits, up to 30 minutes, without ending its
turn; `options` suggests answers. The question appears in Paseo as a question
prompt, and in `alp run`/`attach`/`send`, `alp questions` and `alp top`;
`alp answer` answers or dismisses it. Main receives `answered` with the answer,
`dismissed`, or `unanswered` on timeout. A question ends with the turn that
asked it.

Other agents do not talk to the user: their questions go to their requester
(`alp_ask` defaults to `to: "parent"`), and `to: "user"` is refused. The user
may write down to a running assignment with `alp send <agent session> <text>`.
The agent receives it as mail sent by `user` and follows it as a user
instruction. ALP immediately tells the agent's requester, as a note from that
agent ("The user wrote to me directly: …"). From then on the agent may also ask
the user with `to: "user"`. Each answer it gets is reported to its requester
the same way, and its handoff must say what the user asked and what it did. The
watchdog does not count the wait for the user as silence.

## Project board

Every agent working on a project shares one board, whether it was started by the
same main or by another `alp run` or Paseo agent. Before changing files an agent
reads the board with `alp_board` and pins a `claim` on the paths it will change
with `alp_pin`. A claim that overlaps one held by an agent outside its own line
of delegation is refused with the holder's name, so the agent leaves those paths
alone and asks its requester. An agent pins a `decision` when it picks an
approach others should follow and a `finding` when it learns something others
need. New pins reach agents whose turns are running as board mail, and every new
assignment starts with a digest of the board. Claims end with their session, or
earlier with `alp_unpin`; decisions and findings stay. `alp board` prints the
board of the current project.

## Observing a tree

`alp top` shows every live tree, refreshed every second: each agent's state
(`running`, `waiting` for assignments or mail, `waiting_parent`, `waiting_user`,
`idle`), idle time, model and mode, worktree, unread mail, open questions,
unmerged worktree changes, write leases and board claims. `alp log <session>`
prints the tree's assignment log: delegations, results with handoffs, mail,
worktree events, board pins, and questions to the user with their answers.

## Assignment and model selection

`alp_delegate` accepts `agent`, `task`, and optional `mode`, `model`, `thinking`,
and `modelReason`. Model IDs are runtime-prefixed (`codex:…` or `claude:…`). Main
chooses peer model/effort in Smart; lead chooses them in Supervised. Omitted peer
choices inherit the parent model/effort; specifying a different model without an
effort uses that model's configured/default effort. Invalid choices fail explicitly.

Oracle requires an explicit model, effort, and nonempty selection rationale. Its
instructions require the highest-capability available model, assessed from runtime
catalog descriptions; there is no fixed premium model name. The host enforces
explicit selection, not a universal model-quality ranking. Catalog data may not
establish a ranking or guarantee quota access; the coordinator must state uncertainty
and must not silently downgrade. There is no automatic fallback model on failure.
Both oracle and reviewer are forced to read-only regardless of parent permissions.

Every assignment has its own native runtime session and ALP instructions. By
default the caller waits for the real handoff, or for the child's first question.
Child timelines identify parent session and tool call. Duplicate tool calls are
deduplicated. Interrupt, inactivity, and parent shutdown close descendants; user
steering reaches the parent and leaves its assignments running. The existing maximum
of 16 child assignments per user turn and ancestry depth of 4 remain in effect.

## Mail between agents

Agents talk only along the delegation tree: a child writes to its requester, and a
requester writes to the assignments it started. Siblings cannot address each other;
the requester relays. The host binds the sender to the calling session.

| Tool | Who | Purpose |
| --- | --- | --- |
| `alp_delegate {…, wait: false}` | requester | Start an assignment and return its `assignmentId` immediately |
| `alp_wait {assignments?, timeoutMs?}` | requester | Return as soon as mail arrives (result, question, note, stall report); on timeout, an empty list and a snapshot of running work. Default 5 minutes, maximum 15 |
| `alp_send {to, kind, body, replyTo?}` | both | `to` is an assignment id or `"parent"`. Requesters send `answer` (with `replyTo`), `steer`, or `note`; children send `note` only |
| `alp_ask {question}` | child | Ask the requester and wait for the answer; after 15 minutes it returns `unanswered` |

Delivery, in order: a waiting `alp_wait` or `alp_delegate` call receives the mail;
otherwise it is steered into the recipient's running turn; otherwise an idle
recipient is woken with a new turn carrying the mail. Interrupt stops wakes until
the next user prompt, which then carries the held mail. At most 8 wakes run per
user prompt, and wakes do not reset the per-turn delegation limit. Steered and wake
batches are capped at 9,000 characters; bodies at 8,000.

Mail is acknowledged only when the turn that received it completes. If that turn
fails or is canceled, the mail is delivered again marked `redelivered`. A requester
whose turn ends while its assignments still run is not finished: it is woken by
their mail and hands off only after a turn ends with nothing outstanding.

An assignment with no activity in its session tree for 10 minutes is reported to its
requester as `stalled`; after 20 minutes it fails. Time spent waiting in `alp_ask`
does not count. Stall reports never wake or steer on their own.

## Structured handoff

Every child session gets an `alp_handoff` tool. Before ending its turn the child
files `outcome` (`complete`, `partial`, `blocked`, or `reconsider`) and `summary`,
plus the evidence lists that apply: `candidate`, `scope`, `verification`, `risks`,
and `ownership`. Calling it again replaces the earlier handoff. Root sessions
cannot file one. Handoffs over 32,000 characters are rejected so the child points
to files instead.

`alp_delegate` returns `handoff` (or `null` when the child filed none) and `output`,
the child's final message. Interim messages stay in the child timeline and are no
longer concatenated into the result.

## Assignment log

The Paseo plugin appends one JSONL file per root session to `~/.alp/runs/`
(override with `ALP_RUN_LOG_DIR`). Each assignment writes an `assignment.started`
record (parent, agent, project, mode, model, thinking, task) and an
`assignment.finished` record (status, runtime, duration, handoff, output, error).
Logs live outside the project so they never dirty the checkout. Logging is best
effort: an unwritable directory never blocks or fails delegation. The files contain
full task briefs and results; delete them as you would other local agent history.

## Catalog and usage context

Before each native turn, the provider adds a timestamped snapshot for that session's
runtime, separately from the user's brief:

- Codex: `model/list` and `account/rateLimits/read`; plan, utilization, remaining
  percentage, reset timestamps, and ordinary-usage permission when supplied.
- Claude: SDK `supportedModels()` and the optional experimental usage API; plan,
  utilization, remaining percentage, and reset timestamps when supplied.

Account identifiers, email, credentials, and billing details are not included.
Reads are bounded and failures produce `available: false`; no quota is invented.
Codex catalog snapshots report whether pagination is complete. These are advisory
snapshots, not reservations or a guarantee that a future call will avoid rate limits.
A parent does not query another provider's account to select a cross-runtime child.
Claude's experimental usage API may be unavailable for some versions/accounts.

## Initialize and migrate

```sh
node src/cli.js init /absolute/project
node src/cli.js upgrade /absolute/existing-project
npm run build
paseo plugin reload alp-provider
```

`init` fills missing files without replacing user content. `upgrade` backs up and
updates recognized shipped instructions, adds oracle/reviewer, and preserves custom
instructions and skills. Projects with the old shipped main → lead → peer graph
migrate to Supervised; older projects without routing migrate to Smart. Explicit
custom graphs remain unchanged and continue using legacy custom routing unless a
workflow is explicitly selected. Existing projects are not silently rewritten on
plugin reload. Reconcile any customized instructions reported by upgrade yourself.

## Live verification

Run the opt-in real-model smoke tests against a running daemon (default loopback
port 6767):

```sh
npm run test:e2e:workflow
ALP_TEST_PROVIDER=alp/claude:sonnet node scripts/workflow-e2e.mjs smart
```

They create isolated fixture directories under ignored `.alp-test/`, inspect actual
child sessions and parent relationships, compare project files before/after, save
local evidence, and archive the test agents. They make real model calls.

Claude read-only uses an explicit read-tool allowlist rather than Plan mode, so
advisors can read and delegate without asking to exit a plan or writing plan files.
Shell and edit tools are denied at the permission gate in these sessions: supply a diff in the review brief
or as a readable artifact when reviewing a Git change. Claude executables are
resolved from PATH (or `ALP_CLAUDE_BIN`) and passed explicitly to the SDK to avoid
trying to execute bundled binaries inside Paseo Desktop's Electron archive.
