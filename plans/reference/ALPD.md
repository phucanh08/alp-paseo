# alpd — Native ALP Daemon

Status: **approved by the user on 2026-10-08**, including every proposal in §13. Implements decision D12.

This spec defines what `alpd` owns, how clients talk to it, what it stores, and how we get there from the current Paseo plugin without breaking v0.2.x. Where a design is borrowed from Paseo 0.11.1, the Paseo symbol is named so it can be re-read (`@getpaseo/*` in `node_modules`, daemon source inside `/Applications/Paseo.app/Contents/Resources/app.asar`).

## 1. Goals and non-goals

Goals:

- One daemon per user serves every ALP project on the machine.
- `alpd` owns native runtimes (Codex app-server, Claude Agent SDK), sessions, delegation trees, mailbox, timeline, and persistence. Agent-to-agent calls never leave the daemon.
- Clients are views: the Paseo plugin (thin proxy), the `alp` CLI, later ACP.
- A session survives viewer restarts. Closing Paseo does not stop work.
- Existing ALP semantics (D11: routes, limits, mail, steer/interrupt rules, handoff) are preserved exactly; this is a relocation, not a redesign.

Non-goals for v1 (explicitly deferred):

- Remote access, TCP listen, passwords, relay, WebSocket, browser clients.
- Resuming an in-flight turn after a daemon crash (native runtimes cannot).
- Interactive permission approvals (today they are unsupported; the event schema reserves them, §6.4).
- File leases / worktrees (phase C, built on top of v1).
- Human mail channel and dashboards (phase D; built, §17).
- Windows named pipes (keep the transport abstract so it can be added).

## 2. Process model

Borrowed from Paseo's `runSupervisor` / `daemon-worker` / `acquirePidLock`, simplified.

- **Home:** `ALP_HOME`, default `~/.alp` (already holds `runs/`). Created `0700`.
- **v1 is a single process** (no supervisor/worker split). Paseo's split exists to restart a crashed worker and to own logs; we take the restart responsibility to the client auto-start path (§2.3) and revisit the split if crashes happen in practice.
- **Lock file** `~/.alp/alpd.lock`, created with `open(..., 'wx')`:
  `{ pid, startedAt, bootTime, uid, version, protocolVersion, socket, ready: boolean }`.
  - Stale when `kill(pid, 0)` fails, or `bootTime` differs from the current boot (pid reuse guard, as Paseo).
  - Before removing a stale lock, re-read it and confirm it is unchanged.
  - Heartbeat: touch mtime every 30 s; if the daemon finds it no longer owns the lock, it shuts down.
- **Socket** `~/.alp/alpd.sock` (unix domain socket, `0600`, inside the `0700` home). File permissions are the authentication in v1; no token. (Paseo admits any loopback client as owner when no password is set — we avoid TCP entirely instead.)
- **Logs** `~/.alp/logs/alpd.log`, rotated at 10 MB × 3. Never log prompts' credentials or env values.

### 2.1 Startup

1. Acquire lock (or exit with "already running" + the live lock contents).
2. Load state (§5), reconcile crashed records (§5.4).
3. Listen on the socket, then set `ready: true` in the lock. Clients wait on the lock, not on probing the socket (Paseo `waitForDaemonReady`).

### 2.2 Shutdown

Order, borrowed from Paseo `stop()`: stop accepting connections → refuse new sessions/turns → interrupt running turns (bounded 5 s each) → close all subtrees → flush storage → close runtimes and kill their process trees → remove socket → release lock. SIGINT/SIGTERM trigger it; a forced exit after 10 s.

### 2.3 Auto-start and version skew

Shared client library (`src/client/`), used by CLI and plugin:

1. Read the lock. If live and `ready`, connect to `socket`.
2. Otherwise spawn `alpd` detached (stdio to the log), and poll the lock every 100 ms up to 15 s. On timeout, report the last 30 log lines (as Paseo does).
3. `daemon.hello` (§3.2). If `protocolVersion` differs, fail with a clear message (`alp daemon restart` after upgrading). Clients never restart a daemon they did not start, and never one with running sessions, without the user's command.

**Environment:** an auto-started daemon inherits the starting client's environment (PATH, provider credentials). Runtimes receive that environment with the same scrubbing as today (`PASEO_*`, `CODEX_*`, `CLAUDE_CODE_*`). See open question Q3.

## 3. Transport and protocol

### 3.1 Framing

JSON-RPC 2.0, one JSON object per line (NDJSON) over the unix socket — the same framing our `CodexTransport` already speaks. Maximum frame 16 MiB. Requests `{jsonrpc, id, method, params}`, responses `{jsonrpc, id, result | error{code, message, data?}}`, server pushes are notifications `{jsonrpc, method: "event", params}`.

Paseo uses a bespoke `*_request`/`*_response` envelope with three error channels; we do not copy that. One error channel, stable codes:

| code | meaning |
|---|---|
| -32600..-32603 | JSON-RPC standard |
| 1001 `not_found` | session/subscription unknown |
| 1002 `invalid_state` | e.g. configure while running |
| 1003 `forbidden` | route/limit/permission violation |
| 1004 `conflict` | idempotency key reused with different input |
| 1005 `unavailable` | runtime failed / daemon shutting down |

### 3.2 Handshake

`daemon.hello { protocolVersion: 1, client: { name, version }, capabilities: string[] }`
→ `{ protocolVersion: 1, daemonVersion, daemonId, capabilities: string[] }`.

Capabilities are negotiated by intersection, reusing Paseo provider capability names where they mean the same thing (`session.persistence`, `session.subsession`, `prompt.steer`, `session.list`). Any compatibility shim is tagged `COMPAT(name): added vX, remove after <date>` (Paseo's discipline). Start with one protocol version and few capabilities.

### 3.3 Connections

Each connection is independent. A client that reconnects re-subscribes with its last cursor (§4.3) and the daemon replays what it missed — this closes the gap Paseo leaves to clients. No session grace period is needed because subscriptions are cheap to recreate and no state lives on the connection, except subscriptions.

## 4. Event model

### 4.1 Session events

Every event belongs to exactly one session and carries a per-session position:

```ts
type Envelope = {
  sessionId: string;
  epoch: string;      // random per timeline store; changes only on reset/rewrite
  seq: number;        // strictly increasing per session
  ts: string;         // ISO
  turnId?: string;
  event: AlpEvent;
};

type AlpEvent =
  | { type: 'session.created'; session: SessionSnapshot }        // includes children
  | { type: 'session.updated'; session: SessionSnapshot }        // status/config/title/archive
  | { type: 'turn.started'; turnId: string; origin: 'user' | 'wake' | 'delegation' }
  | { type: 'turn.ended'; turnId: string; state: 'completed' | 'failed' | 'canceled'; error?: AlpError }
  | { type: 'item'; item: TimelineItem }                          // id-keyed upsert
  | { type: 'usage'; usage: Usage }
  | { type: 'mail'; mail: MailEvent; direction: 'in' | 'out' }    // §7
  | { type: 'assignment'; assignment: AssignmentSnapshot }        // started/finished
  | { type: 'permission.requested'; request: PermissionRequest }  // reserved, §6.4
  | { type: 'permission.resolved'; requestId: string; resolution: PermissionResolution }
  | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string };
```

`origin: 'wake'` makes mail-driven turns visible; Paseo renders them as autonomous runs (`trackAutonomousRun`).

### 4.2 Timeline items

Shapes copied nearly verbatim from Paseo's `AgentTimelineItem` / `ToolCallDetail` so the plugin projection is renames only. Unlike Paseo's client wire (deltas + collapse rules), alpd emits **full snapshots keyed by `item.id`**; a later event with the same id replaces the earlier one. That matches Paseo's provider contract (`timeline.item`), and Paseo's daemon produces deltas itself.

```ts
type TimelineItem = { id: string } & (
  | { kind: 'user_message'; text: string; clientMessageId?: string; source?: 'user' | 'mail' | 'assignment' }
  | { kind: 'assistant_message'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool_call'; callId: string; name: string; status: 'running' | 'completed' | 'failed' | 'canceled';
      detail: { type: 'shell'; command: string; cwd?: string; output?: string; exitCode?: number }
            | { type: 'sub_agent'; childSessionId: string; agent: string; assignmentId: string }
            | { type: 'unknown'; input?: unknown; output?: unknown };
      error?: string }
  | { kind: 'handoff'; assignmentId: string; handoff: Handoff }
  | { kind: 'error'; message: string }
);
```

`sub_agent` replaces today's `detail.type: 'unknown'` for `alp_delegate`, so viewers can link parent and child. More native item types (file edits, search, todo) are added as the transports surface them; the union is open by `kind`.

### 4.3 Storage, fetch, and catch-up

- alpd **owns the timeline**: each session has an append-only `timeline/<sessionId>.jsonl` of envelopes. This is required because Claude has no replay (`turns: []`) and child threads are ephemeral; Paseo instead rebuilds from provider history, which we cannot.
- `session.timeline { sessionId, direction: 'tail' | 'before' | 'after', cursor?: { epoch, seq }, limit? = 200 }` → `{ epoch, entries: Envelope[], reset, hasOlder, hasNewer }`. A cursor with another epoch, or an `after` cursor below the retained window, returns the tail with `reset: true` (Paseo `staleCursor` / `gap`).
- Fetch returns raw envelopes; collapsing same-id items is the client's job (a trivial `Map` by id). No `seqStart/seqEnd/collapsed/projection` modes.

## 5. Data model and storage

### 5.1 Layout

```text
~/.alp/
  alpd.lock  alpd.sock  logs/alpd.log
  state/
    sessions/<sessionId>.json       # SessionRecord, atomic temp+rename, per-session write queue
    timeline/<sessionId>.jsonl      # envelopes, append-only
    receipts/<sha256>.json          # idempotency receipts, pruned after 7 days
  runs/<rootSessionId>.jsonl        # assignment log (unchanged format, still written)
```

Flat `sessions/<id>.json` (not Paseo's `agents/<cwd-slug>/<id>.json`, which moves when cwd changes). All JSON is validated on load; invalid files are logged and skipped.

### 5.2 SessionRecord

```ts
type SessionRecord = {
  version: 1;
  id: string;                    // 'ses_' + 16 hex
  projectRoot: string;           // absolute, realpath
  agent: string;
  runtime: 'codex' | 'claude';
  model: string;
  mode: 'read-only' | 'workspace-write';
  thinking?: string;
  workflow: WorkflowSnapshot;    // frozen at creation, as today
  title?: string;
  parentId?: string; rootId: string; assignmentId?: string; toolCallId?: string;
  native: { threadId?: string; persistent: boolean };   // children: persistent=false
  status: 'initializing' | 'idle' | 'running' | 'error' | 'closed';
  lastError?: AlpError;
  createdAt: string; updatedAt: string; archivedAt?: string;
};
```

Unlike today, `mode` and `thinking` are persisted. Mail queues, assignments, waiters, and wake counters are runtime state rebuilt from the run log only for reporting; they are not resumed (§5.4).

### 5.3 Multi-project

Sessions are keyed by id; `projectRoot` scopes resolution. `.alp/settings.json`, `ALP.md`, and agent packages are read from the project at session creation and on explicit refresh, exactly as `mapSession` does now. A delegation tree never crosses projects. A global limit `maxRunningSessions` (default 8) is enforced in addition to per-root limits; see Q4.

### 5.4 Crash reconciliation

On boot, any record left `initializing` or `running` becomes `error` with `lastError: { code: 'daemon_restarted' }`, any live assignment is recorded `finished` with status `failed`, and child sessions are marked `closed`. Root sessions stay resumable: the next prompt resumes the native thread (Codex `thread/resume`, Claude `resume`). Paseo does no boot reconciliation; we do.

## 6. Client API (v1)

All methods except `daemon.*` take the session id the client got from `session.create` / `session.list`. Agent-facing tools (`alp_delegate`, `alp_wait`, `alp_ask`, `alp_send`, `alp_handoff`) are **not** client methods; the daemon handles them internally.

### 6.1 Daemon

| method | params → result |
|---|---|
| `daemon.hello` | §3.2 |
| `daemon.status` | → `{ version, pid, startedAt, sessions: { running, idle, total } }` |
| `daemon.shutdown` | `{ force? }` → `{}`; refused with running sessions unless `force` |
| `catalog.get` | `{ projectRoot? }` → `{ runtimes, models, modes, thinking, agents? }` (agents listed when a project is given) |

### 6.2 Sessions

| method | params → result |
|---|---|
| `session.create` | `{ projectRoot, agent?, runtime?, model?, mode?, thinking?, title?, idempotencyKey?, prompt?: PromptInput, adoptThreadId? }` → `{ session }`. Runs `initProject` when needed, as the plugin does now. `adoptThreadId` resumes an existing native thread (v1 handle migration, §8). |
| `session.list` | `{ projectRoot?, rootsOnly? = true, includeArchived? = false, limit?, cursor? }` → `{ sessions, nextCursor? }` |
| `session.get` | `{ sessionId }` → `{ session, children: SessionSnapshot[] }` |
| `session.prompt` | `{ sessionId, clientMessageId, text, whenRunning: 'steer' \| 'interrupt' \| 'reject' }` → `{ result: 'turn' \| 'steer', turnId }`. Same rules as today: a user steer reaches only this session, children keep running. |
| `session.interrupt` | `{ sessionId }` → `{ state: 'not_running' \| 'canceled' }`. Closes the whole subtree (D11). Borrowed Paseo flow: native interrupt → wait ≤ 2 s → synthesize `turn.ended canceled`. |
| `session.configure` | `{ sessionId, mode }` → `{ session }`. Only while idle with no live children (unchanged). |
| `session.refresh` | `{ sessionId }` → `{ session }`. Close and resume with re-read ALP files (today's "Refresh"). |
| `session.archive` / `session.unarchive` | `{ sessionId }`. Archive closes the subtree. |
| `session.timeline` | §4.3 |

`clientMessageId` and `idempotencyKey` are deduplicated with receipts (Paseo `MessageReceipts` / `CreationService`): a receipt still pending after a crash answers `conflict` with `outcome_unknown` rather than re-sending.

### 6.3 Subscriptions

`events.subscribe { sessionIds?: string[], rootId?: string, after?: Record<sessionId, {epoch, seq}> }` → `{ subscriptionId }`.

- `rootId` subscribes to a whole tree, including children created later (this is what the Paseo proxy uses).
- Without `sessionIds`/`rootId`, it receives `session.created/updated` for all sessions (directory view for `alp ps` and the plugin's `session.list`).
- With `after`, the daemon first replays envelopes after each cursor, then streams live. Pushes are `event` notifications `{ subscriptionId, envelope }`.

`events.unsubscribe { subscriptionId }`. Per-connection send buffer is capped (Paseo: 64 MiB); a client that exceeds it is disconnected and must resubscribe with its cursor.

### 6.4 Permissions (reserved)

`permission.respond { sessionId, requestId, response: { allow: true, updatedInput? } | { allow: false, message? } }`. v1 keeps today's policy (Codex `approvalPolicy: 'never'` + sandbox, Claude `canUseTool` gate), so no request is ever raised. When interactive approval is added: pending requests are persisted, delivered to subscribers, denied on interrupt, and denied after a timeout when no client is subscribed (Paseo has no timeout; we want one).

## 7. Delegation and mailbox inside alpd

The logic moves from `provider.ts` unchanged; only its plumbing changes:

- `runDelegation` today re-enters the Paseo-shaped `handle({type:'session.open'})` and `handle({type:'session.prompt'})`. In alpd these become internal `SessionManager.openChild()` and `SessionManager.startTurn({ origin })`, which emit `session.created` and `turn.started` events instead of provider events.
- Wakes (`autoWake`) stay serialized through the per-root queue; they call `startTurn({ origin: 'wake' })`.
- `MailEvent`, `takeBatch`, `renderMail`, delivery order, acknowledgement on completed turns, redelivery, passive `stalled`, and the inactivity watchdog are moved verbatim (`mailbox.ts` is already Paseo-free).
- Mail ids become per-root (`#n` per tree) instead of one counter per Paseo connection, because a daemon has no connection scope.
- Limits stay: route graph, depth 4, 16 calls per root turn, `maxPeers`, one writer, read-only advisors, children never exceed parent mode, wake limit 8, ask timeout, wait cap.
- Every mail and assignment change is also emitted as a `mail` / `assignment` event, so viewers see what today only reaches `~/.alp/runs`.

## 8. The Paseo plugin as a proxy

The plugin keeps its Paseo-facing contract (`compat.ts`, capabilities, catalog, config UI) and drops runtimes, delegation, and mailbox.

| Paseo provider input | alpd call |
|---|---|
| `catalog` | `catalog.get` |
| `sessions` (new: declare `session.list`) | `session.list { projectRoot: cwd, rootsOnly: true }` |
| `session.open` (no persistence) | `session.create`, then `events.subscribe { rootId }` |
| `session.open` (with persistence) | `session.get` + `events.subscribe { rootId, after }`; `history: 'replay'` → `session.timeline` |
| `session.prompt` (`delivery: auto/steer`) | `session.prompt` (`whenRunning: 'steer'`) |
| `session.interrupt` | `session.interrupt` |
| `session.configure` | `session.configure` |
| `session.close` | unsubscribe only; the alpd session keeps running |
| `session.archive` | `session.archive` |

| alpd event | Paseo provider event |
|---|---|
| `session.created` with `parentId` | `session.opened { parentSessionId, toolCallId, restoration: 'parent' }` then `session.ready` |
| `turn.started` / `turn.ended` | `session.turn` (wake turns appear as autonomous runs) |
| `item` | `timeline.item` (rename fields; `handoff` and `mail` → `tool_call`/`notification` or a `plugin` item) |
| `usage` | `session.usage` |
| `session.updated` | `session.config` / `session.closed` |

Persistence handed to Paseo: `{ version: 2, data: { alpdSessionId } }` with deterministic JSON so Paseo's duplicate-import check stays stable. Version 1 handles (native `threadId`) are migrated on first open: the plugin asks alpd to adopt that thread (`session.create` with `adoptThreadId`), then emits `session.persistence` with the v2 handle.

Roots created from the CLI become visible in Paseo through the import list (`session.list`). Optional, later: alpd registers them itself via `DaemonClient.importAgent` (an internal Paseo export, kept behind `compat.ts`).

Known limit (from the visibility spike): children only appear while their root is open in Paseo; opening the root later replays them from alpd.

## 9. CLI

`alp daemon start | stop | status | restart | logs`, plus:

- `alp run [--agent A] [--project DIR] "prompt"`: create, stream the tree until the root is idle, print the handoff/result. Ctrl-C interrupts.
- `alp ps [--all]`: list sessions as a tree.
- `alp attach <id>`: stream a tree from its tail.
- `alp send <id> "text"` and `alp interrupt <id>`.

The CLI is the headless proof and the e2e driver that does not need Paseo.

## 10. Code layout

```text
src/core/        # unchanged: resolver, IR, workflow, delegation graph (pure JS, no deps)
src/runtime/     # NEW, Paseo-free: SessionManager, delegation, mailbox, transports (moved from plugins/paseo/server)
src/daemon/      # NEW: lock, socket server, JSON-RPC, storage, reconciliation, logs
src/client/      # NEW: auto-start + typed RPC client (used by CLI and plugin)
src/cli.js       # gains daemon/run/ps/attach/send/interrupt
plugins/paseo/   # becomes a proxy over src/client
```

`src/runtime`, `src/daemon`, `src/client` are TypeScript, built with the existing esbuild script. An import-graph test (as `adapter.test.js:29` does for core) enforces that `src/runtime` and `src/daemon` never import `@getpaseo/*`. Packaging: the `@anhlp/alp` npm package ships the CLI and daemon; `alp-paseo-plugin` expects it installed (Q5, §15).

## 11. Migration steps

Each step ends with all existing unit tests and live e2e green.

1. **Extract runtime in-process.** *(Done 2026-10-08 on `feat/alpd-runtime-extraction`: `src/runtime` with `createAlpRuntime`, events with per-session `seq`; the plugin projects them. Existing team tests stay on the plugin as the regression net; `test/runtime.test.js` covers the runtime API and its import boundary.)* Move transports, `nativeSessionConfig`, mail, delegation, and tool dispatch into `src/runtime` behind `SessionManager` + the §4 event model. The plugin calls it directly and projects events to Paseo (§8 mapping, without a socket). Port `test/team.test.js` to the runtime API; keep a projection subset in the plugin. *Acceptance:* no `@getpaseo` import under `src/runtime`; Paseo e2e (`team`, `mailbox`, `workflow`) unchanged and green.
2. **Daemon + socket + CLI.** *(Built 2026-10-08 on the same branch; the API as built is in §14.)* Host `SessionManager` in `alpd`; plugin switches to `src/client`; add `alp run/ps/attach`. *Acceptance:* a CLI-only e2e runs main → lead → peer with no Paseo daemon; the same Paseo e2e passes through alpd; closing Paseo mid-delegation does not stop the tree.
3. **Persistence + reconciliation + import.** *(Built 2026-10-08 on the same branch; deltas in §15.)* Session records, timelines, receipts, crash reconciliation, `session.list`, v1 → v2 handle migration. *Acceptance:* kill -9 alpd mid-turn → restart → records reconciled, root resumable; a CLI-created root imports into Paseo and replays its children.
4. **Phase C on top** (leases/worktrees), then D. *(Phase C built 2026-10-09 on the same branch; see §16. Phase D built the same day; see §17.)*

## 12. What we borrow from Paseo and what we do not

| Borrow | Paseo source |
|---|---|
| Pid lock with boot-aware staleness and published endpoint | `acquirePidLock`, `updatePidLock` |
| Clients wait on the lock, not port probing | `waitForDaemonReady` |
| Ordered graceful shutdown with per-agent timeout | daemon `stop()` |
| Status set `initializing/idle/running/error/closed` | `agent-lifecycle` |
| Autonomous runs for provider-initiated turns | `trackAutonomousRun` |
| Interrupt → bounded wait → synthesized cancel | `cancelAgentRunNow` |
| Atomic temp+rename writes with per-key queues | `writeJsonFileAtomic`, `AgentStorage` |
| Idempotency receipts with "outcome unknown" | `MessageReceipts`, `CreationService` |
| `{epoch, seq}` cursors, `tail/before/after`, `reset` | timeline fetch |
| Timeline item and tool-call shapes | `AgentTimelineItem`, `ToolCallDetail` |
| Capability negotiation + `COMPAT(...)` tags | `CLIENT_CAPS`, `server_info.features` |

| Avoid | Why |
|---|---|
| Loopback TCP admitted as owner without password | unix socket with file permissions instead |
| No boot reconciliation of `running` records | §5.4 |
| Timelines rebuilt from provider history | Claude has no replay; alpd owns the log |
| cwd-slug storage paths, no receipt retention | flat ids, 7-day pruning |
| Bespoke request/response envelope, three error channels | JSON-RPC 2.0 |
| Client-side catch-up after reconnect | server replays from cursor |
| Supervisor/worker split (for now) | v1 simplicity; revisit if needed |

## 13. Resolved questions (approved 2026-10-08)

- **Q1 — Process model:** single process in v1. A crash ends running turns until a client auto-starts the daemon again. Revisit the supervisor/worker split only if crashes occur in practice.
- **Q2 — Lifetime:** runs until `alp daemon stop`; no idle exit.
- **Q3 — Environment:** the daemon uses the environment of whoever started it, scrubbed as today. Clients never forward their own process environment. A session's explicit `spec.env` variables (Paseo's per-agent env) are still applied to that session, as before.
- **Q4 — Global concurrency:** `maxRunningSessions = 8` across all projects, configurable in `~/.alp/config.json`.
- **Q5 — Packaging:** the `alp` package ships the CLI and daemon; `alp-paseo-plugin` depends on it and auto-starts the daemon. *(As built: the package is `@anhlp/alp`, and the plugin finds an installed CLI rather than depending on it; §15.)*
- **Q6 — Retention:** timelines of archived sessions are deleted after 30 days; live sessions are kept indefinitely; receipts after 7 days.

## 14. As built in step 2 (2026-10-08)

Step 2 implements a subset of §6 and changes a few shapes. §6 stays the target; this section is the contract the code follows today.

**Methods.** `daemon.hello`, `daemon.status`, `daemon.shutdown`, `catalog.get`, and:

| method | params → result |
|---|---|
| `session.create` | `{ sessionId?, spec: SessionSpec, history? = 'skip', delegation? = true }` → `{ session, attached }`. The caller may choose the id (Paseo uses its own); otherwise `ses_` + 16 hex. If that root is still live, the caller attaches to it instead: alpd re-announces the root (and its timeline when `history: 'replay'`), live children, and running turns. |
| `session.attach` | `{ sessionId, replay? = true }` → `{ session }`. Attaches to the root of `sessionId` and replays the retained tree log (CLI `attach`). |
| `session.release` | `{ sessionId }` → `{ closed }`. Detaches; closes the root at once if it is idle. |
| `session.prompt` | `{ sessionId, clientMessageId, delivery: 'auto' \| 'steer', content }` → `{}`. Results arrive as `prompt.accepted` / `prompt.failed` events. |
| `session.interrupt`, `session.configure { mode }`, `session.close`, `session.get`, `session.list` | As in §6, without paging. `session.list` returns live sessions, roots first. |

**Attachment instead of subscriptions.** A connection that creates or attaches to a root receives every event of its tree as `event` notifications (the envelope). A root with no attached connection is closed as soon as it is idle (`busy` false: no turn, child, assignment, or undelivered mail). Paseo's `session.close` therefore means "stop watching": work in progress finishes, then alpd closes it. `session.interrupt` remains the way to stop work.

**Not yet built:** persistence, receipts, cursors with `after`, `session.timeline` paging, `refresh`, `archive`, and permissions (step 3 and later). Events are retained in memory per tree (20,000 per tree) until the root closes.

**Errors.** `1000` operation failed, `1001` session not open, `1006` protocol or missing handshake, plus the JSON-RPC standard codes.

**Sockets.** `$ALP_HOME/alpd.sock` when its path is under 100 bytes; otherwise `alpd-<hash of home>.sock` in the temp directory. The lock publishes the path in use.

**Starting the daemon.** Clients run `alpd.js --detach`, which starts the daemon in a new session and exits, so the daemon is not part of the client's process tree. Paseo re-bundles and evaluates plugin code, so the plugin cannot locate files beside itself. It resolves alpd from `ALP_DAEMON_ENTRY`, then from the absolute path recorded at build time; step 3 adds two fallbacks that do not depend on the build machine (§15, Packaging).

**Embedded mode.** With `embedded: true` or a custom `transport`, the plugin hosts the daemon server in-process and connects through an in-memory connection (tests, `scripts/*runtime-e2e.mjs`).

## 15. As built in step 3 (2026-10-08)

**Storage.** `$ALP_HOME/state/sessions/<id>.json` holds one record per session (atomic temp + rename, one write queue per session) and `state/timeline/<rootId>.jsonl` holds every envelope of a tree in order. The record keeps the client's `SessionSpec` for roots, the last `SessionSnapshot` (native thread, runtime, model, frozen workflow), `status`, `lastError`, a title taken from the first user message, and timestamps. It does not yet carry the flat §5.2 fields; the snapshot holds them. `state/receipts/<sha256>.json` holds one receipt per prompt.

**Reconciliation (§5.4).** On boot, a root left `running` or `initializing` becomes `error` with `lastError.code = 'daemon_restarted'` (an idle root becomes `closed`), an open turn gets a synthetic `turn.ended failed`, and children become `closed` with an `assignment.finished` entry (`status: 'failed', reconciled: true`) in the run log. Closed trees whose root was last updated more than 30 days ago are deleted.

**Resume.** `session.create` with the id of a stored, closed root resumes it: alpd reopens the native thread (`restore`) with the stored spec (the caller may change only `mode` and `thinking`) and, with `history: 'replay'`, replays the stored timeline. That is the root's items, then the children's events in their original order, so a grandchild opens while its parent is open. Only the native thread is resumed; its children and mail are not. With `resume: true`, an unknown id fails with `1001` instead of creating a new session. The result carries `resumed: true`. `session.attach` also works for a closed root; it replays the stored timeline without reopening the root.

**Listing.** `session.list { projectRoot?, rootsOnly? = false, includeClosed? = false }` merges live sessions and records, roots first, newest first. `session.get` returns the same summary (`status`, `title`, `lastError`, `updatedAt`) for live and stored sessions.

**Paseo handles.** The plugin persists `{ version: 2, data: { alpdSessionId, agent, cwd } }`. Opening a version 2 handle resumes that alpd session (`resume: true`), so a pruned session reports that it no longer exists. A version 1 handle (plugin 0.2, carrying the native thread) is adopted: alpd opens a new session that resumes that thread, and Paseo stores the version 2 handle from then on. The plugin's `sessions` handler lists alpd roots, closed ones included, so a tree started with `alp run` can be imported into Paseo with its children.

**Receipts.** `session.prompt` delivers a `clientMessageId` at most once per session, across restarts, as Paseo's `MessageReceipts`: alpd writes a `pending` receipt with a fingerprint of `delivery` and `content`, sends, then marks it `completed`. A repeat with the same content returns `{ duplicate: true }` without sending; with other content it fails with `1004` and `data.reason: 'key_conflict'`; a receipt still `pending`, left by a crash during delivery, fails with `1004` and `data.reason: 'outcome_unknown'`, because the native harness may already have the message. Concurrent repeats wait for the first. Receipts are pruned 7 days after their last write. `session.create` needs no separate `idempotencyKey`: clients choose the session id, and creating an existing id attaches to or resumes it.

**Packaging (Q5).** Paseo re-bundles plugin code and does not tell the plugin where it is installed, so the plugin cannot find the `alpd.js` it ships. alpd records its own path in `$ALP_HOME/alpd.json` whenever it starts. A client that must start alpd tries, in order: its own candidates (`ALP_DAEMON_ENTRY`, then the build-time path), the recorded path, then the ALP CLI: an `alp` executable on `PATH` or in common global bin directories whose real path is `<package>/src/cli.js` in a package named `@anhlp/alp`, using `<package>/dist/alpd.js`. If alpd is already running, no path is needed. Verified with a packed plugin whose build-time path does not exist: Paseo reports a clear error until alpd has run once, then starts alpd by itself and the Paseo e2e passes. The CLI package is `@anhlp/alp`, with the `alp` command. The npm name `alp` belongs to another author, and npm refused `alp-cli` as too similar to `gulp-cli` and `cp-cli`. A packed package installed into a fresh prefix starts alpd and is found on PATH. Both READMEs ask users to install it and run `alp daemon start` once.

**CLI.** `alp ps --all` includes closed and errored sessions with their last error. `alp send` to a closed or errored root resumes it first. `alp attach` to a closed session prints its stored timeline and exits.

## 16. Phase C as built (2026-10-09)

Goal: several writing assignments at once without sharing a checkout, and no two trees writing the same checkout through assignments.

**Worktrees.** `alp_delegate` takes `isolation: 'shared' | 'worktree'` (default `shared`); `worktree` requires `mode: 'workspace-write'` and a git repository with a commit. alpd creates `git worktree add -b alp/<assignmentId> $ALP_HOME/worktrees/<assignmentId> <base>`, where `base` is `git stash create` of the requester's checkout (HEAD plus uncommitted tracked changes) or HEAD. The child runs with `SessionSpec.workdir` set to the matching directory in the worktree: ALP files are still resolved from the project (`cwd`), while the native harness starts there and Codex's `writableRoots` is that directory. Peers that are read-only or isolated run in parallel within `maxPeers`; a shared writer still runs alone among its requester's assignments.

**Results and merge.** When the assignment ends (any state), alpd commits the worktree (`--no-verify`, identity `ALP`) and adds `worktree: { branch, base, commit, files, stat }` to the result. With no changes, the worktree and branch are removed. Otherwise the requester gets `alp_merge { assignmentId }` and `alp_discard { assignmentId }`. Merge needs `workspace-write`, no running shared writer of its own, and no foreign lease on its checkout. It tries `git apply` of `base..commit` to the working tree, then falls back to a per-file three-way merge (`git merge-file`) against the current files. It never touches the index and never commits. Result: `{ status: 'applied' | 'conflicts' | 'empty', files, conflicts? }`; a clean merge deletes the branch, a conflicted one keeps it.

**Leases.** The runtime keeps one write lease per checkout (git top level, or the directory outside git) for shared writer assignments, across all trees in alpd. An assignment nested under the holder (lead holding it, delegating a shared peer) shares it. A foreign holder makes `alp_delegate` fail with a hint to wait or use a worktree. Leases are in memory: they end with their assignment and with the daemon. Root sessions are not leased, because they act for the user.

**Never losing work.** Closing a requester removes its unmerged worktrees but keeps their branches (`worktree.kept` in the run log). On start, alpd commits whatever a crash left in `$ALP_HOME/worktrees` to the worktree's branch and removes the directory. Run log events: `worktree.created`, `worktree.merged`, `worktree.discarded`, `worktree.kept`.

**Not built.** Advisory file leases inside a shared checkout (parallel shared writers on disjoint paths); untracked files in the worktree base; isolation for agents other than peers running in parallel (any writing agent may use a worktree, but only peers run beside others); a CLI command to list kept branches (use `git branch --list 'alp/*'`).

**Evidence.** `test/worktree.test.js` covers parallel merge, conflicts, discard, the lease across trees, close and crash recovery, and non-git projects. `scripts/worktree-e2e.mjs` runs main with two real writing peers in parallel worktrees and merges both, passing on Codex and Claude.

## 17. Phase D as built (2026-10-09)

Goal: the user and main talk without main ending its turn, the user can reach any agent, and anyone can see what a tree is doing.

**Who talks to the user (user decision, 2026-10-09).** The user talks with main. Other agents do not talk to the user unless the user writes down to them first; the agent written to must let its requester know, which ALP does for it.

**Questions to the user.** `alp_ask` takes `to: 'parent' | 'user'` and, for the user, up to ten `options`. Every session now gets `alp_ask`; a root asks the user (it has no requester). An assignment asks its requester; `to: 'user'` is refused ("Only main talks to the user") until the user has written to that assignment. One question per session at a time. The runtime emits `question { id, sessionId, rootId, agent, body, options?, askedAt }` on the asking session and later `question.resolved { questionId, outcome: answered | dismissed | timeout | canceled, answer? }`. It logs `human.question` and `human.answer` to the run log. The tool result is `{ status: 'answered', from: 'user', answer }`, `{ status: 'dismissed', reason? }` or `{ status: 'unanswered' }`. The wait is bounded by `userAskTimeoutMs` (default 30 minutes) and does not count toward the assignment watchdog. A question ends with its turn or session (`canceled`).

**Answering.** `runtime.answer(id, { text } | { dismiss, reason })`. alpd adds `question.list { projectRoot? }` and `question.answer { questionId, text? , dismiss?, reason? }`, where the id may be a unique prefix. Questions are not replayed from stored logs: on attach, alpd announces the questions still waiting in that tree. The Paseo plugin negotiates the `permission` capability and shows each question as a `kind: 'question'` permission request on the root agent ("<agent> asks you", the options, free text allowed), because subagents in Paseo cannot take input. `allow` with `updatedInput.answers.Answer` answers, and `deny` dismisses, with its message as the reason. Per-tool approval (`permission.tool_policy`) stays unsupported.

**Mail from the user.** `runtime.message(sessionId, text)` and `session.message` post a `note` sent by `user` to any live session, and the mail header tells the agent to follow it as a user instruction. For an assignment it also does three things. It marks the session as opened to the user. It posts a note to the requester, from the assignment and prefixed `[ALP, on behalf of <agent>]`: "The user wrote to me directly: …". And the header tells the agent that its requester knows and that its handoff must say what the user asked and what it did. Each later answer the opened assignment gets from the user is reported to the requester the same way. `alp send` uses this for assignment sessions; roots are still prompted.

**Status.** `runtime.status(sessionId)` and `session.status` return the live tree (`TreeStatus`). This includes sessions with `state` (`running`, `waiting`, `waiting_parent`, `waiting_user`, `idle`), `idleMs`, `workdir` and `unreadMail`, plus assignments with requester, isolation, worktree and idle time, open questions, unmerged worktrees and leases. `session.log` returns the tree's run log. `daemon.status` counts open questions.

**CLI.** `alp top [session] [--once]` (a dashboard refreshed every second; one frame when not a terminal), `alp questions`, `alp answer`, `alp log`, and question lines in the `run`/`attach`/`send` stream with answers read from the terminal. In `--json` the events are printed as they are.

**Not built.** A web dashboard; notifications outside Paseo and the terminal; persisting open questions across a daemon restart (the asking turn ends with the daemon).

**Next: a group channel per project (user direction, 2026-10-09).** Built in §18.

**Evidence.** `test/human.test.js` covers the runtime, alpd and the Paseo bridge, including the refusal and the notes to the requester. `scripts/human-e2e.mjs` has three modes. In `cli` and `paseo`, main asks the user for a code word, answered with `alp answer` by prefix or with Paseo's question prompt. In `relay`, the user writes the word to a running peer with `alp send`, main is told, and the peer returns it. All pass on Codex and Claude.

## 18. The project board as built (2026-10-09)

Goal: agents working independently on one project, in one tree or in several, neither edit each other's files nor pursue different ideas (D15).

**The board.** Each project root has one board that every agent working on it shares, across trees and clients. A pin is `{ id, project, kind, body, paths?, agent, sessionId, rootId, at, released? }` with one of three kinds:

- `claim`: paths the agent is about to change, project-relative files or directories (`.` is the whole project). Paths outside the project are refused.
- `decision`: the approach others should follow.
- `finding`: something others need to know.

**Tools.** Every session gets three tools:

- `alp_pin { kind, body, paths? }`. A claim is refused when another agent holds a live claim on overlapping paths; the error lists each holder (pin id, agent, session, paths, body). Claims are shared within one line of delegation: a requester's claim covers its assignments, and theirs covers it. A read-only session cannot claim.
- `alp_board { kinds?, limit? }` returns the live claims and the most recent decisions and findings (30 by default).
- `alp_unpin { pinId }` takes down the caller's own pin.

A session's claims end with the session; decisions and findings stay.

**Distribution.** A new assignment's prompt ends with a digest of the board: live claims first, then the most recent decisions and findings, capped at 3,000 characters. A new pin goes as passive `board` mail to every other session on the project whose turn is running, and is steered into that turn. Waiters (`alp_wait`, a waiting delegate) never take board mail. Idle sessions are not woken; they read the board with `alp_board` or in their next assignment. The instructions tell every agent to read the board and claim paths before changing files, to leave paths claimed by others alone and ask its requester instead, and to treat board mail as information that never overrides its requester.

**Storage.** `boardDir` (alpd: `$ALP_HOME/boards`) holds one JSONL file per project, named by a hash of the project root, with `{pin}` and `{release, at}` lines. On first use after a restart, claims are marked released (their sessions ended with the daemon), the board is pruned to the 200 most recent decisions and findings, and the file is compacted. Without `boardDir` the board lives in memory.

**Observability.** The runtime emits `pin` and `unpin { pinId, reason: unpinned | session_ended }` on the pinning session, and logs `board.pin` and `board.unpin` to the run log. `runtime.board(projectRoot)` and alpd's `board.list { projectRoot }` return the live pins. `TreeStatus.claims` lists the tree's claims. The CLI adds `alp board [--project DIR] [--json]`, shows claims in `alp top`, and shows pins and releases in `alp log`. The Paseo plugin ignores pin events.

**Not built (next phase).** A channel for pinning tasks, and showing the board in Paseo.

**Evidence.** `test/board.test.js` covers conflicts across trees and the lineage exemption, delivery into running turns, the digest in assignments, release on close, validation, persistence across a restart, and `board.list`. `scripts/board-e2e.mjs` runs two independent roots on one project at once. Alice claims `src/auth` and pins a decision. Bob starts later, is refused an overlapping claim, and reports the decision from the board. Bob's finding reaches Alice's running turn. The script passes on Codex and Claude.

## 19. Profiles, supervisor and lessons as built (2026-10-09)

Goal: two fixed profiles the user picks from, a main that learns from its process mistakes, and skills the user owns (D16).

**Profiles.** `workflow.mode` is `pho` or `cafe`; `smart` and `supervised` map to them wherever a profile is read (settings, a selection, a restored snapshot). Graphs: `pho` = main → peer, oracle, reviewer; `cafe` = main → lead, oracle, reviewer and lead → peer, oracle, reviewer. The workflow snapshot is `{ mode, maxPeers, supervisor }`; `supervisor` comes from `workflow.supervisor` (default true) and is false for `custom`. The Paseo plugin lists the profiles as its models (no thinking options, default `pho`, default mode `full-access`), maps the selected model to the profile, drops the model and thinking Paseo sends, and refuses model, thinking or profile changes on an open session. The CLI adds `alp run --profile`.

**Models and modes.** Main with no `runtime.provider` or `runtime.model` and no requested model runs on `claude:claude-opus-5-5` at `high`, also when resumed on that model. Modes are `read-only`, `workspace-write` and `full-access` (ranked in that order); main's default is `full-access`, other roots default to `read-only`. `full-access` maps to Claude `bypassPermissions` (sessions start with `allowDangerouslySkipPermissions` so a live change can switch to it) and to Codex `danger-full-access` / `dangerFullAccess`. A child's mode, and a live change, never exceed the requester's. Merges and worktree isolation need a writing mode. Oracle must use `claude:claude-fable-5-1` or `codex:gpt-6-astra` (effort `high` by default, `modelReason` optional), and oracles run beside other running assignments.

**Supervisor.** `open` of a root main whose snapshot has `supervisor`, on a host that shows child sessions, queues `openSupervisor` after the open returns. The supervisor is a child session (`role: supervisor`, `toolCallId: supervisor-<root>`) of agent `supervisor` on `claude:claude-sonnet-4-6` at `medium`, read-only, with `alp_send` and `alp_board` only; it is kept in the root's `supervisor` field, not its children or assignments, so it uses no peer slot, has no watchdog, and survives interrupts. Its failure to start is logged as `supervisor.failed`. It closes with the root. `RuntimeOptions.supervisor: false` disables supervisors for a host.

**Journal and review.** While a root has a supervisor, its journal collects: the user's prompts and steers; main's tool calls (other than `alp_delegate`) and shell commands once finished; run-log entries of the tree for assignments started and finished (with handoff), mail other than results and board mail, questions to the user and answers, board pins and worktree events, leaving out the supervisor's own; main's final message and how the turn ended. When main's turn ends, `review` sends the journal as one prompt (lines clipped to 400 characters, the digest to 12,000) to the supervisor, queued behind client operations. While the supervisor is running a review, the next journal waits and is sent when it ends. `reviewPending` keeps the root busy from the end of the turn until the review starts, so an idle-tree reap cannot close it in between; a running review keeps it busy too.

**Deferred mail.** The supervisor's `alp_send` to `parent` posts a note with `defer`. Deferred mail is never steered into a running turn and never taken by `alp_wait` or a waiting delegate. It wakes an idle main, or rides on main's next user turn. A turn woken only by deferred mail (`supervisorWake`) is not reviewed: its journal is dropped, so the two cannot loop.

**Lessons.** A supervised main gets `alp_lesson { scope: project | user, lesson }` (at most 600 characters). It appends `- <date>: <rule>` to `.alp/lessons.md` or `<libraryDir>/lessons.md`, creating the file with a header; writes to one file run in order, and the run log records `lesson`. `scope: user` is refused without `libraryDir`. `resolveSession` adds both files (the newest 6,000 characters of each) to the instructions of main and the supervisor when the snapshot has `supervisor`.

**Skill library.** `RuntimeOptions.libraryDir` (alpd: `$ALP_HOME`) holds `skills/`, `role-skills.json` and `library.json`. `ensureLibrary` seeds it once per process from the templates: a shipped file ALP never wrote is created unless a file of that name exists; a file is replaced only while its hash equals what ALP last wrote; deleted and edited files are left alone; `library.json` records the hashes. `resolveAgent(root, { agent, library })` takes the agent's skills from `role-skills.json` (names that have a `SKILL.md`), then lets the agent's own `skills/<name>` replace one of the same name. `initProject` no longer copies skills and adds the `supervisor` agent; `alp init` and `alp upgrade` seed the library; `upgrade` archives project skill copies identical to the shipped ones.

**Approval.** `confirm` asks the user through `askUser` with the options Approve and Reject and returns approved only for an approving answer (`approve`, `yes`, `ok`, `đồng ý`, `duyệt`, …, case-insensitive). Another answer is returned as feedback; a dismissal, a timeout or the end of the turn approves nothing. One question per session waits at a time.

**Skills from lessons (D17).** A supervised main with a `libraryDir` gets `alp_skill { name, description, body, roles, lessons?, replace? }`. `roles` must name starter roles or agents of the project. The question shows the file, roles, moved lessons and the full `SKILL.md` (frontmatter `name` and a quoted `description`). On approval ALP writes the file, merges the name into each role's list in `role-skills.json` (re-read after the answer), removes the lessons whose text matches exactly from both lessons files, and logs `skill`. An existing name needs `replace`. The supervisor's instructions name both lessons files and tell it to suggest a skill for three or more lessons on one theme or a recurring one.

**Issues (D17).** Root main gets `alp_issue { action: search | create | comment, target: project | alp, … }`. `project` resolves `owner/name` from the `origin` remote (GitHub HTTPS or SSH URLs only); `alp` is `phucanh08/alp-paseo`. `search` runs `gh issue list --state all --limit 10 --search … --json number,title,state,url` without asking. `create` and `comment` ask with the repository, action, title, labels and body, then run `gh issue create` or `gh issue comment` with the body on standard input and a footer naming ALP and the user's approval, and log `issue` with the URL. `RuntimeOptions.github` replaces the `gh` runner (tests); `ALP_GH_BIN` selects the executable. Lessons, skills and issues also appear in the supervisor's digest.

**Evidence.** `test/supervisor.test.js` covers the supervisor's start and config, the digest, busy until the review, deferred notes, no review of an answering turn, lessons in both scopes and in later sessions, a digest waiting behind a running review, the settings that disable it, skills scoped to chosen roles and saved only after approval (rejection with feedback, dismissal, unknown roles, lessons moved, later sessions listing it), and issues searched, created and commented only after approval, refused to assignments and to non-GitHub remotes. `test/skills.test.js` covers seeding, user assignments, project overrides, updates that keep edited and deleted files, and upgrade archiving. `test/workflow.test.js` and `test/paseo.test.js` cover profiles, old names, model defaults, full access, and the supervisor child in Paseo. `test/team.test.js` covers two oracles in parallel; `test/supervisor.test.js` also covers a project that gets only the supervisor's files. On 2026-10-09 `alp run` with real Claude models, in an isolated `ALP_HOME`, showed main on `claude-opus-5-5` with full access and its supervisor on `claude-sonnet-4-6`. In Cafe, main edited a file itself at the user's request. The supervisor asked why the logic change had no reviewer. Main was woken, recorded a user-scope lesson, ran reviewer, and that turn was not reviewed again. The first live run exposed that `alp run` checked for an idle tree only when main's turn ended, so it waited forever after the review; it now checks again whenever any turn in the tree ends. The Paseo-driven scripts (`scripts/workflow-e2e.mjs` and others) were updated for the profiles but not rerun.

## 20. Tasks as built, step 1 (2026-10-09)

Goal: the project's task graph, with an ordered set of work that is ready and an atomic start, shared by the user and main (D18).

**Storage.** `src/core/tasks.js` (shipped with the CLI, bundled into alpd) owns `.alp/tasks`. A task file holds `id, rev, title, description, type, priority, status, labels, paths, parent, blockedBy, discoveredFrom, related, assignee, handoff, createdBy, createdAt, updatedAt, closed, log` (the newest 50 events). Each write runs as follows:
- Writes in one process queue per directory.
- The writer then takes the lock directory `.alp/tasks/.lock`. A lock older than 10 s is cleared. The writer gives up after 5 s with `TASKS_LOCKED`.
- Under the lock, it re-reads every task, checks the change, bumps `rev`, and writes `<id>.json` through a temporary file and a rename. A change that leaves the task unchanged writes nothing.
- An optional `ifRev` refuses the write with `TASK_CHANGED`.

The first write creates the directory and `.alp/tasks/.gitignore` (`.lock`, `*.tmp`). `loadTasks` returns `{ tasks, errors }`: it skips files that do not parse, whose id differs from their name, or whose status is unknown, and fills missing fields with defaults.

**Ids.** A top-level id is `t-` plus the first 4 hex digits of sha256(title, time, random), growing to 12 digits on a collision. A task created with a parent gets `<parent>.<n>`, the next free number.

**Graph.**
- `blockersOf` lists the unclosed `blockedBy` of the task and of each ancestor; tasks that are missing block nothing.
- `readyTasks` lists open non-epic tasks with no blockers, sorted by priority, then creation time.
- `linkTask` applies removals, then additions (`blockedBy`, `related`, `parent`). It refuses an edge that would close a cycle over `blockedBy` and parent edges, naming the chain. It also refuses blockers that are the task's parent or an ancestor, a second parent, and a closed parent.

**Lifecycle.**
- `startTask` takes an open, ready task, or one in `review` back for rework, and sets `assignee`. It refuses epics, tasks in progress (naming the holder), closed tasks, and blocked tasks (naming the blockers). The check and the write happen under one lock.
- `closeTask` takes a reason (`done`, `wontfix`, `duplicate` or `superseded`) and an optional summary, and clears `assignee`. `done` is refused while children are open.
- `reopenTask` puts any task that is not open back to open. It is refused while the parent is closed.
- `updateTask` changes fields, adds an optional note to the log, and refuses turning a task that is not open into an epic.

**Tool.** `alp_task { action, … }` is offered per role:
- Root main: `create`, `update`, `link`, `start`, `close`, `reopen`, `show`, `list`, `ready`.
- Lead, peer and custom agents: `show`, `ready`.
- Oracle and reviewer: `show`.
- The supervisor: `show`, `list`.

A role's schema lists only its actions and fields, and the Claude transport narrows its zod shape to that definition. The runtime checks the role again and refuses fields an action does not take. A change is logged as `task` with the action, id, title, new status and summary or note, and appears in the supervisor's digest. Main's instructions say when to create, start and close tasks. Other agents' instructions say to report work they find in their handoff. The templates say the same.

**CLI.** `alp tasks [ready] [--all] [--status S] [--label L] [--json]`, and `alp task add|show|edit|close|reopen|dep add|dep rm` with `--project DIR`. The CLI writes the files directly as `user` and needs no daemon. It requires an `.alp` directory and reports unreadable files on stderr.

Step 2 is in §21.

**Evidence.** `test/tasks.test.js` covers:
- Ids and children, validation, `.gitignore`, and no leftover files.
- The ready list, blocked epics, list order and filters.
- Cycles, self references and ancestor blockers, and one call that removes and adds.
- Two starts at once with exactly one winning, `ifRev`, the close, reopen and epic rules, and unreadable files.
- A stale lock.
- The CLI, end to end.
- Five CLI processes adding children of one epic at once, which get distinct ids.
- `alp_task` for main, a peer and the supervisor, including the digest lines. On 2026-10-09 there was a live `alp run --profile pho` with real Claude models, in an isolated `ALP_HOME`, on three tasks the user added with the CLI. Main ran `alp_task ready` and picked the P1 task. It started the task, claimed `greet.js` and wrote it. It verified the file with node, and reviewer accepted it. Main then closed the task with a summary of the evidence. That left the task's blocked follow-up ready. The supervisor judged the turn sound.

## 21. Tasks in delegation as built, step 2 (2026-10-09)

Goal: tasks move with the work: main gives one to an assignment, the assignment's handoff brings it back for acceptance, and main, the supervisor and Paseo see where every task stands (D18).

**Delegating a task.** Root main's `alp_delegate` schema adds `taskId` (lead's does not). Before any check that must not yield:
- `runDelegation` refuses a `taskId` from anyone but root main, and to read-only advisors.
- It reloads the tasks and refuses a missing task, or one that `startRefusal` rejects: an epic, in progress (naming the holder), closed, or blocked (naming the blockers).
- For a writing assignment of a task with `paths`, it refuses when `claimConflicts` finds claims outside the requester's line of delegation, returning them.

Then, inside the start's `try`:
- `startTask` takes the task for `{ agent, assignment: childId }` under the task lock, sets `assignment.taskId`, and logs `task` / `delegate`.
- Once the child session exists, a writing assignment pins a claim on the task's paths as the child (`task` set, body `Task <id>: <title>`). A claim that appeared meanwhile fails the delegation, which releases the task.
- The brief begins with `taskBrief`: id, type, priority, title, description, paths (and that ALP claimed them), and that the handoff moves the task to review and discovered work goes under `discovered`.
- `assignment.started` carries `taskId`.

**Claims.** Pins have an optional `task`. A claim made with `alp_pin` takes the task of the nearest assignment in the session's lineage, so lead's peers' claims carry lead's task. `renderPin`, `alp top` and `alp log` show it. `claimConflicts` and `addPin` are shared by `alp_pin` and delegation.

**Settling.** `finishAssignment` calls `settleTask` for an assignment with a task. It first releases the assignment's claims, even if its session never opened. Then:
- With a `complete` or `partial` handoff and the state `completed`, `submitTask` moves the task to `review`. The task keeps the handoff's fields with its agent and time.
- Otherwise `releaseTask` opens the task again, clears `assignee`, keeps any handoff, and logs the reason (`handoff blocked`, `assignment canceled without a handoff`, …).
- Both act only while the task is still `in_progress` for that assignment, so a task the user or main moved meanwhile is left alone.
- The result mail to the requester gets `task: { id, status, next? }`, and the run log gets `task` / `submit` or `release`.
- `startTask` also takes a task in `review` back for rework (logged `reworked`).

**Handoff.** `discovered` joins the handoff lists. `assignment.finished` lines in the supervisor's digest append the discovered items.

**Main's turn context.** On every turn of root main that is not a steer, `startPrompt` adds `taskDigest` after the catalog snapshot. It lists tasks in review (with agent and outcome), then in progress (with assignee), then up to 8 ready tasks, then counts of more ready, blocked and unreadable tasks, in at most 2000 characters. It is empty when no task is open and no file is unreadable.

**Todo list.** A root records the tasks its tree created, started, delegated, changed, submitted or released (`touchTask`). When a root's turn ends, `showTasks` emits a timeline item `{ kind: 'todo', id, items: [{ id, text, status }] }` if the list changed since it was last shown. Status maps open to pending, `in_progress` and `review` to in progress ("awaiting acceptance" in the text), and closed to completed. The Paseo provider maps the item to Paseo's `todo` item (with `completed`), and `alp run` prints it.

**Instructions.** Main's instructions and AGENT.md cover `taskId`, accepting or reworking a task in review, and recording discovered work. Peer and lead file discovered work under `discovered`. The supervisor's AGENT.md adds the task checks: a close without verification, dropped discovered work, a task left in review, work delegated without its `taskId`, a blocker removed just to start a task, and tasks for work finished in the same turn.

**Evidence.** `test/tasks.test.js` adds tests for:
- `submitTask` and `releaseTask` acting only for the holding assignment, and rework.
- The digest's order, limits and counts.
- Delegating with `taskId`:
  - the refusals
  - the brief, the start and the claim
  - a second delegation refused
  - a peer's claim carrying the task
  - a handoff moving the task to review, with the result's `task` and the claim released
  - closing to accept
  - the todo list shown once
  - the digest lines
- Blocked, missing, partial and complete handoffs, and rework.
- Claims from another tree refusing a delegation with nothing changed.
- Cafe: lead's schema without `taskId`, its refusal, and its peer's claim carrying the task.

`test/paseo.test.js` checks a todo item through Paseo's provider event schema. On 2026-10-09 two live `alp run` sessions used real Claude models in an isolated `ALP_HOME`:
- **Phở:** main passed `taskId` to a peer on Sonnet 4.6. ALP claimed `greet.js` for the peer. The peer's complete handoff moved the task to review. Main verified the change and closed the task, and the run printed the todo list. The supervisor checked the task lifecycle and judged the turn sound.
- **Cafe, an epic with two children:** main gave the ready child to lead with `taskId`. ALP pinned lead's claim for that task on its two paths, and lead had a peer implement it. Lead's handoff moved the task to review, and main closed it after re-running the tests. The second child, which the first had blocked, then became ready. The supervisor judged the turn sound.

## 22. Gates, compaction and the Tasks panel as built, step 3 (2026-10-09)

Goal: tasks can wait on the user, a time or GitHub; old tasks stay small; and the user sees and acts on tasks in Paseo (D18).

**Gates.** A task has `gates: [{ id: g<n>, kind, note?, until?, repo?, ref?, at, by, resolved? }]`, with kinds `human`, `timer`, `gh:pr` and `gh:run`.
- `addGate` validates each kind: a human gate needs a note; a timer takes an ISO time or `+Nm`, `+Nh` or `+Nd`; GitHub refs take `N` or `owner/repo#N`. A task has at most 10 open gates, and a closed task takes none.
- `gateOpen` treats a gate as open until it is resolved, or for a timer, until `until` passes; a timer writes nothing.
- `gatesOf` lists the open gates of a task and of its ancestors. `readyTasks`, `startRefusal`, `summarize` and `taskDigest` count them; the digest lists tasks that only gates hold back.
- `resolveGate(id, gate, { by, note?, remove? })` clears a gate (logged `gate cleared`) or removes it (`ungated`).
- `checkGates(root, gh)` runs `gh pr view N --json state` and `gh run view N --json status,conclusion` (with `-R repo`) for the open GitHub gates of tasks not closed. It clears a merged pull request or a successful run as `github`, and returns `{ cleared, pending, errors }`.

`alp_task` for main adds actions `gate { id, kind, note?, until?, ref? }` and `clear { id, gate, note? }`. `clear` refuses human gates. Before the task digest of each of root main's turns, `checkGatesOften` runs `checkGates` with `RuntimeOptions.github ?? gh`. It runs only when a GitHub gate is open, and at most once a minute per project.

The CLI adds:
- `alp task gate add <id> --human|--timer|--pr|--run`
- `alp task gate clear|rm <id> <gate> [-m]`
- `alp tasks gates [--json]`, which checks the GitHub gates (`ALP_GH_BIN` selects `gh`) and lists the open ones

`alp tasks` and `alp task show` print gates.

**Compaction.** `compactTasks(root, { days = 30, dryRun }, by)` runs under the task lock. For each closed task closed at least `days` ago and not yet compacted, it:
- clips the description and the handoff summary to 300 characters, and drops the handoff's other fields;
- keeps only each gate's id, kind and resolution;
- keeps only the `created` and last `closed` log entries;
- sets `compacted: { at, by, chars }`.

A task is written only when it gets smaller. `alp tasks compact [--days N] [--dry-run]` runs it as `user`.

**Paseo panel.** The plugin now requires Paseo `>=0.11.1 <0.12.0`, in both `paseo-plugin.json` and the SDK peer dependency, and ships `index.client.tsx`, `client/` and `shared/`. Paseo compiles the client from source and supplies React, React Native, zod and the SDK.
- `shared/tasks.ts` holds the RPC contracts `alp.tasks.list { directory }`, `alp.tasks.add { directory, title, priority? }` and `alp.tasks.change { directory, id, action: close | reopen | approve, gate?, note? }`, the `TaskRow` schema, and `boardSections`, which groups rows for the panel.
- `server/tasks.ts` registers the handlers with `server.handle`. They find the nearest directory with `.alp` and call the task core as `user`; `@getpaseo/plugin` is external to the server bundle.
- `client/tasks-panel.tsx` is the panel. `TasksPanel` reads the workspace's `directory` (falling back to `projectRootPath`), polls `alp.tasks.list` every 5 s, and turns actions into RPCs with toasts. `TaskBoard` renders from data alone.
- `index.client.tsx` registers the workspace panel `alp-tasks` ("Tasks", icon `ListTodo`, which the app's lucide set provides) and a command center item.
- `npm run check` also type-checks the client against React 19.1 and React Native 0.81.5 types, with no DOM types.

**Evidence.**
- `test/tasks.test.js` adds:
  - gates: validation; human, timer and GitHub gates holding tasks back; an epic's gate holding back its children; the digest; clearing and removing gates; `checkGates` with a fake `gh`
  - compaction: the cutoff, a dry run, what is kept, and no second compaction
  - the runtime: main adding gates, refused for a human gate, and GitHub gates cleared at most once a minute at turn start
  - the CLI: gates and compaction against a fake `gh`
- `test/panel.test.js`:
  - bundles the client entry the way Paseo's compiler does, and checks that it imports only host modules and only files from `client/` and `shared/`
  - registers the panel and its command
  - renders `TaskBoard` with React DOM's static renderer, React Native stubbed, to check the section order and actions and the empty states
  - drives the three RPCs through their contracts against a real project
- `test/paseo.test.js` checks that the plugin registers the RPCs. On 2026-10-09 the panel was checked live. The plugin was installed into an isolated Paseo 0.11.1 daemon (its own home, port 6799), which compiled and loaded the client entry with no import-boundary errors. The Desktop app's web build was served locally and connected to that daemon. In a workspace of a demo ALP project, "Tasks" appeared in the new-tab menu, and the panel showed real data in this order: the human gate with Approve, the task in review with its handoff, ready, blocked, epics, and a folded closed list. Approve cleared the gate as `user`, which made the task ready. A title typed into the panel was added as a `user` task. The same day, `alp tasks gates` cleared real `gh:pr` gates on merged PRs #5 and #6 and a `gh:run` gate on a successful CI run.


## 23. beads interchange and formulas as built, step 4 (2026-10-09)

Goal: tasks move to and from beads, and a workflow the project repeats is a template that main or the user pours into tasks (D18).

**Batch writes.** `batch(root, work, { dryRun })` in the task core loads every task under the task lock and hands `work` an API:
- `add(input, by, { id?, createdAt?, event?, details?, extra? })` creates a task in memory, numbering children under their parent.
- `touch(task, by?, event?, details?)` marks a task changed.
- `link(task, relation, other)` adds a relation, or returns why not (unknown task, self reference, cycle).

After `work` returns, the batch writes created tasks at rev 1 and changed ones at rev + 1, through temporary files, unless `dryRun`. An error thrown inside `work` writes nothing. Import and pour both use it, so either all of their tasks appear or none do.

**beads JSONL.** `src/core/beads.js`:
- `exportBeads(tasks)` gives one issue per task, sorted by id, with `id`, `title`, `description`, `status`, `priority`, `issue_type`, `assignee`, `labels`, `dependencies [{ issue_id, depends_on_id, type }]`, `created_at`, `created_by`, `updated_at`, `closed_at`, `close_reason`, `defer_until` (the latest open timer), and `external_ref` / `source_system`. Relations map as `blockedBy` to `blocks`, `parent` to `parent-child`, and `discoveredFrom` and `related` to their own names. A task in `review` is exported `in_progress`. Review, paths, gates, the handoff, the close record, compaction, and formula details ride in `metadata.alp`.
- `parseJsonl(text)` keeps the line number of each record and each line that does not parse.
- `importBeads(root, records, { dryRun, by })` upserts. It skips records whose `_type` is not `issue`, records without a title or id, tombstones, and ephemeral issues. It matches an ALP task id, or a task whose `external` is that beads id; any other issue gets a new ALP id, parents first so children are numbered under them. `design`, `acceptance_criteria` and `notes` join the description. Unknown types become `task` with a `beads:<type>` label. `closed` closes the task (by `beads` unless `metadata.alp.closed` says otherwise). `metadata.alp` restores review with its handoff. `in_progress` without that becomes `open` with a warning, since no ALP assignment holds it. A future `defer_until` becomes a timer gate, unless a timer within a second of it exists, because bd keeps whole seconds. `metadata` is read whether bd wrote an object or JSON text. Relations are linked after every issue has a task, and a missing target, an unknown dependency type, or a cycle is a warning. Nothing is deleted.

The CLI adds `alp tasks export [-o file]` and `alp tasks import [file] [--dry-run] [--json]`; the default file is `.beads/issues.jsonl`.

**Formulas.** `src/core/formulas.js`:
- Files are `<name>.formula.toml` or `.json`, searched in `.alp/formulas`, `$ALP_HOME/formulas`, then `.beads/formulas`; the first of a name wins. `listFormulas` reports a file that does not load with its error, and `findFormula` refuses it.
- The core does not parse TOML itself, since it imports only Node built-ins: callers pass `{ toml }`, and the CLI and runtime pass `smol-toml`'s `parse` (pinned at 1.9.0). Without it, TOML files report that they need a parser.
- `validateFormula` takes `formula`, optional `title`, `description`, `version` and `priority`, `vars { name: { description?, required?, default? } }`, and 1–50 `steps [{ id, title, type?, needs?, description?, priority?, labels?, paths? }]`. It refuses duplicate step ids, unknown `needs`, and cycles.
- `pourFormula(root, formula, vars, by, { dryRun, parent })` refuses unknown variables and missing required ones, then fills `{{var}}` in titles and descriptions. In one batch it creates an epic (the formula title, or `name (k=v, …)`; label `formula:<name>`; `formula: { name, version, vars }`) and a child per step in step order, with `step: { formula, id }` and `needs` as `blockedBy`. A `human` step is a `task` with `step.human` and a human gate `Your step: <title>`.
- `resolveGate` closes a `step.human` task when its last open gate clears, with the summary `Approved by <who>[: note]`.

`alp_task` for main adds `formulas`, which lists formulas with their vars and steps and the directories searched, and `pour { formula, vars?, parent? }`, which returns the epic and its steps. Main's instructions say to check formulas for a workflow the project repeats. The CLI adds `alp formula list`, `show <name>` and `pour <name> [--var k=v]… [--parent ID] [--dry-run] [--json]`, run as `user`.

**Evidence.**
- `test/beads.test.js`:
  - export, then import into a second project, gives the same tasks back, and a second import changes nothing, including the file as bd rewrites it (whole-second times, `_type`, metadata as text)
  - a beads-native file: new ids with children under parents, description sections, skipped records, warnings, a timer from `defer_until`, and an upsert that closes a task
  - formulas: lookup order, validation, variables, a dry run, the poured epic and steps, and a human step closed by the user's approval
  - main's `formulas` and `pour` actions and the CLI `formula`, `tasks export` and `tasks import`
- On 2026-10-09, with a release formula in a fresh project, the prompt "set up the tracked work the way this project does releases" made main on Phở, then on Cafe, list the formulas and pour `release` with the right version. Each run reported the step ids and the human step, and the supervisor found both turns sound.
- The same day, beads 1.3.1 (`@beads/bd`, installed in a scratch directory with its own HOME) exported an epic with children, a `blocks` dependency, an in-progress task with a design, and a closed bug. `alp tasks import` took them with the parent numbering, blocker, description and close reason. The ALP export went into `bd import` with parents, blockers, the deferral and `metadata.alp` intact, and bd's own export of that imported back with nothing to change.

## 24. Permission profiles as built, step 1 (2026-10-09)

Goal: what an agent may do is settings, not a fixed list. A reviewer can run the tests, and agents added later get the permissions the user gives them (D19).

**Probes before building** (2026-10-09, on macOS):
- Claude Agent SDK:
  - `allowedTools` rules run without calling `canUseTool`. `disallowedTools` rules are refused in `default`, `acceptEdits` and `bypassPermissions`. A compound command (`git status && touch b`) is refused when a deny rule covers any part of it.
  - Claude also runs read-only commands such as `ls` without asking in `default`.
  - Its `sandbox` setting with `filesystem.denyWrite` on the project blocks writes there while the temp directory stays writable.
- Codex 0.160.1 app-server:
  - With `approvalPolicy: 'untrusted'` it asks before every command, and a command ALP accepts runs outside the sandbox, even in a read-only session.
  - With `on-request` it runs commands inside the sandbox without asking. It asks only before leaving the sandbox, and a declined request never runs.
  - `workspaceWrite` always lets the session write its cwd, whatever `writableRoots` says.
  - Execpolicy rules load only from files (`~/.codex/rules`, a project's `.codex/rules`), not per thread.

**Profiles.** `src/core/permissions.js` (Node built-ins only):
- `validatePermissions` checks `permissions: { profiles: { <name>: { base?, allow?, deny? } }, agents: { <agent>: <profile or base> } }` in a settings file:
  - A profile name has letters, digits, dots, dashes and underscores.
  - `base` is one of the three modes.
  - Each rule is `Tool` or `Tool(specifier)`, with at most 200 rules per list. The tool is one of Claude's tools or `mcp__<server>__<tool>`, so a misspelt name fails when the settings load.
  - `validateSettings` calls it, so a bad profile fails when the session resolves.
- `profileFor(projectRoot, home, agent)` merges the project's `.alp/settings.json` with `$ALP_HOME/settings.json`:
  - The project's agent entry wins over the user's.
  - A profile's base comes from the project when both files define it, and its rules are the union of both files.
  - A bare base name is a profile without rules.
  - Agents without an entry get `null` and keep today's behavior. `oracle`, `reviewer` and `supervisor` get a read-only profile, and a profile with another base is refused for them.
  - An entry that names an undefined profile is an error.
- `commandDecision(profile, command)`:
  - It unwraps a shell wrapper such as `/bin/zsh -lc '…'` and splits the line at `&&`, `||`, `;`, `|`, `&` and new lines, outside quotes.
  - It returns `deny` when a deny rule covers any part. It also returns `deny` when deny rules exist and the line cannot be split: command substitution, process substitution, or an unclosed quote.
  - It returns `allow` when allow rules cover every part and no part writes a file through a redirect; descriptor duplication and `/dev/null` are allowed.
  - Otherwise it returns `undefined`, and the mode decides.
  - Prefix rules (`:*`) match on a word boundary.

**Runtime.**
- `resolveSession` caps the requested mode at the profile's base and carries `permissions` on the mapping. `alp_delegate` computes a child's mode the same way, so worktree isolation and parallelism see the capped mode. `configureSession` refuses a mode above the base. `READ_ONLY_AGENTS` now only marks the roles that take no tasks.
- `permissionNote` adds a line to the session's instructions with its profile, mode and rules, when it has rules. `targetNote` tells a coordinator about the profiles of its delegation targets that cap or add rules, so its briefs match them. `alp_delegate` returns `mode` and `modeNote` when a profile capped the mode the coordinator asked for.
- Claude: `claudePermissions(sandbox, current, rules)` passes allow rules as `allowedTools` and appends deny rules to `disallowedTools`. Only Claude sessions get `permissions` in their native config.
- Codex:
  - `codexApproval` chooses `on-request` for a read-only or workspace-write session with Bash allow rules, `untrusted` for a full-access session with Bash deny rules, and `never` otherwise, at thread start and on every turn.
  - `CodexTransport` passes `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` to the session's handler. `approve` declines what a deny rule covers and accepts what an allow rule covers. For anything else it accepts only in full access.
  - File changes, network approvals and stdin writes have no rules yet.
  - Each decision is logged as `{ event: 'permission', agent, request, command?, decision, rule?, profile? }`.

The CLI adds `alp permissions [--json]` and `alp permissions check <agent> "<command>"`.

**Evidence.**
- `test/permissions.test.js` covers:
  - rule syntax and settings errors, including misspelt tools
  - the decision table: compound lines, redirects, substitutions, unclosed quotes, shell wrappers
  - merging the project and user files, the advisor rules, and mode caps in `resolveSession`
  - Claude's native rule options
  - the Codex approval policies and answers through a fake transport, with the run log
  - unchanged behavior without settings
  - the CLI
- Live on 2026-10-09, in a project whose `npm test` writes a file into the project and whose `reviewer` profile allows `Bash(npm test:*)`, Phở main asked for reviews:
  - The Claude reviewer (Sonnet 5.5, read-only) ran `npm test`. It passed and wrote its file.
  - The first Codex reviewer failed to start: Codex 0.160 has a `permissions` thread field of its own and rejected ALP's object. ALP now sends the profile only to Claude.
  - The next Codex reviewer ran `npm test` in its sandbox, failed on the write, and never asked to escalate. Main did not know the profile capped the reviewer at read-only, so its brief forbade retries.
  - Since then, a coordinator's instructions list its targets' profiles (`targetNote`), and `alp_delegate` reports `mode` and `modeNote` when a profile caps the child. Codex sessions are told to request escalation for allowed commands from the start.
  - Rerun with a fresh ALP home: the Codex reviewer (`gpt-6.1-sol`) asked to run `/bin/zsh -lc 'npm test'` outside the sandbox. ALP accepted it under the allow rule (logged), and the test wrote its file. The supervisor found the turn sound.

## 25. Asking the user for permissions as built, step 2 (2026-10-09)

Goal: an agent that needs more than its profile allows asks the user instead of failing, and the user can allow it for good (D19).

**Probe** (Claude Agent SDK, 2026-10-09):
- `settings.permissions.ask` rules make Claude call `canUseTool` in `default`, `acceptEdits` and `bypassPermissions` alike, with `decisionReasonType: 'rule'`.
- Other calls carry `suggestions`, Claude's proposed rule, for example `{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test *' }], behavior: 'allow' }`. Claude now writes prefixes as `npm test *`, and `covers` treats `cmd *` like `cmd:*`.

**Profiles.**
- A profile also takes `ask` rules and `beyondMode: 'refuse' | 'ask'`; the default is `refuse`. `profileFor` returns both.
- `commandDecision` returns `ask` when no deny rule covers the command and an ask rule covers any part. A line that cannot be split is `deny` when deny rules exist, and `ask` when only ask rules do.
- `addAllowRule(projectRoot, home, profile, rule)` validates the rule and adds it to the profile's `allow`. It writes the first settings file that defines the profile, the project's before the user's, through a temporary file.

**Claude.**
- `claudePermissions` puts ask rules into the query's `settings` (merged with `ultracode`).
- `canUseTool` asks ALP through the transport's request handler (`item/permission/request`) in two cases:
  - Claude reports an ask rule.
  - The session is read-only, the tool is not a reader, and the profile has `beyondMode: 'ask'`.
- For the second case it offers an always rule: Claude's suggestion, else `Bash(<command>)` or `<Tool>(<file_path>)`. An approved always returns `updatedPermissions` with that rule for the session.

**Codex.**
- `codexApproval` also chooses `on-request` for Bash ask rules or `beyondMode: 'ask'` in a sandboxed session, and `untrusted` for Bash ask rules with full access.
- `approve` asks the user for an ask rule, or for an uncovered request when the profile asks beyond its mode and the session is not full access. Its always rule is `Bash(<proposedExecpolicyAmendment> *)`, else the exact command.

**Asking.**
- `askPermission` queues one question per session. Before asking, it checks the profile again, so a command another question just allowed always is accepted without asking.
- It puts the question to the user with `askUser`:
  - The question names the agent, what it wants, and why it is asked.
  - The options are Allow once, Always allow and Deny; for ask rules, only Allow once and Deny.
  - The assignment's watchdog pauses while the question is open.
- Always allow writes the rule with `addAllowRule` and adds it to the in-memory profile of every open session of that project with the same profile.
- Allow once, or an approving word, allows the action. Anything else refuses it, and an unexpected answer is passed on as the reason. A timeout or dismissal also refuses.
- Each answer is logged as a `permission` event with `asked: true` and `always` when a rule was added.
- Coordinators' target notes and the session's own permission note mention ask rules and `beyondMode`. `alp permissions` shows them, and `check` can answer `ask`.

**Evidence.**
- `test/permissions.test.js` covers:
  - ask and `beyondMode` validation, and precedence
  - Claude's `canUseTool` for ask rules and beyond-mode requests, with suggestions and session rules
  - a Codex reviewer: always allow writing `Bash(npm install *)` to the project's settings and stopping later questions; an ask rule offering no always and declining on Deny; queued questions; another answer refusing; a Claude request through the same runtime path
  - `addAllowRule` writing to the user's file when only the user defines the profile
  - the CLI
- Live on 2026-10-09, with `reviewer` on a read-only profile with `beyondMode: 'ask'` and no rules:
  - A Claude reviewer's compound command containing `npm test` raised a question naming it, with Always allow offering `Bash(npm test *)`. Answering Always allow wrote that rule to `.alp/settings.json`, and the command ran.
  - In the next tree, a Codex reviewer's `npm test` was accepted by that rule without a question. Its `npm run lint` raised a question carrying Codex's own reason; Allow once ran it outside the sandbox and the script wrote its marker.
  - The supervisor had main record a lesson: warn the user before delegating work that will raise a permission prompt.

## 26. The sandbox floor and review copies as built, step 3 (2026-10-09)

Goal: what a profile's base promises holds at the OS level, and a reviewer can build and test without touching the tree it reviews (D19).

**Probes** (2026-10-09, macOS):
- Claude Agent SDK, with `sandbox: { enabled, autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: true, filesystem: { denyWrite: [cwd] } }`:
  - Bash goes through `canUseTool` and runs sandboxed. A write to the project fails with "Operation not permitted", while `node -e` runs.
  - A command an allow rule covers runs sandboxed. With `dangerouslyDisableSandbox` it runs outside without consulting `canUseTool`.
  - A command no rule covers that asks to leave reaches `canUseTool` with `dangerouslyDisableSandbox: true`.
  - The sandbox leaves an empty `.claude/.cc-writes` in the cwd.
- Codex 0.160.1: `workspaceWrite` lets a command write the directory it runs in (its `workdir`), even outside `writableRoots` and the thread's cwd. `readOnly` holds.

**The floor (Claude).**
- `claudeSandboxAvailable()` checks for `/usr/bin/sandbox-exec` on macOS, or `bwrap` and `socat` on PATH on Linux. `ALP_CLAUDE_SANDBOX=0` turns it off, and `=1` claims it for tests.
- `claudeFloor(mapping)` is `workspace-write` for a session in a copy, else the profile's base when it is read-only or workspace-write, else nothing. Main without a profile has none. Advisors' default read-only profile gives them a read-only floor.
- The runtime passes `floor` in the native config. `claudePermissions` turns it into the SDK `sandbox` option, denying writes to the workspace for a read-only floor.
- `canUseTool`:
  - lets sandboxed Bash run in a read-only session with a read-only floor;
  - treats `dangerouslyDisableSandbox` as leaving the floor: a deny rule refuses it, an allow rule allows it, an ask rule or `beyondMode: 'ask'` asks the user, and otherwise it is refused below full access;
  - refuses file tools outside the workspace and the temp directory.
- On close, the transport removes `.claude/.cc-writes` and `.claude` when the session created them and they are empty.
- `permissionNote` tells the session what its sandbox allows, and how to leave it when its profile can.

**Review copies.**
- A profile takes `workdir: 'copy'`, valid only with base read-only.
- `createCopy(workdir, root, id)` (in `workspace.ts`) adds a detached worktree at HEAD, applies `git diff --binary HEAD` there, copies untracked files that are not ignored, and links a top-level `node_modules`. `removeCopy` removes and prunes it. `reclaimCopies` removes leftovers at daemon start (`$ALP_HOME/copies`, `RuntimeOptions.copyDir`).
- `alp_delegate` creates the copy for a shared assignment whose profile asks for it. The child opens with `workdir` set to the copy, `copy: true` and `copyOf` set to the requester's workdir.
- `ResolvedSession.copy` keeps the ALP mode read-only (no claims, parallel like an advisor), while `nativeMode` runs the harness `workspace-write` in the copy: Codex `workspaceWrite` with the copy as its writable root, Claude `acceptEdits` with a workspace floor.
- `resolveSession` refuses a copy on Claude without the sandbox.
- The copy is removed in `finishAssignment`, and by `closeSession` for assignments that never finished. The run log records `copy.created` and `copy.removed`.
- The child's note says the copy mirrors `copyOf`, and to use the same paths in it. A coordinator's target note says to name paths relative to the project. `alp_delegate` returns a `workdirNote`.
- `watchCopy` checks Codex `commandExecution` items as they start. One whose cwd is inside the requester's checkout but outside the copy is logged as `copy.escape` and reported in the result's `copyWarning`, since Codex's sandbox would let it write there.

**Evidence.**
- `test/permissions.test.js` covers:
  - the floor in `claudePermissions`: the sandbox option, sandboxed Bash, leaving it with and without rules, and file tools inside and outside the workspace
  - `createCopy`: diff and status equal to the requester's, untracked and ignored files, the linked `node_modules`, writes not reaching the tree, removal and reclaim
  - a Codex assignment in a copy: native workspace-write on the copy, refused claims, the escape warning, removal
  - a Claude assignment with a workspace floor, and the refusal without the sandbox
  - advisors getting a read-only floor by default
- The full suite passes with the sandbox claimed and with `ALP_CLAUDE_SANDBOX=0`, which is what CI on Linux without bubblewrap sees.
- Live on 2026-10-09, with the reviewer profile `{ base: read-only, workdir: copy }` and an `npm test` that writes a file:
  - A Claude reviewer and a Codex reviewer each ran `npm test` in their copies. The tree kept only the user's change, and both copies were removed.
  - That run found the first copy built on `stash create`, so `git diff` there was empty. The copy now applies the changes on HEAD, and the next reviewer saw the diff.
  - A Codex reviewer whose brief named the real root ran `npm test` there and wrote into the tree. The probe confirmed Codex's sandbox behavior. After the notes and the escape warning, the same prompt kept the reviewer in its copy, with no escape.
  - With no permission settings, a Claude reviewer ran `node --test` in its read-only floor. Before step 3, Bash was refused. Its `npm test` failed with EPERM writing `.last-test`, as the floor should.

## 27. Recovery after a crash, and recall, as built (2026-10-09)

Goal (D20, step 1): work an assignment held is not stuck when alpd stops under it, and a requester can ask a finished assignment why it did something instead of guessing from its handoff. Both ideas come from Gas Town: its hooks keep work through crashes, and `gt seance` talks to a predecessor session.

**Orphaned tasks.**
- `startTask` records the assignment's `pid` (alpd's process) and `epoch` (the runtime instance) on the assignee, and its log entry names the assignment.
- `releaseOrphans(projectRoot, isOrphan, describe, by)` (core) puts back to `open` every `in_progress` task held by an assignment that `isOrphan` says is gone.
  - It logs `orphaned` with the agent, the assignment and a note, and keeps the last handoff.
  - It checks without the lock first, so a project without tasks gets no tasks directory.
- The runtime runs it once per project, before main's first task digest after it starts (`releaseOrphansOnce`).
  - An assignee is orphaned when its epoch is not this runtime's, unless its pid is another live process (another alpd).
  - Tasks main took for itself have no assignment and are left alone.
  - The note names `alp/<assignment>` when that branch exists, since `reclaimWorktrees` committed the work there at start.
  - Each release goes to the run log as task action `orphaned`, and to the supervisor's digest.
- `taskDigest` lists an open task whose last log entry is `orphaned` as `- interrupted: …; delegate it again` instead of under ready, until the task is touched again.

**Recall.**
- Assignments open with `keepThread`, so their native thread is not ephemeral (Codex `ephemeral: false`, Claude `persistSession`), though they still cannot be resumed as roots.
- `finishAssignment` records each in the recall book (`recall.ts`, `RuntimeOptions.recallFile`, alpd: `$ALP_HOME/state/recall.json`). An entry holds:
  - the assignment, its root, and its requesters (the parent's lineage);
  - the agent, project, runtime, thread, cwd, model and thinking;
  - its task, its status, and when it finished.
- `alp_recall { assignmentId | taskId, question }` is offered to every agent that delegates.
  - A root may recall any assignment of its project. Another requester may recall only entries whose requesters include it. Only main recalls by task.
  - Running assignments are refused.
- `askRecalled` opens a separate transport and sends `thread/fork` with these settings:
  - read-only, approval `never`, ephemeral;
  - Codex needs `excludeTurns: true` for an ephemeral fork;
  - Claude gets an empty tool set and a short system prompt.
- It then sends one `turn/start` with `recallPrompt` in a read-only sandbox, and returns the last agent message.
  - Tool calls and approvals from the fork are refused.
  - The transport closes after the turn, a failure, or 300 s.
  - A cwd that is gone falls back to the project on Codex. On Claude it is recreated empty for the fork and removed after, because Claude locates a session by the directory it ran in.
- `ClaudeTransport` gained `thread/fork` (resume with `forkSession` and a new `sessionId`) and `thread/delete` (`deleteSession`). Codex speaks both natively.
- `forgetExpired` deletes the threads of entries older than 14 days, or beyond the newest 1000, with one transport per runtime. It runs when the runtime starts with a recall file, and after each recorded assignment.
- The CLI `alp recall <assignment|task> question` calls the RPC `assignment.recall`, which calls `AlpRuntime.recall`. The user may recall any entry.

**Evidence.**
- `test/recall.test.js` covers:
  - `releaseOrphans` and the interrupted digest line;
  - main's first turn releasing an earlier alpd's task (with its branch) and a legacy task without a pid, but not a live alpd's;
  - new assignees carrying pid and epoch;
  - `alp_recall` by task and by assignment: fork parameters, read-only turn, refused tools and approvals, the answer;
  - refusals for missing, running and out-of-line assignments, and by task for lead;
  - the user's `recall`, a failed fork, and expiry deleting Codex and Claude threads at start.
- Live on 2026-10-09 against Codex 0.160.1 and Claude Code:
  - A probe forked a non-ephemeral thread on each runtime, and the fork recalled a code word and its reason. `thread/delete` then removed the original, and a second fork found nothing. The probe also found Codex's `excludeTurns` requirement.
  - Through alpd, with an isolated `ALP_HOME`: main delegated a task to a Codex peer. `alp recall <task>` returned the peer's actual rule for its number.
  - A second delegation in a worktree was killed with `kill -9` on alpd mid-assignment. The next `alp run` reclaimed the worktree onto `alp/<assignment>`, put the task back to open, and main's turn showed the interrupted line with that branch. The branch held the peer's partial file.

## 28. Verification gates as built (2026-10-09)

Goal (D20, step 2): a change is checked by the project's own commands, which alpd runs rather than an agent reports, before it reaches the requester's checkout. The result is recorded on the task. The idea comes from Gas Town's Refinery, which runs gates before it merges. Its batching and bisecting queue is not taken.

**Settings and runner (`src/core/verify.js`).**
- `verify: { setup?, typecheck?, test?, timeoutSec? }` in `.alp/settings.json`. `validateSettings` checks it: known keys, at least one command, and a timeout of 1–7200 s (default 600).
- `runVerify(cwd, config)` runs the steps in order through `/bin/sh -c` (or `cmd /c`), stopping at the first failure.
  - It keeps the last 4000 characters of output.
  - A timeout kills the process group and reports exit 124 with `timedOut`.
  - It sets `ALP_VERIFY=1` and passes the session environment without host agent variables.
- `describeVerification` gives a one-line form: `verified (setup, test)`, `verification failed: test exited 1`, or `verification skipped: why`.

**Tasks.**
- `recordVerification` stores `verified` on a task that is not closed. It keeps where the run happened, and each step's command, exit code and time, plus the last 1000 characters of a failed step's output. It logs a `verified` entry.
- `closeTask` refuses `done` with `TASK_UNVERIFIED` when the last run failed, unless `unverified` says why. A user close is never refused; it records `unverified: "the user closed it after …"`. A skipped run does not block.
- `summarize` adds `verified: passed|failed|skipped`. The digest shows the result on tasks in review, and failures on tasks in progress.

**Runtime.**
- `alp_merge { assignmentId, skipVerify? }` checks first:
  - With verify configured, it runs the commands in the worktree's copy of the project root. `linkModules` lends the project's `node_modules` for the run when the worktree has none, and removes the link after.
  - On failure, the pending change is kept together with the verification. The result is an error with the steps, output and next steps, and nothing is applied.
  - `skipVerify` records a skipped verification on the task.
- `Worktree.fingerprint` is `checkoutFingerprint` at creation: a sha256 of HEAD, `git diff --binary HEAD` and the untracked names. Inside the checkout queue, the merge compares it with the checkout's current fingerprint. If they differ, ALP verifies the checkout again after applying, then reports and records that run (`verifiedIn`).
- Merges and verify runs on one checkout share one queue (`inCheckout`).
- `alp_delegate { continueFrom }` takes a pending worktree change as soon as it is checked, so a merge or another delegation cannot use it too.
  - `createWorktree(…, from)` starts a new branch at that change's commit, keeping its `base` and fingerprint, so the next merge applies both changes as one.
  - The old worktree and branch are removed.
  - The brief starts with the change's files and, after a failed check, the failing command and the end of its output.
  - `continueFrom` implies worktree isolation.
- A shared writer that finished `completed` and changed the checkout is verified in `finishAssignment` while it still holds the lease. The fingerprint taken at its start tells whether it changed anything. The result carries `verification`.
- `alp_verify { taskId? }` is offered to agents that delegate. It runs in their workdir, inside the checkout queue. Only main may record on a task.
- Every run is logged as `verify`. `alp_task close` takes `unverified`.

**CLI.**
- `alp verify [--project] [--task] [--json]` runs the commands in the project root. It exits 1 on failure, and with `--task` it records the result as the user.
- `alp task close --unverified`, `alp task show` and `alp log` show verifications.

**Evidence.**
- `test/verify.test.js` covers:
  - settings validation; step order, stopping on failure, output, and timeouts;
  - the close gate for agents, with `unverified`, for the user, and with a skipped run; digest and summary;
  - a worktree merge refused by the check: nothing applied, the node_modules link gone after, close refused. Then `continueFrom` building on the change, the old branch removed, the brief carrying the failure, the merge passing and the task closing;
  - re-verifying a checkout that changed meanwhile; `alp_verify` recording on a task; `skipVerify` being recorded;
  - shared writers verified only when they changed something;
  - the CLI.
- Live on 2026-10-09: a Codex main sent a deliberately bad change through a project whose check rejects `TODO.txt` and a non-semver version, in alpd with an isolated `ALP_HOME`.
  - The first two merges applied nothing, each with the check's message.
  - Main delegated `continueFrom` twice with the same task, and the third merge passed and applied.
  - The task log shows two failed and one passed verification before main closed it.
  - No branches, worktrees or processes were left.

## 29. Pause and usage limits as built (2026-10-09)

Goal (D20, step 3): the user can stop ALP's work and continue it later, and a usage limit stops work without failing it. Gas Town has `gt estop`, `scheduler pause` and quota tracking; ALP does not rotate accounts.

**State.**
- `paused = { all?, runtimes: { codex?, claude? } }`. Each `Pause` is `{ since, by, reason, resetsAt? }`.
- It is kept in `RuntimeOptions.pauseFile` (alpd: `$ALP_HOME/state/pause.json`), read at start and written atomically.
- `pauseOf(kind)` is `all ?? runtimes[kind]`. `held(session)` means the session is parked, or its runtime is paused.

**Effects.**
- `runDelegation` refuses a child whose runtime is paused. The child's runtime is the prefix of `model`, or else the requester's. The refusal names another runtime that is not paused.
- `autoWake` sets `wakeHeld` instead of starting a turn for a held session. The wake-limit failure does not fire for held sessions. The watchdog skips held assignments and restarts their silence.
- `pauseRuntime(scope, pause, now)`: with `now`, every running assignment turn on the scope gets `parkReason` and a `turn/interrupt`.
- `terminal` parks a session whose turn ended (not completed) while `parkReason` was set, instead of settling it:
  - `parked = { reason, since }`, and a `session.updated` event with `parked`;
  - the requester gets an assignment snapshot with status `parked`, and passive mail explaining it;
  - the run log records `assignment.parked`.
- `resumeRuntime(scope, by)` clears the pause and sends a notice. It continues parked sessions with a resume prompt (`assignment.resumed`), and delivers the mail of `wakeHeld` sessions.
- The API is `AlpRuntime.pause/resume/pauses`, over the RPCs `daemon.pause`, `daemon.resume` and `daemon.pauses`. The CLI has `alp pause [codex|claude] [--now] [-m]`, `alp pause status` and `alp resume [runtime]`. `alp ps` prints pauses, and shows parked sessions.

**Limits.**
- In `notification`, a `turn/completed` that failed with `codexErrorInfo` `usageLimitExceeded` or `rateLimitExceeded` parks the turn if it was an assignment's. It then calls `limitReached`, which:
  - pauses the runtime as `alpd`, unless it already is;
  - sets `resetsAt` from the error. If the error has none, it uses the latest `account/rateLimits/updated` report or the runtime's usage context: the latest reset of a window used to 100%;
  - sends an error notice to every open root.
- `ClaudeTransport` handles `rate_limit_event`:
  - it remembers the event, and forwards it as `account/rateLimits/updated { claude }`;
  - it marks the turn limited on an assistant message with `error: 'rate_limit'`;
  - it reports the turn's result as failed with `codexErrorInfo: 'usageLimitExceeded'` and `resetsAt` when the turn was limited, or when the result failed after a rejection with no overage allowed (`claudeLimited`).
- `usageReport` warns once per runtime and reset time: at a Codex window of 90–99%, or a Claude `allowed_warning`.
- `autoResume` (alpd: `limits.autoResume` in `$ALP_HOME/settings.json`) schedules a resume a minute after `resetsAt`, for pauses by `alpd` only. Persisted limit pauses are rescheduled at start.

**Notices.**
- A new `TimelineItem` kind, `notice { level, text }`, is emitted on every open root and logged as `notice`.
- Paseo shows it as a `notification` item. `alp run` and `alp attach` print it with `‼`, `!` or `ℹ`, and `alp log` prints notices, parks and resumes.

**Evidence.**
- `test/pause.test.js` covers:
  - a Codex limit parking an assignment with its task kept, and the pause stored with `resetsAt` from the usage report;
  - the notice, the requester's mail, and the watchdog not failing it;
  - Codex delegation refused while Claude delegation runs;
  - resume continuing the assignment to a handoff;
  - `pause --now` parking a running assignment, with mail held and resume continuing it, and the parked snapshot;
  - a pause without `--now` letting the turn finish and holding main's wake until resume;
  - Claude limit and overage handling in the transport;
  - warnings once per window;
  - a persisted pause, and `autoResume`.
- Live on 2026-10-09, with a Codex main and peer in alpd and an isolated `ALP_HOME`:
  - `alp pause --now` parked the peer. `alp pause status` and `alp ps` listed it, and main received the parked mail.
  - `alp resume` started a turn on the peer, which continued, filed its handoff, and main reported the result.
  - A real usage limit could not be triggered on demand. The tests cover it with the error shapes from Codex 0.160.1's schema and the Claude SDK's types.

## 30. Epic landed as built (2026-10-09)

Goal (D20, step 4): when the work under an epic is done, main closes the epic, and the user hears what it came to without asking. Gas Town reports a convoy as landed; ALP has no convoys, so the epic, or any task with children, plays that part.

**Ready to close.**
- `landedParents(tasks)` lists open tasks that have children, all of them closed.
- `taskDigest` puts them first in main's task list: `- ready to close: t-x P2 Title; all N children are closed. Close it with a summary; ALP reports it to the user`.
- When `alp_task close` closes the last open child of a parent that is still open, its result carries `next`, which tells main to close the parent with a summary.

**Report.**
- `epicReport(id, tasks)` walks every task below the epic, at any depth. It counts:
  - the leaves, and how many of them closed;
  - the time from the epic's creation to its close, or to now while it is open;
  - `reworked` entries, and `released` or `orphaned` entries, as handed back;
  - the leaves' verification: passed, failed, skipped, or none;
  - leaves closed `unverified`.
- Its `text` starts with `Landed epic …` once the epic is closed (`Progress of epic …` before that), then the close summary, then one line per task, indented by depth: `✓` done, `✗` closed another way, `○` not closed.
- A task without children has no report.

**Telling the user.**
- When `alp_task close` closes a task that has children, the result carries `report`, and the runtime:
  - sends the report as an `info` notice to the open roots of that project only. `notice(level, text, project?)` now takes a project;
  - logs `epic.landed` with the counts. The supervisor's journal and `alp log` (`◆`) show it.
- The user's CLI writes the files directly: `alp task close` prints the report after closing a task with children, and `alp task report <epic> [--json]` prints it at any time.
- The Paseo Tasks panel's `alp.tasks.change` returns the report's first line as `landed`, and the panel shows it as the toast.

**Evidence.**
- `test/epic.test.js` covers:
  - the ready-to-close line;
  - a report over nested children, with rework, verification passed and failed, an unverified close, and a `wontfix` child, open and then landed;
  - a close returning `next` for the last child, then `report`, with the notice reaching only the epic's project and `epic.landed` logged;
  - `alp task report` and the epic's close output in the CLI.
- `test/panel.test.js` covers `landed` from the panel's close.
- Live on 2026-10-09, with a Codex main and peers in alpd and an isolated `ALP_HOME`:
  - main created an epic with two children, delegated each to a peer, and checked and closed them;
  - after the last close, main closed the epic on its own;
  - `alp run` showed `ℹ Landed epic t-30f4 "Greeting files": 2/2 tasks closed, took 2m.` with the per-task lines;
  - `alp log` showed the notice and `◆ main closed t-30f4 …`.
