# Main, lead, and peer on Paseo

The normal conversation is user -> main -> lead -> peer. Results return through
lead to main. Main owns delivery, decisions within the user's scope, and the final
answer. It can implement, integrate, and unblock as well as supervise. Lead owns
technical execution and reviews peer candidates. Peer executes a bounded brief.
Main reviews lead-authored work; main-authored work should receive independent
review, and missing review must be disclosed. User constraints still govern all roles.

The reference is [alp-claude at f5f38dd](https://github.com/phucanh08/alp-claude/tree/f5f38dd5428866cd846b761fa15062c43a4d71cf), particularly
[lead](https://github.com/phucanh08/alp-claude/blob/f5f38dd5428866cd846b761fa15062c43a4d71cf/agents/lead.md),
[peer](https://github.com/phucanh08/alp-claude/blob/f5f38dd5428866cd846b761fa15062c43a4d71cf/agents/peer.md), and
[supervisor](https://github.com/phucanh08/alp-claude/blob/f5f38dd5428866cd846b761fa15062c43a4d71cf/agents/supervisor.md).
This adaptation keeps bounded ownership and evidence-based handoffs. The requested
main role adds delivery and implementation authority beyond the reference's observer
supervisor. Claude-specific tools, skills, memory layout, and mailbox scripts are
not copied into the provider-neutral templates.

The workflow methods are now available as provider-neutral [role skills](role-skills.md),
loaded only when needed: six for main, five for lead, and three for peer.

## Initialize or migrate

From this repository:

```powershell
node src/cli.js init D:\Projects\my-project
# For older main-only or team scaffolds:
node src/cli.js upgrade D:\Projects\my-project
```

`init` never overwrites existing files. `upgrade` recognizes the original ALP.md and
main/AGENT.md as well as the shipped team-v1 role definitions, backs them up under
`.alp/backups/upgrade-*`, and replaces them with the new templates. Both commands add
missing role skills and references. Upgrade adds delegation settings only if the field is absent, preserving
runtime/default-agent settings. Custom instructions and delegation graphs are left
unchanged; reconcile customized role instructions with `templates/` when reported.
Existing custom lead/peer definitions are also preserved. Repeating upgrade is safe.

New settings:

```json
{
  "defaultAgent": "main",
  "delegation": { "main": ["lead"], "lead": ["peer"] }
}
```

The graph authorizes edges; folders remain the agent registry. Names are not fixed
in the resolver or runtime. Missing delegation configuration means no authorized
targets. A project can add custom names and an acyclic routing graph.

## Run on the existing isolated test daemon

Prerequisite: the daemon at 127.0.0.1:16767 is running with ALP enabled and Codex
authentication available. On this workspace's Windows machine, Node 24 is installed
at the path below; the PATH Node/npm combination may be incompatible.

```powershell
cd D:\Projects\alp-workspace
$node = 'C:\Users\anhlp\tools\node24\node.exe'
$paseo = '.tools/paseo/node_modules/@getpaseo/cli/bin/paseo'
& $node scripts/build-paseo.mjs
& $node $paseo plugin reload alp-provider --host 127.0.0.1:16767
& $node src/cli.js init .alp-test/manual-team
& $node $paseo run --host 127.0.0.1:16767 --provider alp/gpt-5.6-sol --mode workspace-write --thinking low --cwd D:\Projects\alp-workspace\.alp-test\manual-team "Main: giao Lead tổ chức Peer tạo hello.txt chứa Hello ALP, kiểm tra kết quả rồi báo lại cho tôi."
```

Use read-only mode for research/review tasks. A role's expanded authority does not
grant write access in read-only mode. Normal requests go to main; explicitly selecting
`providerOptions.agent` remains available for exceptional direct lead/peer sessions.

## Runtime behavior

Paseo's provider registers a dynamic `alp_delegate` tool for agents with configured
targets. The adapter uses the experimental Codex app-server
[dynamic tool protocol](https://learn.chatgpt.com/docs/app-server#dynamic-tool-calls-experimental),
verified against the installed binary's generated protocol. Arguments are `agent`,
`task` (self-contained brief), and optional `mode` (`read-only` or `workspace-write`).
Identity, root, and permissions come from the caller session, never from model-supplied
sender metadata. Native multi-agent spawning is disabled for these threads.

Each call creates a separate Codex process/thread with the selected agent's own
instructions, skills index, and MCP configuration, plus inherited host context,
model, reasoning, environment, and permission mode. A caller may narrow the child
to read-only. A read-only caller cannot create a workspace-write child.

Paseo receives actual child `session.opened` events with `parentSessionId` and
`toolCallId`; it can display their timelines. The caller waits for the child handoff
and receives its session/thread IDs, status, and actual assistant output. This
transport result is not an acceptance verdict: lead/main still review the evidence.

Each parent has one active child. Repeated tool-call IDs reuse the result. The graph
must be acyclic, the maximum chain is four agents, and each root turn permits at most
sixteen child assignments. Each child task times out after ten minutes. A child closes
on handoff or failure. Interrupting/closing a parent closes its descendants; steering
cancels descendants before applying the changed brief to the parent.

## Limits

- This is synchronous delegation, not an asynchronous mailbox or a persistent worker
  pool. A follow-up assignment creates a new child; include prior findings in its brief.
- Main and child transcripts are separate. Completed results enter the parent's
  persisted tool history; active child execution is not restored after daemon restart.
- Reload rereads routing authorization. Dynamic tool registration is stored in the
  native thread; start a fresh main session when first enabling delegation or changing
  the available target list.
- The first version uses one project root and shared checkout. Agents must respect
  writer ownership; arbitrary shell commands and per-file scopes are not enforced
  as a security boundary by role prose. Independent top-level sessions can still
  conflict if the user starts concurrent writers in the same checkout.
- The experimental runtime protocol may require adaptation with a different Codex
  version. No standalone ACP surface or Claude Agent Teams dependency was added.

## Repeat verification

```powershell
& $node scripts/build-paseo.mjs
& $node --test
& $node node_modules/typescript/bin/tsc -p tsconfig.paseo.json
# Real model calls, already-running isolated daemon required:
& $node scripts/team-e2e.mjs
& $node scripts/team-e2e.mjs --write
```

Read-only E2E checks a fresh peer-only token returned through two real child sessions,
Paseo's child-session listing, and byte-for-byte preservation of project files.
Write E2E uses the shipped role templates, asks peer to create one exact-content file,
and checks that all other project files remain unchanged. Evidence is written to
`.alp-test/team-e2e.json` and `.alp-test/team-write-e2e.json`. Test agents are archived
afterward; fixture projects and evidence are retained locally.
