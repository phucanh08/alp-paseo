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
A permission profile can cap an agent's mode and add rules (below).

Default maximum simultaneous peers is **2**. Increase `workflow.maxPeers` only at
the user's request, then start a new session. Peer limits count across the root
session's live tree. Advisors and lead do not consume peer slots. Concurrent peers
must be read-only or isolated.

## Permission profiles

A permission profile tunes what one agent may do:
- It caps the agent's mode at its `base`.
- It lets the agent run what `allow` names, even beyond that mode.
- It asks the user each time before what `ask` names.
- It refuses what `deny` names, in any mode.

Deny wins over ask, and ask over allow. Profiles live in `permissions` in `.alp/settings.json`,
which is committed with the project, and in the user's `$ALP_HOME/settings.json`:

```json
{
  "permissions": {
    "profiles": {
      "review": {
        "base": "read-only",
        "allow": ["Bash(npm test:*)", "Bash(node --test:*)"],
        "ask": ["Bash(npm install *)"],
        "deny": ["Bash(rm:*)", "Bash(git push:*)"],
        "beyondMode": "ask"
      }
    },
    "agents": { "reviewer": "review", "auditor": "review", "lead": "workspace-write" }
  }
}
```

- Rules use Claude Code's syntax, for both runtimes:
  - `Bash(npm test:*)` covers `npm test` and anything after it; `Bash(git status)` covers exactly that command; `Bash` alone covers every command.
  - `Edit(src/**)`, `Read(...)`, `WebFetch(domain:example.com)` and `mcp__server__tool` name other tools.
  - A misspelt tool name is refused when the settings load.
- A command line is allowed only when allow rules cover each of its commands
  (split at `&&`, `||`, `;`, `|`), and none writes a file through a redirect;
  `2>&1` and `2>/dev/null` are fine. It is denied when a deny rule covers any one of them,
  or when it substitutes a command (`$(...)`, backticks) while deny rules exist.
- An agent names a profile, or one of the bases `read-only`,
  `workspace-write` and `full-access` for a cap with no rules. A profile defined in
  both files takes its base from the project and the rules of both; the
  project's agent entries win over the user's.
- Agents without an entry keep today's behavior. Oracle, reviewer and the
  supervisor get a read-only profile, and settings cannot raise theirs.
- A delegated child gets its own profile's cap. It still never exceeds its
  requester's mode.
- How each runtime enforces the rules:
  - Claude gets them as its own allowed and disallowed tools. Deny rules hold
    even with full access, and allowed commands run without asking.
  - Codex runs commands inside its sandbox without asking. With allow rules in a
    read-only or workspace-write session, Codex asks ALP before a command leaves
    the sandbox; ALP accepts only what an allow rule covers. A full-access
    session with Bash deny rules makes Codex ask before every command, and ALP
    declines what a deny rule covers. Inside its sandbox, Codex does not ask, so
    deny rules there only stop commands from leaving it.
- Every Codex decision goes to the assignment log as a `permission` event. The
  session's instructions list its profile's rules.

**Asking the user.** An `ask` rule, and with `"beyondMode": "ask"` anything
the mode refuses that no rule covers, becomes a question to the user. The question
shows in Paseo and in `alp questions`, names the agent and what it wants, and the
agent waits:
- **Allow once** runs it this time.
- **Always allow** adds a rule to the profile's `allow`, in the settings file
  that defines the profile (the project's first). Open sessions using that profile
  stop asking about it at once. For Claude this is its own suggested rule (such as
  `Bash(npm test *)`); for Codex, its proposed command prefix, else the exact command.
  An `ask` rule offers no always: it asks every time.
- **Deny**, any other answer, or no answer within 30 minutes refuses it. Any other
  answer is passed to the agent as the reason.

Only the user answers; main cannot grant permissions. One question per session
is open at a time. Without `beyondMode`, a profile refuses what its mode does not
allow, as before.

On Claude, `ask` rules hold in every mode, because Claude asks ALP itself.
`beyondMode` asks only in read-only sessions, since the other modes allow what
they reach. On Codex, read-only and workspace-write sessions ask before a command
leaves the sandbox; a full-access session with Bash `ask` rules asks before
every command it covers.

**The sandbox floor.** A Claude session with a read-only or workspace-write
profile runs Bash in Claude Code's OS sandbox: Seatbelt on macOS, bubblewrap and
socat on Linux.
- A read-only floor writes nothing but temporary files. A workspace-write floor
  writes only the workspace and temporary files. Neither has network.
- Inside the floor, any command may run, so a read-only reviewer or oracle can run
  tests and scripts that only read. Oracle, reviewer and the supervisor get this by default.
- File tools (Edit, Write) follow the same floor.
- A command leaves the sandbox only with `dangerouslyDisableSandbox`. Claude
  allows that itself for allow rules; otherwise ALP asks the user
  (`beyondMode: "ask"`) or refuses.
- Without the sandbox (another OS, or Linux without bubblewrap), sessions behave
  as before, and `ALP_CLAUDE_SANDBOX=0` turns it off.

Codex always runs in its own sandbox.

**A review copy.** `"workdir": "copy"` in a read-only profile runs the agent in a
disposable copy of its requester's tree:
- The copy is a detached git worktree at the requester's HEAD, with its
  uncommitted changes applied as uncommitted changes and its untracked files
  copied, so `git diff` and `git status` there match. A top-level `node_modules`
  is linked.
- The agent may write, build and test there (`npm test` that writes `dist/` is
  fine). To ALP it stays read-only: it claims nothing, and nothing it does reaches
  the requester.
- The copy is removed when the assignment ends, and the daemon removes copies
  left by a crash.
- On Claude the copy needs the sandbox floor; without it, the assignment is refused.
- Codex lets a command write the directory it runs in, even outside its writable
  roots. A Codex agent told to run in the requester's tree could still write
  there. ALP tells both sides the copy mirrors the tree, and when a Codex command
  runs in the requester's tree anyway, the result carries a `copyWarning` and the
  log a `copy.escape`.

```json
"review": { "base": "read-only", "workdir": "copy", "allow": ["Bash(npm test *)"] }
```

`alp permissions` lists every agent's profile. `alp permissions check reviewer "npm test 2>&1"`
says what a profile decides about a command.

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

## Verification gates

A project can name the commands that prove a change works, in
`.alp/settings.json`:

```json
{ "verify": { "setup": "npm ci", "typecheck": "npx tsc --noEmit", "test": "npm test", "timeoutSec": 600, "idleSec": 300 } }
```

Any of `setup`, `typecheck` and `test` may be set. They run in that order through
the shell, from the project root (or the same place in a worktree), and stop at
the first failure. `timeoutSec` limits each command; it defaults to 600 seconds.
alpd runs them itself, so their result does not depend on what an agent reports:

- **Before `alp_merge` applies a worktree change.**
  - ALP runs the commands in the assignment's worktree, with the project's
    `node_modules` linked in for the run when the worktree has none.
  - If they fail, nothing is applied, and the change stays waiting.
  - The result gives each step's exit code and the end of the failed step's
    output. It also suggests three ways on:
    - delegate again with `continueFrom` set to that assignment, so the new
      worktree starts from the change and the brief carries the failure;
    - `alp_discard` the change;
    - merge anyway with `skipVerify: "why"`, which is recorded.
- **When the requester's checkout changed since the worktree was made.** The
  worktree's check then says little about the merged result. ALP runs the
  commands again in the checkout after applying, and reports and records that
  result instead.
- **After a writer in the shared checkout finishes.** If the writer changed the
  checkout, ALP runs the commands there while it still holds the write lease.
  The assignment's result carries the outcome.
- **On demand.** Main and lead can call `alp_verify`, for example after
  resolving conflict markers, and only main may pass `taskId`. The user can run
  `alp verify [--task ID]`.

Each run is logged as a `verify` entry, and alp log shows it as
`✓ verify in the worktree …`. A run for a task is recorded on the task as
`verified`: where it ran, and each step's command, exit code and time, plus the
end of a failed step's output.

Main's task list shows the result next to tasks in review:
`handoff complete, verification failed: test exited 1`. Closing a task as `done`
whose last verification failed is refused for agents unless they pass
`unverified: "why"`. The user can always close it, and ALP notes that it closed
after a failed check. `skipVerify` and other close reasons need no passing run.

Live, a Codex main merged a peer's change that the project's check rejected. It
fixed the change twice with `continueFrom`, the third merge passed, and only
then did it close the task.

**Stopping a command.** When a command runs past `timeoutSec`, ALP sends
SIGTERM to its process group, so its own cleanup runs, and SIGKILL five seconds
later. With `"idleSec": 120`, a command that prints nothing for that long is
stopped the same way. The result says it `printed nothing for too long`.

**A step that could not run.** A command can exit 75 (`EX_TEMPFAIL`) to say it
could not run, for example because a database or the network is down, rather
than that the change is wrong. ALP stops there and records the check as
skipped (`infra: test could not run (exit 75)`), not failed. The same happens
when the shell itself cannot start. `alp_merge` still applies nothing, and
suggests running it again. Agents may close the task, since the failure says
nothing about the change.

## What reaches an agent's prompt

Agents read text that other agents wrote: mail, handoffs, the board, recall
answers, task titles and results, and the output of commands. Before any of it
enters a prompt or a tool result, ALP strips `<system-reminder>` tags from it,
repeating until none is left, so a peer cannot pose as the harness to main. The
user's own prompts are passed as written.

Native sessions run without `CLAUDECODE` and the other markers of an enclosing
Claude Code, Codex or Paseo session. ALP's own git commands run without the
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and similar variables a git hook
sets, so they always act on the repository they name.

A task an earlier alpd held goes back to open only when that alpd is gone.
ALP checks the pid and the time that process started, since a pid can be
reused by another process.

## Pause and usage limits

The user can hold ALP's work without losing it:

```sh
alp pause                      # everything: no new assignments, no wakes; running turns finish
alp pause codex --now -m "Lunch"   # one runtime; --now also parks its running assignments
alp pause status               # pauses and parked assignments (alp ps shows them too)
alp resume [codex|claude]      # lift a pause; parked assignments continue where they stopped
```

While a runtime is paused:
- `alp_delegate` to an agent on it is refused. The refusal says why, when a
  limit resets, and which other runtime still takes work, for example "pass a
  model of claude:".
- Sessions on it are not woken by mail; the mail waits for resume.
- The stall watchdog ignores their assignments.
- User prompts still reach main.

**Parking.** `--now` interrupts the running turns of assignments on the paused
runtime. A parked assignment stays open:
- its native thread, its task and its claims stay as they were;
- its requester gets a mail saying it is parked and why, and `alp ps` shows it
  as `parked`.

On resume, ALP starts a new turn on each parked assignment telling it to
continue where it left off.

**Usage limits.** ALP pauses a runtime by itself when a turn fails on a usage
limit:
- On Codex, that is `codexErrorInfo` `usageLimitExceeded` or
  `rateLimitExceeded`.
- On Claude, it is a `rate_limit` error or a rejected `rate_limit_event`. A
  failure while overage is still allowed does not count.

When that happens:
- If the turn was an assignment's, the assignment is parked rather than failed,
  so its task is not released.
- Every open root shows a notice: the runtime, when the limit resets (from the
  runtime's usage report), and that the other runtime keeps working.
- Paseo shows it as a notification, and `alp run` and `alp attach` print it.
- When a runtime reports a usage window at 90% or more, the user gets one
  warning per window.

**Resuming after a limit.** The user resumes, by default. Set
`"limits": { "autoResume": true }` in `$ALP_HOME/settings.json` to let alpd
resume a runtime a minute after its limit resets.

Pauses are kept in `$ALP_HOME/state/pause.json`, so they survive a restart.
Parked assignments survive one too: the next alpd reopens them still parked,
as described under Crashes and restarts.

## Crashes and restarts

Work survives alpd. When alpd stops, cleanly or in a crash, the next alpd
continues what was running:

- **Assignments.** ALP keeps every running assignment in
  `$ALP_HOME/state/live.json` from the moment its native thread exists. At
  start, alpd reopens the tree it belongs to and the assignment under its own
  id. It gets back:
  - its native thread;
  - its worktree, from the branch the crash recovery committed it to, or a
    fresh review copy;
  - its write lease, its task, which records the new alpd, and its claims.

  It then gets a turn that says alpd restarted and asks it to check where it
  stopped and continue.
- **Roots.** A root whose turn was running continues that turn with the same
  kind of prompt. A root that was idle stays idle; its assignments report to it
  by mail as usual. alpd reopens these trees with no client attached, so the
  work goes on before anyone opens Paseo. A client that opens the session
  attaches to the running tree. When the work is done and nobody watches, the
  tree closes as any unwatched root does.
- **Requesters** learn which of their assignments continue, and can
  `alp_wait` for them.
- **When an assignment cannot continue**, it ends as failed and its task goes
  back to open. For example, its branch is gone, or its root cannot be
  reopened. Its work stays on its branch.

Every open session of the project shows a notice: what restarted, how many
assignments reopened, and which could not.

`alp daemon stop` and `alp daemon restart` keep running work the same way.
`alp daemon restart` no longer refuses when sessions are open. To stop work
for good, interrupt the session, or `alp pause --now` first: a paused runtime's
assignments are reopened parked.

To decide yourself when recovered work continues, set
`"recovery": { "autoResume": false }` in `$ALP_HOME/settings.json`. Recovered
sessions then wait parked until `alp resume`.

**A runtime process that dies.** When a Codex app-server or Claude process
stops under a session, ALP starts a new one and resumes the session's thread.
A turn it interrupted is parked, then continued as soon as the new process is
up; its requester gets a passive note. ALP stops restarting after three
restarts in a row that brought no progress (no completed item since the
restart) within ten minutes. The session then fails as it did before. Pauses,
usage limits and interrupts never count as a death.

**Crash or clean stop.** A running alpd keeps `$ALP_HOME/state/alpd.running`
and touches it every 30 seconds; a clean stop removes it last. If alpd finds
the file at start, the previous alpd crashed around the file's last touch.
`alp daemon status` says so, and the notices and prompts of recovered sessions
say "alpd stopped unexpectedly" instead of "alpd restarted". `alp log` shows
`⏹` interrupted, `↻` reopened or restarted, and `▶` running again.

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
scope; lead and peers list such work under `discovered` in their handoff. The
runtime enforces the table: other roles get `alp_task` with only their actions,
and a refused action says who can change tasks.

### Tasks in delegation

Main gives a task to lead or peer by passing `taskId` to `alp_delegate`:

1. ALP refuses the delegation, with nothing changed, when the task is not ready,
   is already in progress (naming who holds it), or lists paths that an agent
   outside main's line of delegation has claimed. Advisors take no `taskId`;
   main names the task in their brief instead.
2. It starts the task for the assignment under the task lock, so two
   delegations of one task cannot both succeed.
3. A writing assignment's claim on the task's `paths` is pinned for it. Its
   brief starts with the task: title, description, paths, and how the handoff
   ends it. Every claim pinned by the assignment, or by lead's peers working on
   it, carries the task id.
4. When the assignment ends, a `complete` or `partial` handoff moves the task to
   `review` and keeps the handoff on the task. A `blocked` or `reconsider`
   handoff, or an assignment that ended without one, opens it again with the
   reason. The result main receives says where the task went.
5. Main accepts a task in review by closing it, after verifying it with the
   usual review rules, or delegates it again with the same `taskId` for rework.
   It records each `discovered` item as a task with `discoveredFrom`, or says why
   not.

At the start of each of its turns, main gets a short list of tasks waiting in
review, tasks in progress, and the most urgent ready tasks, with counts of the
rest. The supervisor's digest shows every task main created, started, delegated,
linked, closed or reopened, every task an assignment submitted or released, and
the discovered work of each handoff. It asks about tasks closed without real
verification, discovered work dropped silently, and tasks left in review.

If alpd stops while an assignment holds a task, the assignment ends with it,
but the task file still says `in_progress`. At main's next turn, ALP puts every
such task back to `open` and logs it as `orphaned`. It does this once per
project after alpd starts. Main's task list shows the task as interrupted,
with the branch that kept the assignment's work, until someone starts it again:

```text
- interrupted: t-e73e P2 Slow work ← peer; alpd stopped while it worked, work kept on branch alp/alp-child-0f23…; delegate it again
```

A task records which alpd process its assignment ran in. ALP leaves alone a task
whose assignment belongs to another alpd that is still running, such as one with
a different `ALP_HOME`. It also leaves tasks that main took for itself.

When a root's turn ends, its timeline shows the tasks the tree created or worked
on as a todo list, if the list changed. Paseo renders it as a task list, and
`alp run` prints it.

The user works with tasks from the CLI, which writes the files directly and
needs no running daemon:

```sh
alp tasks                        # open, in progress and in review
alp tasks ready                  # what nothing blocks, most urgent first
alp task add "Add --json" -p 1 -t feature --parent t-77e0 --after t-91c2 -l cli
alp task show t-77e0.2
alp task dep add t-c40d --after t-77e0.2      # rm removes; also --parent, --related
alp task close t-77e0.2 -m "Merged in #12"    # --reason wontfix | duplicate | superseded
alp task report t-77e0                        # what an epic came to so far
alp task reopen t-77e0.2 -m "Fails on Windows"
```

### Epic landed

An epic, or any task with children, lands when its last child closes. Main
learns it twice: the `alp_task close` that closed the last child says so, and
main's next task list starts with it:

```text
- ready to close: t-77e0 P1 Auth overhaul; all 3 children are closed. Close it with a summary; ALP reports it to the user
```

When main closes the epic, ALP sends the report as a notice to the open
sessions of that project. The report also goes in main's tool result and in
the assignment log as `epic.landed`:

```text
Landed epic t-77e0 "Auth overhaul": 3/3 tasks closed, took 2h 5m, 1 reworked, 2 verified, 1 failed verification, 1 closed unverified.
Auth reworked end to end
✓ t-77e0.1 Tokens — done: Rotating tokens, tested
✓ t-77e0.2 Sessions — done: Sessions done
  ✓ t-77e0.2.1 Cookie flags — done: Flags set (unverified)
✗ t-77e0.3 Docs — wontfix: Covered by the README
```

The report counts only the tasks at the bottom of the tree; a parent like
`t-77e0.2` is a group, not one more task. A task counts as reworked each time
it is delegated again from review, and as handed back when an assignment
released it or alpd stopped under it. Verification counts each task's last
check, and `closed unverified` names those closed after a failed check with a
reason. The time runs from the epic's creation to its close.

`alp task report <epic>` prints the same report at any time, and says
`Progress of …` while the epic is open. Add `--json` for the counts. When you
close an epic yourself with `alp task close`, the CLI prints the report; in
Paseo's Tasks panel, the toast shows its first line.

### Gates

A gate holds a task back, like an open blocker, until it clears. Main adds gates
with `alp_task` action `gate`, and the user adds them with `alp task gate add`:

| Kind | Clears when | Added with |
|---|---|---|
| `human` | the user approves it: `alp task gate clear <id> g1`, or Approve in Paseo | `--human "question"` |
| `timer` | its time passes; nothing is written | `--timer +2h` or an ISO time |
| `gh:pr` | the pull request merges | `--pr 12` or `--pr owner/repo#12` |
| `gh:run` | the workflow run completes with success | `--run 345` or `--run owner/repo#345` |

A gate on an epic holds back its children. Main cannot clear a human gate: the
runtime refuses it, and main asks the user instead. Main may clear its other
gates by hand with action `clear`, and the user removes a gate with
`alp task gate rm`. At the start of main's turns, at most once a minute per
project, ALP asks GitHub about the open `gh:pr` and `gh:run` gates with the `gh`
CLI and clears those that are done. `alp tasks gates` does the same and lists
the open gates. Main's turn context lists tasks that only a gate holds back.

### Compaction

`alp tasks compact [--days 30] [--dry-run]` shrinks tasks closed more than
`--days` ago:
- Kept: the title, relations, labels, paths and the close reason and summary.
- Clipped to 300 characters: the description and the handoff summary.
- Dropped: the handoff's lists, gate details, and the log between creation and close.

A compacted task records when, by whom and its former size, and is not
compacted again. Only the user compacts.

### Formulas

A formula is a workflow template, after beads formulas. It is a file named
`<name>.formula.toml` or `<name>.formula.json`, found in the project's
`.alp/formulas`, then `$ALP_HOME/formulas`, then the project's `.beads/formulas`;
the first file of a name wins.

```toml
formula = "release"
description = "Ship {{version}}"
version = 1

[vars.version]
description = "The version to ship"
required = true

[[steps]]
id = "changelog"
title = "Write the changelog for {{version}}"
paths = ["CHANGELOG.md"]

[[steps]]
id = "approve"
title = "Approve the {{version}} changelog"
type = "human"          # the user's step
needs = ["changelog"]

[[steps]]
id = "publish"
title = "Publish {{version}}"
needs = ["approve"]
```

Pouring it creates an epic labelled `formula:release` and one child per step,
in step order (`<epic>.1`, `<epic>.2`, …). `needs` become `blockedBy`, `{{var}}`
is filled in titles and descriptions, and steps may set `type`, `priority`,
`labels`, `paths` and `description`. A `human` step waits on a human gate; when
the user approves it, the step closes. A formula is checked before it pours:
unknown `needs`, cycles, duplicate step ids, unknown variables and missing
required ones refuse it, and nothing is written.

```sh
alp formula list
alp formula show release
alp formula pour release --var version=0.4.0 [--parent t-77e0] [--dry-run]
```

Main lists formulas with `alp_task` action `formulas` and pours one with `pour
{ formula, vars, parent? }`.

### beads import and export

`alp tasks export [-o file]` writes the tasks as beads JSONL, one issue per
line, which `bd import` reads. `alp tasks import [file] [--dry-run]` reads what
`bd export` writes; the default file is the project's `.beads/issues.jsonl`.

- Relations map to beads dependencies: `blockedBy` is `blocks`, `parent` is
  `parent-child`, and `discoveredFrom` and `related` keep their names.
- beads has no `review`: a task in review is exported as `in_progress`. Paths,
  gates, handoffs and formula details ride in `metadata.alp`, so a task that
  goes to beads and back keeps them. An open timer gate is also `defer_until`.
- Import is an upsert. An issue whose id is an ALP task id, or that ALP imported
  before, updates that task; any other gets a new ALP id, numbered under its
  parent, and remembers its beads id. Nothing is deleted.
- Tombstones, ephemeral issues and lines without a title are skipped. An issue
  in progress in beads is imported as open, since no ALP agent holds it, and
  unknown issue types become `task` with a `beads:<type>` label.
  `design`, `acceptance_criteria` and `notes` join the description.
- Each warning names the issue: a missing dependency target, a dependency type
  ALP does not have, or a link that would make a cycle.

### The Tasks panel in Paseo

The plugin adds a **Tasks** panel to every workspace, also reachable from the
command center as "Open ALP tasks". It shows the tasks of the ALP project that
contains the workspace's directory, grouped as:

1. Waiting for your approval (human gates, with Approve)
2. In review (with the handoff and "Accept and close")
3. In progress
4. Ready
5. Blocked or waiting
6. Epics
7. Closed, folded until you open it

The panel also adds tasks with a priority, closes and reopens them. All writes
are made as the user. It works through the plugin's server RPCs
(`alp.tasks.list`, `alp.tasks.add`, `alp.tasks.change`), which read and write
the files directly, without alpd. Plugin RPC cannot push, so the panel asks
again every five seconds while it is open. It needs Paseo 0.11.1 or a later
0.11 release.

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

## Recalling an assignment

A handoff says what an assignment did, not always why. `alp_recall` asks a
finished assignment directly:

```json
{ "assignmentId": "alp-child-f61d…", "question": "Why rewrite the tokenizer instead of patching it?" }
```

Main may pass `taskId` instead, which asks the last assignment that worked on
that task. Any agent that delegates gets the tool:
- Main may recall any assignment of its project, including ones from earlier
  sessions.
- Lead may recall only the assignments it, or its own assignments, started.
- An assignment that is still running is refused; ask it with `alp_send`.

The user asks the same way:

```sh
alp recall t-7412 "How did you arrive at your number?"
alp recall alp-child-f61d… "What did you leave out?" --json
```

How it works:
- **Kept threads.** ALP keeps every assignment's native thread on disk: a Codex
  rollout, or a Claude session file. It records each one in
  `$ALP_HOME/state/recall.json`.
- **A recall forks the thread.** It uses Codex `thread/fork` or Claude
  `forkSession`, read-only. The fork has no ALP tools, gets no approvals, and
  is ephemeral, so it leaves no thread of its own. It is asked the question and
  then closed, and the assignment's own thread never changes.
- **A removed worktree.** If the assignment worked in a worktree that is gone,
  a Codex recall runs in the project. A Claude recall recreates the directory
  empty for the fork, because Claude finds a session by the directory it ran in.
- **Expiry.** After 14 days, or past the newest 1000 assignments, ALP deletes
  the native threads. It does this when alpd starts and after each assignment
  ends.
- **Logging.** Recalls appear in the assignment log as `recall` entries, and in
  the supervisor's digest.

Kept Claude assignment sessions show up in `claude --resume` for the directory
they ran in until ALP deletes them.

## Assignment log

The Paseo plugin appends one JSONL file per root session to `~/.alp/runs/`
(override with `ALP_RUN_LOG_DIR`). Each assignment writes an `assignment.started`
record (parent, agent, project, mode, model, thinking, task) and an
`assignment.finished` record (status, runtime, duration, handoff, output, error).
Logs live outside the project so they never dirty the checkout. Logging is best
effort: an unwritable directory never blocks or fails delegation. The files contain
full task briefs and results; delete them as you would other local agent history.

Every session that opens also writes an `instructions` record: a 12-character
digest of the instructions it runs with, its length, and digests of the
project's `ALP.md` and the agent's `AGENT.md`. The text itself is not logged.
`alp log` shows it as `# main instructions 1d892063c42d (ALP.md …, AGENT.md …)`.
When an agent behaves differently from last week, compare the digests. If the
sha changed, the parts show which file changed. If neither part changed, the
difference came from lessons, skills or the profile.

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

**Settings keys.** ALP rejects a top-level key it does not know, and names the
closest known one:

- `.alp/settings.json` knows `defaultAgent`, `workflow`, `runtime`,
  `permissions`, `verify` and `delegation`. A typo such as `"verfy"` stops the
  session from opening with `unknown setting 'verfy'; did you mean 'verify'?`.
- `$ALP_HOME/settings.json` knows `permissions`, `limits` and `recovery`.
  `limits` and `recovery` take only `autoResume: true | false`. An invalid file
  does not stop alpd: it logs `ignoring …settings.json: …` to
  `$ALP_HOME/logs/alpd.log` and starts with the defaults.

`$schema` is allowed in both files. Keys that a later ALP retires will warn
instead of failing, so older settings keep working.

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
