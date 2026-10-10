# Skills for main, lead, and peer

Six workflow skills are adapted from the
[alp-claude skill collection at f5f38dd](https://github.com/phucanh08/alp-claude/tree/f5f38dd5428866cd846b761fa15062c43a4d71cf/skills).
The instructions are rewritten for the active-main ALP model and its actual runtime,
with no Claude-only tools or automatic commit/approval gates.

| Skill | Purpose | Main | Lead | Peer |
|---|---|---|---|---|
| goal-griller | Clarify material gaps in the user's desired outcome | Yes | — | — |
| xia | Research local reuse and version-appropriate primary sources | Yes | Yes | Yes |
| sequence-execution-plan | Order dependent work and writer ownership | Yes | Yes | — |
| prompt-leverage | Prepare a self-contained delegation brief | Yes | Yes | — |
| bug-loop | Reproduce, diagnose, fix, and verify a regression | Yes | Yes | Yes |
| smart-commits | Package owned changes when local commits are requested | Yes | Yes | Yes |

Main has six skills, lead five, peer three. Each agent selects directly from its
own skill scope; there is no separate router skill. A skill's availability does not grant
write or delegation authority. Read-only diagnosis stops before changes. Lead routes
missing user decisions to main; peer routes them to lead. Main retains responsibility
for communicating with the user and may execute work itself.

## How agents see their skills

An agent sees only its own skills: its role's in `role-skills.json`, plus those its
`agent.json` names. Each one appears in the agent's instructions with its file and the
`description` from its frontmatter, so the agent knows what work a skill is for without
opening it. The instructions tell the agent to read a skill's `SKILL.md` before work its
description matches, and to say which skill it uses.

Claude agents also get their skills as Claude Code skills named `alp:<name>`. A plugin
made for the session links each skill's own directory. Claude lists the skills with
their descriptions and runs one with its Skill tool, read-only sessions included. Codex
reads the files.

Each first use of a skill in a session is logged. `alp log` prints it as
`✦ peer uses skill bug-loop` (or `… (Skill tool)`), and a supervisor's digest notes it.

## The user's skill library

Skills and the skills each role gets live in the user's library in `$ALP_HOME`
(default `~/.alp`), shared by every project:

```text
~/.alp/
  role-skills.json        # { "main": [...], "lead": [...], "peer": [...], ... }
  skills/<skill>/SKILL.md # with its references/
  library.json            # what ALP wrote, by hash
```

alpd seeds the library from its templates the first time it opens a session, and
`alp init` / `alp upgrade` seed it too. The canonical source is `templates/skills/`,
with the starter assignments in `templates/role-skills.json`; oracle, reviewer and
supervisor get no skills by default.

The library belongs to the user. Edit a skill, add your own under `skills/`, or change
which skills a role gets in `role-skills.json`. `library.json` records the hash of
every file ALP wrote. When an app update ships new templates, ALP:

- adds a file it never shipped before, unless you already made a file of that name;
- replaces a file only while it still holds exactly what ALP last wrote;
- never recreates a file you deleted, and never touches a file you edited.

So an update can change an unedited skill or `role-skills.json`, while your edits and
deletions stay. A new shipped skill added to `role-skills.json` reaches a role only
while you have not edited that file. A skill name in `role-skills.json` that has no
`SKILL.md` is skipped; a name that is not a plain directory name is an error.

## Skills main proposes

Main may distill its lessons into a new library skill with `alp_skill` and choose
the roles that get it. The user approves the whole skill first; then ALP writes
`skills/<name>/SKILL.md` and adds the name to those roles in `role-skills.json`.
These skills belong to the user like any edited file: ALP updates never replace or
remove them. See [team workflow](team-workflow.md#skills-from-lessons).

## Project skills

A skill in the project's `.alp/skills/<skill>/SKILL.md` replaces the library skill of
the same name for every agent in that project. A project override of an agent,
`.alp/agents/<role>/`, can also hold `skills/<skill>/SKILL.md`, which applies to that
role only and replaces both. An agent can also name skills in its `agent.json`; see
[agent library](agent-library.md). Custom agents get only their own
project skills unless `role-skills.json` lists skills under their name. A runtime embedded without a library (`libraryDir` unset) uses project skills only.

```sh
alp init /absolute/new-project
alp upgrade /absolute/existing-project
```

Projects created before 0.4 carry a copy of each role's skills. `alp upgrade` moves
copies that are identical to the shipped skills into its backup under
`.alp/backups/upgrade-*`, so the library applies, and reports customized copies,
which stay and keep overriding. `upgrade` also updates recognized original main-only
or team-v1 role definitions, saving their previous contents in the same backup.
Customized definitions are preserved; the CLI identifies custom role instructions
needing manual reconciliation.

The obsolete `ask-alp` router is no longer installed. Upgrade moves recognized
unmodified copies into its backup directory, outside agent skill discovery, and
updates recognized shipped role instructions. Customized router copies are preserved
and reported for explicit review.

For a customized AGENT.md, add the relevant guidance from the corresponding template:
read the selected skill before applying its method, load references only when needed,
and preserve the role's existing authority. Existing settings and routing stay intact.

## Runtime use

The current Paseo adapter advertises the selected agent's skill names and absolute
SKILL.md paths. The agent reads the chosen file with normal runtime file-reading tools.
Skill bodies and reference text are not injected at session launch. A native Skill
tool or slash-command registry is not required or added by this change.

Examples of requests to main:

- "Dùng xia xem phần này có chức năng sẵn để tái sử dụng không."
- "Giao Lead tổ chức Peer sửa lỗi này bằng bug-loop và trả bằng chứng trước/sau."
- "Dùng sequence-execution-plan để sắp thứ tự ba việc này."

Use a new session, or close/resume the existing session, after upgrading or editing
the library so the adapter reads the new role instructions and skill index. Changing
only skill files does not require reinstalling the Paseo plugin. Native dynamic delegation tool
changes still have the fresh-session requirement documented in team-workflow.md.

## Adaptation decisions

- Main can use execution skills; it is not the reference's observer-only supervisor.
- User intake belongs to main. Lead receives a brief from main and peers receive a
  brief from lead, so lower roles do not start independent user interviews.
- Briefs fit the exposed alp_delegate arguments: agent, task, optional mode. Model
  and reasoning inherit; parallel worker control and live upstream mailboxes are
  not available in the current synchronous adapter.
- Research and verification stay proportional to the task. Skills do not invent
  dependencies, mandatory full-repository audits, extra approvals, or missing tools.
- Non-Git projects can hand off file artifacts. Merely editing a file does not invoke
  smart-commits or authorize a push.

Validation covers skill frontmatters, role assignments, relative references in the
library, user-edited assignments and project overrides, updates that keep edited and
deleted files, lazy adapter loading, archiving of unmodified project copies, and
backed-up migration of shipped team-v1 definitions (`test/skills.test.js`).

The initial seven-package version passed the skill-creator validator and 56 automated
tests on 2026-10-07. The router was subsequently retired at the user's request. The existing
`.alp-test/manual-phase1` project was upgraded and its resolved skills checked.
No new real-model E2E run was required for this file-installation change; the
adapter test verifies that the installed paths are exposed and bodies remain lazy.
