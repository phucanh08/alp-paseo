# Skills for main, lead, and peer

Six workflow skills are adapted from the
[alp-claude skill collection at f5f38dd](https://github.com/phucanh08/alp-claude/tree/f5f38dd5428866cd846b761fa15062c43a4d71cf/skills).
The instructions are rewritten for the active-main ALP model and its actual runtime,
with no Claude-only tools, global installation, or automatic commit/approval gates.

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

## Installation and upgrades

```powershell
node src/cli.js init "D:\Projects\new-project"
node src/cli.js upgrade "D:\Projects\existing-project"
```

New projects receive actual files under
`.alp/agents/<role>/skills/<skill>/SKILL.md`. Each applicable skill includes its
relative references. There are no symlinks or dependencies on a global skill folder;
an agent package can be moved as a unit.

The canonical source is `templates/skills/`, with role assignments in
`templates/role-skills.json`. Shared methods are maintained once in the repository
and copied into each applicable agent package by the initializer. These starter
assignments do not restrict filesystem discovery of custom agents or custom skills.

`init` fills missing skills/resources without overwriting existing files. `upgrade`
also updates recognized original main-only or team-v1 role definitions, saving their
previous contents under `.alp/backups/upgrade-*`. This gives older shipped roles
the new skill routing instructions. Customized definitions and skill files are
preserved; the CLI identifies custom role instructions needing manual reconciliation.
An existing skill file is never silently replaced with a newer template version.

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

Use a new session, or close/resume the existing session, after upgrading so the
adapter reads the new role instructions and skill index. Changing only these skill
files does not require reinstalling the Paseo plugin. Native dynamic delegation tool
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

Validation covers skill frontmatters, role assignments, copied relative
references, package portability, lazy adapter loading, repeated installation,
custom-file preservation, and backed-up migration of shipped team-v1 definitions.

The initial seven-package version passed the skill-creator validator and 56 automated
tests on 2026-10-07. The router was subsequently retired at the user's request. The existing
`.alp-test/manual-phase1` project was upgraded and its resolved skills checked.
No new real-model E2E run was required for this file-installation change; the
adapter test verifies that the installed paths are exposed and bodies remain lazy.
