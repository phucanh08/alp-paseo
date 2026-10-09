# Phở and Cafe profiles

ALP has six filesystem-defined agents: main, lead, peer, oracle, reviewer, and
supervisor. The profile is separate from the permission mode.

| Profile | Technical coordinator | Execution | Separate supervisor of lead | Process supervisor |
| --- | --- | --- | --- | --- |
| Phở (`pho`, new project default) | main | main or peer | none | supervisor |
| Cafe (`cafe`) | lead | lead or peer | main | supervisor |

Phở does not spawn lead. Cafe main delegates execution to lead, never straight to
peer. Main and lead can ask oracle or reviewer; these advisors return once to
their requester and cannot delegate. Lead can implement small tasks itself. In
both profiles main starts a supervisor that reviews its process (see
[Supervisor and lessons](#supervisor-and-lessons)).

Oracle advises on significant uncertainty, architecture, or difficult bugs.
Reviewer reviews one diff for logic changes and risky changes; trivial formatting
or typo changes can skip review. These call decisions are agent instructions, not
an automatic mandatory review gate.

## Select a profile

In Paseo, the model picker lists only the two profiles, Phở and Cafe, and the
session's config shows no Workflow setting. With `alp run`, pass `--profile pho`
or `--profile cafe` (`--workflow` is the old name of the option). New project
`.alp/settings.json`:

```json
{
  "defaultAgent": "main",
  "workflow": { "mode": "pho", "maxPeers": 2 }
}
```

`workflow.mode` also accepts `smart` and `supervised`, the profiles' names before
0.4; `alp upgrade` renames them. Set `workflow.supervisor` to `false` to start no
supervisor. A project with a custom `delegation` graph and no `workflow` has no
profile and no supervisor. Through the public Paseo client, a profile is the model:

```js
const agent = await client.agents.create({
  cwd: '/absolute/project',
  config: { provider: 'alp/cafe', modeId: 'full-access' },
});
```

The provider still accepts `options.workflow` and `settings.workflow` from older
clients; conflicting selections fail. Profile and peer limit are persisted; resume
cannot change the profile, and child sessions inherit the parent's snapshot. Start
a new session for changes; changing the model, effort, or profile of an open
session is refused.

## Models and permissions

Main runs on `claude:claude-opus-5-5` with `high` effort, unless `.alp/settings.json`
sets `runtime.provider` or `runtime.model`, or the caller passes a model
(`alp run --model`). Paseo never passes a model or effort. Main's mode defaults to
`full-access`: Claude runs with `bypassPermissions`, Codex with the
`danger-full-access` sandbox, so it runs any command, with network access, inside
or outside the project, without asking. The caller can choose `read-only` or
`workspace-write` instead. A child inherits its requester's mode unless it asks for
less, and never exceeds it; oracle, reviewer and supervisor are always read-only.

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

## Tasks

A project's tasks live in `.alp/tasks`, one JSON file per task, and are committed
with the project like source. The model follows
[beads](https://github.com/gastownhall/beads): a short hash id (`t-a3f8`, and
`t-a3f8.1`, `t-a3f8.2` for children), a type (`task`, `bug`, `feature`, `chore`,
`epic`), a priority from 0 (urgent) to 4 (backlog), labels, the paths the work
changes, and relations. Relations live on the dependent task: `blockedBy` lists
tasks that must close first, `parent` groups a task under an epic or larger task,
`discoveredFrom` names the task during which the work was found, and `related`
links loosely. So adding a child or a blocker never edits the other task's file,
and two branches that touch different tasks merge without conflicts.

A task is `open`, `in_progress`, `review` or `closed`. Blocked is not stored: a
task is **ready** when it is open, not an epic, every `blockedBy` task is closed,
and the same holds for its parent and the parent's ancestors. Ready tasks sort by
priority, then age. A link that would make a cycle is refused with the chain, and
a task cannot wait on its own parent or ancestor. Only a ready task can start;
an epic closes as `done` only once its children are closed.

Only the user and main create or change tasks:

| | User (CLI) | main | lead, peer | oracle, reviewer | supervisor |
|---|---|---|---|---|---|
| create, update, link, close, reopen | yes | yes | no | no | no |
| start | — | yes | no | no | no |
| read | all | show, list, ready | show, ready | show | show, list |

Main uses `alp_task` and its instructions tell it to create tasks only for work
that outlives the turn, that the user asks to track, or that it finds outside the
scope; lead and peers list such work under risks in their handoff. The runtime
enforces the table: other roles get `alp_task` with only their actions, and a
refused action says who can change tasks. The supervisor's digest shows every
task main created, started, linked, closed or reopened.

The user works with tasks from the CLI, which writes the files directly and
needs no running daemon:

```sh
alp tasks                        # open, in progress and in review
alp tasks ready                  # what nothing blocks, most urgent first
alp task add "Add --json" -p 1 -t feature --parent t-77e0 --after t-91c2 -l cli
alp task show t-77e0.2
alp task dep add t-c40d --after t-77e0.2      # rm removes; also --parent, --related
alp task close t-77e0.2 -m "Merged in #12"    # --reason wontfix | duplicate | superseded
alp task reopen t-77e0.2 -m "Fails on Windows"
```

Every writer holds the lock directory `.alp/tasks/.lock` while it reads, checks
and writes one task; a lock older than ten seconds is cleared. Each write bumps
the task's `rev` and replaces the file through a temporary file, and a writer
that passes the `rev` it read is refused if the task changed since. A file that
does not parse is reported by name and skipped. `.alp/tasks/.gitignore` keeps the
lock and temporary files out of git.

## Observing a tree

`alp top` shows every live tree, refreshed every second: each agent's state
(`running`, `waiting` for assignments or mail, `waiting_parent`, `waiting_user`,
`idle`), idle time, model and mode, worktree, unread mail, open questions,
unmerged worktree changes, write leases and board claims. `alp log <session>`
prints the tree's assignment log: delegations, results with handoffs, mail,
worktree events, board pins, and questions to the user with their answers.

## Assignment and model selection

`alp_delegate` accepts `agent`, `task`, and optional `mode` (`read-only`,
`workspace-write` or `full-access`), `model`, `thinking`, and `modelReason`. Model IDs
are runtime-prefixed (`codex:…` or `claude:…`). Main chooses peer model/effort in
Phở; lead chooses them in Cafe. Omitted peer choices inherit the parent model/effort;
specifying a different model without an effort uses that model's configured/default
effort. Invalid choices fail explicitly.

Oracle runs on Fable (`claude:claude-fable-5-1`) or Astra (`codex:gpt-6-astra`); any
other model, or none, is refused. Its effort defaults to `high`; `modelReason` is
optional. For two independent opinions, the coordinator starts one oracle on each
model with `wait: false` and compares their advice: oracles, like read-only or
worktree peers, run beside other running assignments. There is no automatic
fallback model on failure. Oracle and reviewer are forced to read-only regardless of
parent permissions.

Every assignment has its own native runtime session and ALP instructions. By
default the caller waits for the real handoff, or for the child's first question.
Child timelines identify parent session and tool call. Duplicate tool calls are
deduplicated. Interrupt, inactivity, and parent shutdown close descendants; user
steering reaches the parent and leaves its assignments running. The existing maximum
of 16 child assignments per user turn and ancestry depth of 4 remain in effect.

## Supervisor and lessons

When a root main session opens in Phở or Cafe, and the host can show child
sessions, the runtime starts its supervisor beside it without delaying main's open.
The supervisor is agent `supervisor` on `claude:claude-sonnet-4-6` with `medium`
effort, always read-only, and has only `alp_send` and `alp_board`. It is a child of
main but not an assignment: it files no handoff, delegates nothing, does not count as
a peer, and survives interrupts of main. A supervisor that fails to start never fails
main. Projects from before 0.4 get its starter files when it first starts. Closing
main closes it; a resumed main starts a new one.

After each of main's turns, ALP sends the supervisor a digest of what happened in the
tree during that turn, oldest first: the user's prompt or steer, main's tool calls and
shell commands with their status, assignments with agent, model, effort, mode,
isolation and task, their results and handoffs, mail between agents, questions to the
user and answers, board pins, worktree events, main's final message, and
how the turn ended. The digest is capped at 12,000 characters. A turn that ends while
the supervisor is still reviewing is sent when that review ends. The tree counts as
busy from the end of main's turn until the review is done, so alpd does not close an
idle tree in between.

The supervisor checks the turn against `ALP.md`, main's `AGENT.md`, the profile and
the recorded lessons. When it finds process mistakes, it sends main one note with
`alp_send` to `parent`. That note is deferred mail: it is never steered into a
running turn or taken by `alp_wait`; it wakes an idle main, or rides on main's next
turn. Main answers in that turn and records the lesson with
`alp_lesson { scope, lesson }`. A turn that only answers supervisor notes is not
reviewed again.

`alp_lesson` is available to a supervised main only. `scope: "project"` appends to
`.alp/lessons.md` in the project; `scope: "user"` to `$ALP_HOME/lessons.md` (only
when the host keeps a user library, as alpd does). A lesson is one rule of at most
600 characters, written as `- <date>: <rule>`. Later sessions load both files into
main's and the supervisor's instructions, the newest 6,000 characters of each. Edit
or delete lessons freely.

## Skills from lessons

When three or more lessons cover one theme, or a lesson recurs, the supervisor
suggests distilling them into a skill, and main proposes one with
`alp_skill { name, description, body, roles, lessons?, replace? }`. Main scopes it to
the roles whose work it guides: itself, `lead`, `peer`, `oracle`, `reviewer`,
`supervisor`, or a custom agent of the project; an unknown role is refused. `lessons`
lists the exact text of the lessons the skill replaces.

ALP asks the user before saving anything: the question shows the target file, the
roles, the lessons that move, and the whole `SKILL.md`, with the answers Approve and
Reject. Only an approving answer (`Approve`, `yes`, `ok`, `đồng ý`, `duyệt`, …) saves
it; another answer comes back to main as feedback, and a dismissal or a timeout
saves nothing. An approved skill is written to `$ALP_HOME/skills/<name>/SKILL.md`,
added to each chosen role in `$ALP_HOME/role-skills.json`, and the lessons it
replaces leave both lessons files. A skill of an existing name needs
`replace: true`. New sessions of those roles list it; ALP updates never touch it,
since ALP did not ship it. `alp_skill` is available to a supervised main with a
user library.

## Issues

Root main gets `alp_issue` for GitHub issues of the project (`target: "project"`,
the repository its `origin` remote points to) or of ALP itself (`target: "alp"`,
`phucanh08/alp-paseo`), for problems outside the task worth tracking. `search`
lists up to 10 matching issues, open or closed, without asking. `create` (title,
body, optional existing labels) and `comment` (issue number, body) first show the
user the repository, the action and the whole draft, and post only on an approving
answer, as for skills. Posts run the GitHub CLI (`gh`, or `ALP_GH_BIN`) with the
user's login and end with a line saying an ALP agent drafted them with the user's
approval. A project without a GitHub `origin`, a missing `gh`, or a failed post is
reported to main. Other agents report problems to their requester instead. Main's
instructions forbid posting any other way; with full access ALP cannot prevent a
shell `gh` call, so that rule is an instruction, not a guarantee.

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

`init` fills missing files without replacing user content and seeds the user's skill
library. `upgrade` backs up and updates recognized shipped instructions, adds
oracle, reviewer and supervisor, renames `smart`/`supervised` settings to
`pho`/`cafe`, archives project skill copies identical to the shipped skills (so the
library applies), and preserves custom instructions and skills. Projects with the old
shipped main → lead → peer graph migrate to Cafe; older projects without routing
migrate to Phở. Explicit custom graphs remain unchanged and continue using legacy
custom routing unless a profile is explicitly selected. Existing projects are not
silently rewritten on plugin reload. Reconcile any customized instructions reported
by upgrade yourself.

## Live verification

Run the opt-in real-model smoke tests against a running daemon (default loopback
port 6767):

```sh
npm run test:e2e:workflow
node scripts/workflow-e2e.mjs pho
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
