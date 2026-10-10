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

## 31. Crash and restart recovery as built (2026-10-09)

Goal (D21, step A): work survives alpd and its native processes. Gas City treats sessions as mortal and work as durable; ALP takes that, with resume instead of adoption, since Codex and Claude processes end with alpd.

**Daemon invariants.** These rules come from Gas City's controller. alpd follows them from this step on:
1. A failed or partial observation is never "nothing": alpd does nothing destructive on it. An assignment that cannot be reopened ends only after its tree was tried, and a revive that fails falls back to the old failure path.
2. Intent is written before the effect. The live entry exists once the thread does, and is removed before an assignment starts to finish. The running marker is written at start and removed last at stop.
3. Destructive actions check the incarnation. Tasks record the alpd `epoch`; a retake writes the new one; a transport that was replaced reports nothing.
4. Deliberate stops are never crashes. Pause, usage limits, interrupt and close never trip the restart breaker; only a process death does, and progress clears it.
5. Recovery is idempotent. A crash during recovery leaves the entries of what did not finish, and the next alpd tries them again. An entry is rewritten with the new epoch only once its assignment is open again.
6. Every recovered assignment ends with one named outcome: `resumed`, `parked` or `failed` with a reason. Each is in the run log and in the notice.
7. Tests wait for facts, not for time: run log entries, transport calls, task files.

**Live assignments.** `createLiveBook(liveFile)` (alpd: `$ALP_HOME/state/live.json`, written atomically) holds one `LiveEntry` per running assignment:
- `assignmentId`, `rootId`, `parentId`, `callId`, `agent`, `project`, `ancestry`;
- `runtime`, `model`, `threadId`, the session `spec` it was opened with, and `delegation`;
- `mode`, `isolation`, `taskId`, `worktree`, `copyOf`, `lease` and `fingerprint`;
- `startedAt`, and the `epoch` of the alpd that wrote it.

`runDelegation` writes the entry right after the child's session opens. `finishAssignment` removes it first. While the runtime shuts down (`closed`), `finishAssignment` keeps the entry and the task, logs `assignment.interrupted`, and only closes the session. The server stops recording events once it closes, so session records keep what was running at the stop, as after a crash.

**Reopening trees.** `restore()` in the server:
- reads `runtime.recoverable()`, the entries with another epoch;
- reopens a root that is resumable (spec, persistent thread) when it was `running` or has entries. Its children with entries stay `closed` without a failed `assignment.finished`;
- after loading, calls `runtime.abandon(root)` for entries whose root it does not reopen;
- reopens each tree with no connection: `runtime.open` with `restore`, then `runtime.recover(root, { continueRoot: wasRunning })`. A root in `recovering` is not reaped until its recovery has started.

**`recover`** opens entries nearest the root first. For each entry, `resumeAssignment`:
1. takes the lease again, unless another line holds it;
2. checks out the worktree again with `reattachWorktree`, from the branch `reclaimWorktrees` committed it to, or creates a new review copy;
3. registers the assignment under the requester with `childContexts.recovered`, so it opens beside an idle requester;
4. retakes the task with `retakeTask`: same assignment, new `pid` and `epoch`, log `resumed`; this is refused when the assignment no longer holds the task;
5. opens the session with `restore` on its thread, and pins its task claims again.

On a failure it undoes what it did and `abandonEntry` ends the assignment:
- the task is released with the reason, and the branch is logged as kept;
- the run log gets `assignment.finished` with `failed` and `reconciled`;
- the requester gets a failed result if it is open.

Each resumed assignment, and the root when it was working, then gets a prompt saying why ALP reopened it, listing that session's own resumed assignments so it can `alp_wait` for them. With `recoveryResume: false` (alpd: `"recovery": { "autoResume": false }`), or on a paused runtime, the session is parked instead, with that prompt kept for `continueParked`. A root that was idle gets a passive note per resumed assignment. Every open root of the project gets one notice with the counts and the failures. Run log events: `assignment.interrupted` and `assignment.recovered`.

**Reviving a process.** `wire()` connects a transport. When a transport fails and `revivable(session)` holds:
- `revive` parks the interrupted turn, with `parkThen` telling the requester ALP is restarting it;
- it creates a new transport, `thread/resume`s with `configOf(session)`, and continues the parked turn with a prompt saying the process was restarted.

`revivable` needs:
- an open session that has a thread, is not pending, and is not a supervisor;
- a persistent or kept thread;
- fewer than `RESTART_LIMIT` (3) fruitless restarts within `RESTART_WINDOW_MS` (10 minutes). A restart is fruitless when no item completed after it (`progressAt`).

When the revive fails, the session fails as before. Run log events: `session.restarted`, `session.revived` and `session.revive_failed`.

**How alpd ended.** `main.ts` writes `$ALP_HOME/state/alpd.running` (`{ pid, startedAt }`) at start, touches it with the lock heartbeat, and removes it as the last step of a clean stop. When the file is there at start, `previousExit` is `{ kind: 'crash', at: <its mtime> }`; otherwise it is `{ kind: 'clean' }`. `daemon.status` returns `previousExit`, `alp daemon status` prints a crash, and recovery prompts and notices say "alpd stopped unexpectedly" or "alpd restarted". `alp daemon restart` no longer refuses when sessions are open.

**Evidence.**
- `test/recovery.test.js` covers:
  - a worktree assignment stopped with alpd, continued by the next one: same thread and worktree directory, its file intact, task retaken, requester told, the notice, then a normal finish into review;
  - a process death revived and continued, and the breaker after three fruitless restarts;
  - abandoned entries, with the task reopened, and recovery parked until `resume()`;
  - a server that reopens a tree by itself after a clean stop, the assignment continuing, main waking for its result, and the unwatched tree closing.
- `test/daemon.test.js` covers the running marker with a real alpd: clean stop, then `kill -9`. The crash test there now expects the working root to be reopened.
- Live on 2026-10-09, with Codex `gpt-5.6-sol` in an isolated `ALP_HOME`:
  - main delegated a peer to run `sleep 120` before writing two files;
  - `kill -9` of that alpd also ended its `codex app-server` processes;
  - `alp daemon start` logged the crash, reopened the root and the peer (`recovered …: peer resumed`) and showed the notice;
  - the peer reran its commands and filed its handoff; main `alp_wait`ed for it and reported both files; `live.json` was empty at the end.

## 32. Hardening as built (2026-10-09)

Goal (D21, step B): small guards taken from Gas City, each against a failure alpd had.

**B1. Prompt text.** `promptSafe` (`src/core/promptsafe.js`) removes `<system-reminder>` open and close tags. It is case-insensitive, allows spaces and attributes, and repeats until nothing changes. It is applied:
- to every tool result (`toolResult`);
- to the turn inputs of `startPrompt`: the catalog snapshot, the task digest, rendered mail, and the prompt text unless its origin is `user`;
- to steered mail;
- to the recall prompt.

So briefs, handoffs, mail, board pins, recall answers, task text and command output reach agents without those tags, while the user's own prompt is untouched.

**B2. Verify.** `runCommand` stops a command with SIGTERM to its process group, then SIGKILL after `VERIFY_GRACE_MS` (5 s), on `timeoutSec` or, with the new `verify.idleSec`, after that long without output (`idle: true`). A step that exits `VERIFY_INFRA_EXIT` (75), or whose shell does not start:
- ends the run with `skipped: 'infra: <step> could not run (…)'`;
- is recorded as skipped, so `closeTask` does not count it as failed;
- makes `alp_merge` refuse to apply, with a `next` that says to run it again.

**B3. Orphans and reused pids.** Tasks record `pidStartedAt` beside `pid` (`OWN_START`, from `process.uptime()`). `startTask` and `retakeTask` write it. `releaseOrphans` keeps a task of another alpd only if `sameProcessAlive(pid, pidStartedAt)` holds: the pid is alive and `ps -o lstart=` matches the start time within 2 s. Where ps cannot tell, a live pid still counts.

**B4. Environment.**
- `nativeEnvironment` also drops `CLAUDECODE`.
- `gitEnvironment` removes git's context variables before every git command of `workspace.ts` and the GitHub helper: `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, the object directories, `GIT_CONFIG*` and `GIT_CONFIG_KEY_n`/`VALUE_n`, and others. It keeps the rest, such as author identity.

**Evidence.** `test/hardening.test.js` covers:
- tag stripping, nested and with attributes;
- a brief, a handoff and a final message with injected tags reaching the requester clean, while the user's prompt keeps its tags, and `CLAUDECODE` dropped;
- SIGTERM cleanup running, the idle stop, and exit 75 recorded as skipped so an agent may close the task;
- start-time matching with a real child process;
- the git environment.

No live run was needed: each guard acts on local processes and text, which the tests exercise for real.

## 33. Settings keys as built (2026-10-09)

Goal (D21, C5): a mistyped setting is reported, not silently ignored.

- `validation.js` lists the known top-level keys:
  - `PROJECT_SETTINGS`: `defaultAgent`, `workflow`, `runtime`, `permissions`, `verify`, `delegation`;
  - `USER_SETTINGS`: `permissions`, `limits`, `recovery`;
  - `$schema` in both.
- `settingsKeys` sorts the keys of a settings object into:
  - unknown keys, each with the nearest known key when the edit distance is at most 2;
  - retired keys, from `RETIRED_SETTINGS` (empty today).
- `validateSettings` throws on the first unknown key: `unknown setting 'verfy'; did you mean 'verify'?`. Without a near key, the message lists the known ones.
- `settingsWarnings` returns the retired-key warnings, which `alp doctor` shows.
- `validateUserSettings` checks `$ALP_HOME/settings.json`:
  - `limits` and `recovery` are objects whose only field is `autoResume`, a boolean;
  - `permissions` goes through `validatePermissions`.
- alpd validates the user's file at start. An invalid file is logged as `ignoring <file>: <reason>`, and alpd starts with the defaults, so a typo never keeps it from running.

**Evidence.** `test/settings.test.js` covers:
- suggestions and lists of known keys, and the user fields;
- the retired-key warnings;
- a project whose typo stops resolution;
- a real alpd that starts despite a mistyped user setting and logs it.

## 34. Instructions fingerprint as built (2026-10-09)

Goal (D21, C4): know which instructions a session ran with, so a change in behaviour can be traced to the file that changed. Gas City stores the hash of each session's rendered prompt.

- `openSession` passes the thread's `developerInstructions` to `noteInstructions`, which:
  - sets `session.instructionsSha` (12 hex characters of SHA-256), shown on `SessionSnapshot.instructionsSha`;
  - logs `{ event: 'instructions', sessionId, agent, sha, chars, parts: { project, agent } }`, where `parts` digest the project's ALP.md and the agent's AGENT.md as resolved.
- This covers roots, assignments and supervisors. The text itself is never logged, only its digests and length.
- `alp log` prints `# main instructions 1d892063c42d (ALP.md 850d6389e73b, AGENT.md fb55cfb0852d, 5210 chars)`.
- Two assignments with the same sha ran with the same instructions. When the sha differs, `parts` tells whether ALP.md or AGENT.md changed; if neither did, something else changed, such as lessons, skills or the profile.

**Evidence.** `test/instructions.test.js` checks that:
- the digest matches the text sent;
- after ALP.md changes, the sha and the project part change while the agent part stays the same.

Two older tests now skip `instructions` entries when they read the run log.

## 35. Context-fill advisory as built (2026-10-09)

Goal (D21, C1): a session that fills its context loses detail when the runtime compacts it. Gas City injects the fill level only when it matters, with advice that changes as it grows (`context_inject.go`). ALP does the same and points at the tools it already has: `alp_handoff` with outcome `partial` for assignments, and `alp_pin` plus task notes for roots.

- Both runtimes report usage as `thread/tokenUsage/updated` with `tokenUsage.last.totalTokens` and `modelContextWindow`.
  - Codex sends this itself.
  - `ClaudeTransport` builds it from each top-level assistant message: input, cache-read, cache-creation and output tokens. Sub-agent messages are skipped. The window is 200k, or 1M when the model name has `[1m]`, until a `result` reports `modelUsage[*].contextWindow`; then it uses the largest reported.
- `contextReport` in the runtime:
  - below 50% it resets `session.contextLevel` to 0 and says nothing;
  - at 60% (level 1, `plan`) and 80% (level 2, `now`) it posts one note from `alp` each time the level rises, never twice for the same level;
  - the note steers into an active turn and is passive otherwise, so it never starts a turn;
  - supervisors are skipped;
  - each note logs `{ event: 'context', sessionId, agent, percent, level }`, printed by `alp log`.
- Notes for an assignment ask for a partial handoff; notes for a root ask for pins, task notes, and a word to the user if a fresh session would serve better.

**Evidence.** `test/context.test.js` checks:
- for a peer: 30% and 59% say nothing, 65% plans, 72% says nothing, 85% says hand off now, 90% says nothing, and after 20% the advice comes again at 62%;
- the run log holds exactly those three entries;
- main between turns gets a passive note that arrives with its next prompt, and no turn is started for it;
- `ClaudeTransport` counts cache tokens, takes the window from the result, and ignores sub-agent messages.

## 36. alp doctor as built (2026-10-09)

Goal (D21, C2): one command that says why ALP does not work here, and cleans up what crashes and old runs leave. Gas City's `gc doctor` runs registered checks, each with an optional fix.

- `src/client/doctor.js`: `diagnose({ home, project, env, run, sandbox, daemonEntry })` returns checks `{ id, status, summary, details?, hint?, fix? }`. Statuses are `ok`, `info`, `warn` and `fail`. `repair(checks)` applies the fixes in order.
- Checks:
  - `build`: `dist/alpd.js` exists.
  - `codex`, `claude`: the executable (`ALP_CODEX_BIN` / `ALP_CLAUDE_BIN`, else PATH), `--version`, and login (`codex login status` exit code; `claude auth status` JSON `loggedIn`). A missing runtime warns; it fails only when neither works.
  - `alpd`: running, or the lock and socket a dead one left (fix: remove them, after checking again that no alpd started). A leftover `state/alpd.running` is reported as info: the next start continues the work.
  - `sandbox`: `claudeSandboxAvailable()`.
  - `permissions`: `$ALP_HOME`, its settings, lock and records, and `state`, `runs`, `logs`, `boards` and their files, with any group or other bit (fix: `chmod` to the owner bits).
  - `user settings`: `validateUserSettings` and `settingsWarnings`; a failure means alpd ignores the file.
  - `skills`: names in `role-skills.json` without `skills/<name>/SKILL.md`.
  - `live work`: `state/live.json` entries whose project directory is gone (fix, only with alpd stopped: drop them).
  - In a project: `settings` (`validateSettings`, `settingsWarnings`), `agents` (`resolveAgent` for each, with the library; project skills that replace library ones as info; a `defaultAgent` that does not exist), `worktrees` (prunable; fix `git worktree prune`), `branches`.
- Branches: an `alp/*` branch merged into HEAD, not checked out in any worktree and not in a live entry, is dead weight (fix: `git branch -d`). Unmerged ones hold kept work and are listed as info, never deleted.
- `alp doctor [--project DIR] [--fix] [--json]`: without `--project` it checks the current directory when it is an ALP project. After fixes it runs the checks again and prints both. Exit code 1 when a check fails.

**Evidence.** `test/doctor.test.js` builds a temporary `ALP_HOME` and project with fake `codex` and `claude`:
- one run finds a not-logged-in Codex, a stale lock, an open file, invalid user settings, a missing library skill, live work of a gone project, a mistyped project key, a prunable worktree, and a merged, an unmerged and a live branch;
- the fixes then remove the lock, tighten the mode, drop only the gone entry, prune, and delete only the merged branch;
- with no runtime both fail, and with Codex alone Claude only warns;
- `alp doctor --json` through the CLI.

## 37. alpd as a login service as built (2026-10-09)

Goal (D21, C3): recovery (§31) needs an alpd to start again after a crash. Gas City's supervisor runs under launchd or systemd and is restarted by them; ALP does the same.

- `src/client/service.js`:
  - `serviceFor({ home, env, platform, uid })` gives the definition file, its name, and the manager commands to install, start and uninstall:
    - macOS: label `com.alp.alpd` (with `.<sha8 of ALP_HOME>` for a non-default home) in `~/Library/LaunchAgents`, managed with `launchctl bootout`, `bootstrap` and `kickstart` in `gui/<uid>`;
    - Linux: `alpd[-<sha8>].service` in `$XDG_CONFIG_HOME/systemd/user`, managed with `systemctl --user daemon-reload`, `enable --now`, `start` and `disable --now`;
    - other platforms: none.
  - `serviceDefinition` writes the definition:
    - it runs `[node, alpd.js, --service]` with `ALP_HOME`, the installing shell's `PATH`, and `ALP_RUN_LOG_DIR`, `ALP_CODEX_BIN`, `ALP_CLAUDE_BIN` and `ALP_GH_BIN` when they are set;
    - launchd: `RunAtLoad`, `KeepAlive { Crashed: true, SuccessfulExit: false }`, `ThrottleInterval 10`;
    - systemd: `Restart=on-failure`, `RestartSec=10`;
    - so a crash or a kill restarts alpd, and a clean exit (0) does not.
  - `installedProgram` reads the program back from the file. `ALP_SERVICE_DIR`, `ALP_LAUNCHCTL` and `ALP_SYSTEMCTL` redirect these for tests.
- `alp daemon`:
  - `install`: stops a running alpd (its work continues, §31), writes and loads the definition, and waits until alpd is ready.
  - `uninstall`: unloads the service, which stops alpd, and removes the file.
  - `start`: goes through the service when it is installed and no alpd runs.
  - `restart`: stops, then starts the same way.
  - `stop`: notes that the service starts alpd again at login.
  - `status`: prints `managed by launchd as …`.
- alpd `--service`:
  - it rotates `logs/alpd.log` and writes its stdout and stderr there itself, since the manager holds its own output file (`logs/alpd.service.log`), which then keeps only what Node prints when it dies;
  - when another alpd already holds the lock, it exits 0, so the manager does not retry.
- `alp doctor` adds a `service` check: it fails when the node or alpd.js the service runs is gone.

**Evidence.**
- `test/service.test.js` checks:
  - both definitions: KeepAlive, environment, quoting, per-home names, and reading back;
  - with a fake manager that starts alpd as launchd would, `install`, `status`, `doctor`, `stop`, `start` (through the manager) and `uninstall` on a real alpd in a temporary home.
- Live on macOS 27 with real launchd, a scratch `ALP_HOME` and the plist in the scratchpad:
  - after `kill -9` of the alpd, launchd started a new one about 10 s later, and `alp daemon status` reported the crash;
  - after `alp daemon stop`, alpd stayed down;
  - `alp daemon start` kickstarted it;
  - `uninstall` removed the job.

## 38. Review verdicts as built (2026-10-09)

Goal (D21, C7): every review answers in the same shape, so a requester acts on it without reading prose, and a later review quorum (phase 12, D4) can combine two. Gas City's review lanes return `pass`, `pass_with_findings`, `fail` or `blocked`, reduced by fixed rules.

- `alp_handoff` takes an optional `verdict { result, criteria, findings? }`:
  - each criterion is `{ criterion, result: pass | fail | not_checked, evidence }`, with 1 to 50 of them;
  - each finding is `{ severity: critical | high | medium | low, where, problem, fix? }`, with up to 100.
- `parseVerdict` checks that the result follows:
  - `fail` needs a failed criterion or a critical or high finding;
  - `pass` and `pass_with_findings` allow neither;
  - `pass` has no findings, and `pass_with_findings` has some;
  - `blocked` is free, and the summary says what is missing.
- An assignment of the agent named `reviewer` cannot file a `complete` handoff without a verdict. Partial and blocked handoffs need none.
- The verdict travels with the handoff:
  - in the result `alp_delegate` and `alp_wait` return, and in the run log;
  - on the task (`HANDOFF_FIELDS` includes it);
  - in main's task digest (`handoff complete, verdict fail`);
  - in the supervisor's digest (`verdict FAIL (1 passed, 1 failed, 2 findings)`) and in `alp log`.
- Templates:
  - reviewer's AGENT.md gains a Verdict section and files the verdict through `alp_handoff`;
  - main and lead brief reviewer with the acceptance criteria and do not accept `fail` or `blocked`.
  - `alp upgrade` recognizes the previous shipped reviewer, main and lead files.

**Evidence.** `test/verdict.test.js` checks that:
- each inconsistent verdict, and a complete review without one, are refused with the reason;
- a partial handoff passes without a verdict;
- a valid `fail` verdict reaches main through `alp_wait` and the run log;
- a task keeps the verdict, and the task digest shows it.

## 39. Scripted agents and golden output as built (2026-10-09)

Goal (D21, C6): test what users read, and the failures that matter, without Codex or Claude. Gas City drives its integration tests with scripted fake agents and checks CLI output against golden files.

- `test/support/fake-agent.js`:
  - `fakeTransport(agents)` builds scripted native agents. Each one can:
    - `call` an ALP tool;
    - `finish` a turn, or `slowHandoff(ms, handoff)`;
    - report `usage` for context fill;
    - `limit()`, a Codex usage limit;
    - `crash()`, the process dies mid-turn;
    - stay stuck by doing nothing.
  - A resumed thread keeps its id, as with the real transports.
  - `tree(t)` gives a project with a root that has started a turn, the runtime, its agents, and a run-log reader. `until` waits for a condition.
  - `context.test.js` and `verdict.test.js` use it; older tests keep their own fakes until they change.
  - `node --test` also loads this file as a test file. It defines no tests, so it passes.
- `src/client/render.js`:
  - holds `renderLog` and `renderPs`, the text `alp log` and `alp ps` print, and the `ago` and `duration` formats;
  - the CLI prints what they return, so tests render fixtures without an alpd.
- `test/golden.test.js` compares against `test/golden/*.txt`:
  - `log`: a real runtime run with scripted agents. One writer pins a decision, fills its context and hands off slowly. A reviewer files a failing verdict. A fixer crashes mid-turn, is restarted and finishes. A writer hits the Codex usage limit and is parked. Times, ids, paths, digests and durations are normalized before rendering. Five repeated runs gave the same output.
  - `ps`: running, waiting, parked, failed and idle sessions in two trees.
  - `task-report`: a landed epic with a nested epic, rework, a handback, mixed verification, and a task closed unverified.
- `ALP_UPDATE_GOLDEN=1` rewrites the files. A missing file fails the test and tells how to create it.

## 40. Paseo keeps alpd running as built (2026-10-09)

Goal (D22): alpd is up whenever Paseo is, without the user starting it, and Paseo sessions outlive an alpd restart.

- `src/client/supervise.js`:
  - `startDaemon({ home, entry })` lifts a hold and starts alpd: through the login service when one is installed (§37), otherwise detached with `ensureDaemon`. The CLI's `start`, `restart` and `install` use it too.
  - `holdDaemon(home)` writes `state/alpd.held` on `alp daemon stop`. alpd removes the file when it starts, so a hold only exists while alpd is stopped.
  - `superviseDaemon({ home, entry, intervalMs = 5000, misses = 2 })`:
    - starts alpd at once;
    - checks the lock every interval, and starts alpd again after two checks in a row find it down, unless it is held;
    - two misses (5–10 s) give `alp daemon restart` and `install` time to stop and start alpd themselves, and must stay longer than alpd takes to start, or a second launcher can outlive the first;
    - `stop()` ends watching and waits for a start in flight.
- The plugin's `contribute` runs `superviseDaemon` for `$ALP_HOME`, with the plugin's alpd.js, unless `ALP_SUPERVISE=0`. Its dispose stops the watching; alpd keeps running.
- Provider connections reconnect (`relink`) instead of failing their sessions:
  - When alpd's connection closes, each open root gets a warning item, and the provider reconnects with backoff (250 ms doubling to 5 s). It starts alpd only when not held, or once a request asked for it.
  - After reconnecting, each root is re-attached with `session.get` and `session.attach` (no replay):
    - a root alpd reopened (§31) keeps streaming;
    - a root alpd did not reopen is dormant, and the next prompt or configure reopens it from its thread with `session.create { resume: true }`;
    - a root alpd no longer knows fails as before.
  - Duplicate `session.opened` and `session.ready` for a root Paseo already shows are suppressed; only its config is re-sent.
  - A request made while alpd is away waits up to 20 s for it.
- `npm test` runs with a temporary `ALP_HOME`, so no test can reach `~/.alp`. Tests that load the plugin turn the watching off or dispose it.

**Evidence.**
- `test/supervise.test.js` checks two things:
  - with a real alpd in a temporary home, the plugin's watcher starts alpd, starts a new one after `SIGKILL`, leaves it stopped after a held stop for two seconds, and `startDaemon` lifts the hold;
  - with an in-process alpd over a durable store, a Paseo connection survives two alpd crashes. It shows the lost and reconnected notices, never `runtime_failed`. The next prompt resumes the native thread, and Paseo sees the session opened once. A prompt sent while alpd is down waits and is accepted.
- While this was built, a version of `test/panel.test.js` loaded the plugin without a temporary home and started an alpd in the real `~/.alp`. It was found, stopped, and its files were removed; the global `ALP_HOME` in `npm test` prevents a repeat.


## 41. Agent library as built (2026-10-09)

Goal (D23, phase 13, step 1): agents, skills, MCP servers and hooks resolve from three layers, and new projects stop copying the built-in agents.

- **Layers** (`src/core/resolver.js`):
  - `agentSources(root, { library, templates })` maps each agent name to its source. The sources are:
    - the built-ins, read with `builtinText` from the package's `templates/agents/<name>/`, or from the bundle's `templates` map;
    - the library, `$ALP_HOME/agents/<name>/`, which counts only with an `AGENT.md`;
    - the project, `.alp/agents/<name>/`, which always counts and reports a missing `AGENT.md` when used.
  - A later layer replaces an agent whole and records what it `overrides`. `discoverAgents` returns the sorted names.
  - `resolveAgent` reads `AGENT.md` and the optional `agent.json` from the winning layer:
    - `validateAgentConfig` checks the keys, with did-you-mean suggestions;
    - `provider`, `model` and `thinking` overlay the project's runtime settings, and `mode` becomes the session's default mode in `resolveSession`;
    - named `skills`, `mcp` and `hooks` resolve from the project's `.alp/<kind>/`, then the library's;
    - role skills from `role-skills.json` are replaced by a project skill of the same name;
    - the agent's own `skills/` and `.mcp.json` come last, and a server named twice is an error;
    - named hooks are checked with `validateHook`.
  - `libraryEntries(kind, root, options)` lists `agents`, `skills`, `mcp` or `hooks` with source, overrides, path, description and `usedBy`.
- **Validation** (`src/core/validation.js`): `AGENT_SETTINGS` and `validateAgentConfig`; `HOOK_EVENTS`, `BLOCKING_HOOK_EVENTS` and `validateHook` (only `handoff`, `task.close` and `merge` block; `timeoutSec` 1–3600; `match` by agent or label).
- **Init and upgrade:**
  - `initProject` creates only `ALP.md` and `.alp/settings.json`. `resolveSession` initializes when either is missing. The supervisor's starter-file branch is gone, since the supervisor is built in.
  - `upgradeProject` ends with `retireAgentCopies`. For each built-in agent's copy whose `AGENT.md` is shipped (current, legacy, or a team-v1 hash):
    - a copy with nothing else (an empty `.mcp.json`, empty `skills/` and `hooks/`) has its files moved to the backup, and the directory is removed (`removed`);
    - a copy with additions stays, with `AGENT.md` replaced by the template (`updated`);
    - customized instructions go to `customInstructions`.
  - An empty `.alp/agents` is removed.
- **CLI and doctor:**
  - `alp agents|skills|mcp|hooks [--project DIR] [--json]` print `libraryEntries`. The upgrade output separates archived skills from agent copies put away.
  - `alp doctor`'s agents check resolves every agent with the library. A broken reference fails it, and overrides are listed as info.
- Hooks are validated but not run; an agent with hooks is still refused by the adapter until step 5. Providers and teams are listed with their steps (2 and 6).

**Evidence.**
- `test/library.test.js` covers:
  - the three layers and whole replacement;
  - `agent.json` runtime, mode and named entries, with the project winning;
  - every missing or malformed reference and hook, with its file named;
  - upgrade keeping a copy with an added MCP server while putting the rest away;
  - the CLI listing.
- `test/init.test.js`, `skills.test.js`, `upgrade.test.js` and `paseo.test.js` changed to the new starter:
  - init writes two files, and the built-ins resolve with their template text;
  - upgrade of team-v1 and legacy copies removes them, with backups;
  - a project skill in `.alp/skills` replaces the library's.
- `test/support/legacy.js` builds a project as the old init made it.
- Paseo fixtures turn the supervisor off: the built-in supervisor now always exists, and its review keeps a released tree running. The golden and digest tests are unchanged.

## 42. Teams as built (2026-10-09)

Goal (D23, phase 13, step 2): Phở and Cafe become teams, and the user can define more. A team holds its main, members, delegation, models and house rules.

- **Templates:** `templates/teams/pho` and `templates/teams/cafe` hold `team.json` and `HOUSE_RULES.md`:
  - The house rules are the coordination sentence `runtime.ts` hard-coded after `Profile: <mode>; fixed for this session.`, moved without rewording.
  - Main's model and effort (`claude:claude-opus-5-5`, `high`) and the supervisor's (`claude:claude-sonnet-4-6`, `medium`) moved from `catalog.ts` into the team files.
- **`src/core/teams.js`:**
  - `teamSources` reads the built-ins, then `$ALP_HOME/teams/<id>/team.json`, then `.alp/teams/<id>/team.json`; a later layer replaces a team whole.
  - `resolveTeam` adds `HOUSE_RULES.md` and accepts `smart` and `supervised`. `listTeams` orders built-in, library, project, and lists a broken team with its error.
  - `validateTeam` checks:
    - unknown keys, with did-you-mean suggestions;
    - that main is a member;
    - each member's role (`lead`, `peer`, `advisor`, `reviewer`);
    - that delegation names only members, never targets main, and has no cycle;
    - that `maxPeers` is valid;
    - that `supervisor` is `false` or `{ agent, model, thinking }` with an agent outside the members.
- **`resolveWorkflow`:**
  - It returns `{ mode, maxPeers, supervisor, team }`; mode is the team id, or `custom` with settings' `delegation`.
  - `maxPeers` comes from the restored session, then settings, then the team, then 2. `alp init` no longer writes `maxPeers`, so a team's limit applies.
  - `workflow.mode` in settings accepts any team id.
- **`resolveSession`:**
  - It keeps `team` beside a lean `workflow`, so session snapshots and records are unchanged apart from `teamLabel`.
  - The model order is: the caller, then settings' `runtime` (model or provider), then the team member's `model`/`thinking`, then the agent's `agent.json`, then the defaults.
    - Settings' `runtime` now also comes before `agent.json` (§41 had it after).
    - A resumed session keeps the team's effort only while it runs on the team's model.
  - A custom graph uses built-in Phở's main settings and house rules, so its main is unchanged.
  - The team's main gets `full-access` by default and records lessons. The lessons are read for main and the team's supervisor agent.
- **Runtime:**
  - The graph is `team.delegation`.
  - `mainOf(mapping)` replaces the `'main'` checks for:
    - task actions, the task tool and the task text;
    - issues, recall by task, verification by task, `taskId` delegation, and the task list at turn start;
    - `supervises`.
  - `roleOf(mapping, agent)` counts peers and allows parallel peers and advisors. Without a team, roles follow the built-in names.
  - `openSupervisor` opens the team's supervisor agent on its model, and the run log records the model it got.
- **Paseo:**
  - The catalog lists `teamModels(input.cwd)`: built-in, library, then project, leaving out broken teams.
  - A root session's config offers only its own team, since the team is fixed.
  - Session listings use `teamLabel`.
  - The selected model is a team when it has no runtime prefix.
- **CLI:** `alp run --team`, with `--profile` and `--workflow` as aliases. `alp teams [--project] [--json]` shows members, delegation and supervisor.

**Evidence.**
- `test/teams.test.js` checks:
  - Phở, Cafe and a custom graph give main the exact pre-team text and Opus 5.5 high;
  - the layers and every validation error;
  - a project team whose main is `architect`: the team model beats `agent.json`, it gets the house rules, its graph and its peer limit, it manages tasks and issues, and a `watcher` supervisor runs on Codex;
  - that settings and the caller come before the team;
  - the Paseo catalog and `alp teams`.
- Existing tests changed only messages ("team" for "profile"), the session config's model list, and init's settings.

## 43. Editing the library as built (2026-10-09)

Goal (D23, phase 13, step 3): one set of core functions edits agents, skills, MCP servers, hooks and teams. The CLI and the Paseo settings screen both use them.

- **`src/core/library-edit.js`:**
  - Functions: `getEntry`, `listEntries`, `usersOf`, `saveEntry`, `deleteEntry`, `duplicateEntry` and `renameEntry`, over the kinds `agents`, `skills`, `mcp`, `hooks` and `teams`.
  - Content is per kind:
    - agents: `{ instructions, config }`;
    - skills: `{ body }`;
    - MCP servers: `{ server }`;
    - hooks: `{ hook }`;
    - teams: `{ team, houseRules }`.
  - The scope is `library` (`$ALP_HOME`) or `project` (`.alp/`). Built-ins are read from the templates and never written.
  - **Saving:**
    - Validation comes first: `validateAgentConfig`, `normalizeMcp`, `validateHook` or `validateTeam`.
    - Named references are checked against what the scope can see: a library agent sees only the library; a project agent sees the project and the library. A team's agents must exist.
    - Files are written through a temporary file and a rename. An empty `agent.json` or house rules file is removed.
    - The revision is a hash of the scope's content. A save carrying an older one fails with `REVISION_CONFLICT`, and `revision: null` creates.
  - **Deleting and renaming:**
    - Users of an entry are:
      - for agents: teams naming them, and the project's `defaultAgent` and `delegation`;
      - for skills, MCP servers and hooks: agents naming them in `agent.json`, plus roles in `role-skills.json` for skills;
      - for teams: the project's `workflow.mode`.
    - Delete and rename are refused (`IN_USE`) while there are users, unless removing an override leaves a lower layer of the same name.
- **`src/core/hook-run.js`:** `runHook(hook, payload, { cwd, env, timeoutMs })` runs `/bin/sh -c` with the JSON payload on stdin, cuts output at 64 KiB, and sends SIGTERM at the timeout, then SIGKILL after 2 s. `samplePayload(event)` builds a test event. Step 5 reuses both.
- **`src/client/mcp-probe.js`:** `probeMcp(server)` speaks MCP's `initialize`, `notifications/initialized` and `tools/list` (with paging):
  - over stdio, as newline-delimited JSON-RPC;
  - over streamable HTTP, answered as JSON or server-sent events, keeping `mcp-session-id` and ending with DELETE.
- `src/client/library-test.js` (`testEntry`) runs an MCP server or a hook with `ALP_*` variables.
- **CLI:**
  - `alp agent|team|skill|mcp|hook` with `new`/`add`, `edit`, `show`, `cp`, `mv`, `rm` and `test` (for mcp and hook). `--project` alone means the current directory.
  - `edit` of an entry that only a lower layer has creates the scope's override.
  - Team options: `--member name=role`, `--member-model`, `--member-thinking`, `--delegate owner=a,b`, the `--supervisor*` options, `--no-supervisor` and `--rules FILE`. Changing `--main` drops the old main from the members and the graph.
- **Plugin:** `plugins/paseo/shared/library.ts` defines `alp.library.list|get|save|delete|duplicate|rename|test`, and `server/library.ts` handles them with the core functions:
  - the library is `$ALP_HOME`;
  - the project is the nearest ALP project of the workspace directory, and the project scope is refused without one.
- `npm test` now runs `node --test 'test/*.test.js'`. Node's default patterns also ran every file under `test/`, including the support scripts; the fake MCP server waited on stdin there, so the run hung.

**Evidence.**
- `test/library-edit.test.js` checks:
  - saves, revisions and conflicts, with no temporary files left behind;
  - that built-ins are never written, but can be copied and overridden;
  - reference checks per scope;
  - in-use refusals for skills, MCP servers, hooks and team agents;
  - bad definitions never reaching the disk.
- `test/library-tools.test.js` checks:
  - `runHook`'s stdin, environment, exit code and timeout;
  - `probeMcp` over stdio (paging, a crash with its stderr, a missing command) and over HTTP (JSON, then SSE, with the session id and the user's headers);
  - every RPC through the contracts;
  - the CLI from creating entries to removing them.

## 44. The ALP settings screen as built (2026-10-09)

Goal (D23, phase 13, step 4): manage the library and a project's overrides in Paseo.

- **`index.client.tsx`** registers:
  - `addSettingsScreen({ id: 'alp-settings', title: 'ALP', icon: 'Bot' })`, with `LibrarySettings`;
  - the workspace panel `alp-project`, "ALP project", with `ProjectLibraryPanel`;
  - the Tasks panel, as before.
- **`client/library.tsx`:**
  - `LibraryManager` loads `alp.library.list` for each kind, and `alp.library.get` for the open entry.
    - The library scope sends no directory.
    - The project scope sends the workspace directory and saves into the project.
    - After every action it reloads, so the next save carries the new revision.
  - The views take data and callbacks only, so tests render them without RPC:
    - `LibraryLists`: five sections with source, override and user badges, New, Duplicate (with a name), and in the project scope Override in this project and Use library;
    - `EntryEditor`: a built-in or lower-layer entry is saved with `revision: null`, which creates the scope's own; Remove appears only for the scope's own entry and says what applies again;
    - `AgentForm`;
    - `TeamForm`, with role selects, member model and thinking, a delegation switch per pair (never into main), a cycle warning (`delegationCycle`), the supervisor, and the house rules;
    - `McpForm`, for stdio or HTTP;
    - `HookForm`, where the blocking switch shows only for `handoff`, `task.close` and `merge`;
    - Test buttons for MCP servers and hooks.
  - Team edits go through the pure functions `withMain`, `withMember` and `withDelegation`:
    - a new main takes over the old main's targets;
    - removed members leave the graph;
    - main is never a target.
- **Kit:**
  - It uses the SDK's settings kit (`SettingsSection`, `SettingsRow`, `SettingsSwitch`, `SettingsSelect`, `SettingsInput`, `SettingsAction`) and React Native primitives.
  - `SettingsInput` is uncontrolled, so the editor is keyed by entry and revision.

**Evidence.**
- `test/settings-screen.test.js` checks:
  - the bundle uses only the modules Paseo 0.11.1 supplies, and the screen and panel register;
  - the library and project lists render with badges, actions and order;
  - the agent, team, hook and new MCP editors render;
  - the team edit functions;
  - `delegationCycle` and `blank`.
- `test/panel.test.js` gets a stub of the kit.
- Not tried in a running Paseo: installing the plugin there means changing the user's Paseo, which this work does not do.

## 45. Hooks run by ALP as built (2026-10-09)

Goal (D23, phase 13, step 5): alpd runs agents' hooks at its own events, for every runtime. The user trusts each workspace's hooks once.

- **Loading:**
  - `src/core/hooks.js` `loadHooks(agent)` reads the agent's hooks: named in `agent.json`, plus the JSON files of its own `hooks/`.
    - A file that is not JSON is an error.
    - `validateHook` checks each one.
    - A hook is marked `project` when its file is under the project's `.alp/`.
  - `resolveSession` puts them in `mapping.hooks`. The instructions adapter reports hooks as `emulated`, so an agent with hooks is no longer refused.
- **Running:**
  - `runHooks(sessionId, session, event, details, taskId)` in `runtime.ts` filters hooks by event and `hookMatches` (agent, and task label through the task file).
  - It builds the payload: event, project, session, agent, parent agent, team, task, and the event's details.
  - Non-blocking hooks start in the background. Blocking ones run in turn with `runHook` (§43, process group). The last 20 lines of a failed one's stderr (or stdout) become the refusal.
  - Each run is logged as `hook`, with `on`, `hook`, `exitCode`, `durationMs`, and `blocked` or `skipped`. `renderLog` shows ↪, ✗ and ⛔ lines.
- **Events:**
  - `session.start`: when `session.ready` is emitted (`resumed` tells a reopened session).
  - `turn.end`: in `terminal()`.
  - `assignment.start`: after the child opens.
  - `assignment.end`: with the status and the handoff, before `assignment.finished`.
  - `handoff`: `hookedHandoff` validates the handoff first, then runs the hooks. A refusal returns `A handoff hook refused it` with a `next` hint.
  - `task.close`: before `closeTask` in `alp_task close`. A refusal is an error and leaves the task open.
  - `merge`: in `alp_merge`, after verification and before anything is applied. A refusal keeps the worktree pending.
- **Trust:**
  - `src/core/trust.js` keeps `$ALP_HOME/state/trust.json` `{ projects: { <realpath>: { trustedAt, by } } }`, written atomically.
  - `hooksTrusted` asks the user with `askUser`, offering "Trust this workspace" or "Not now". It asks once per root tree and project, and concurrent hooks share the question.
    - An agreement is recorded, and from then on every hook of that project runs, including later ones.
    - A dismissal or "Not now" holds for the tree.
    - A question cancelled by its turn's end is asked again at the next hook.
  - Library hooks never ask.
  - `alp trust [--project] | --revoke | --list [--json]`.
- **Doctor:** the `hooks` check lists the agents' hooks and whether the project's are trusted. It warns when a hook's first word is not a shell word and is not found on `PATH` or relative to the project.

**Evidence.** `test/hooks.test.js` checks:
- library hooks at `session.start` and `turn.end`, with the payload on stdin, the `ALP_*` variables, the run log and `alp log`, and no trust question;
- that a project hook asks once; after "Trust this workspace" it runs, `trust.json` is written, and a later session with a newly added hook does not ask;
- that "Not now" skips the hook and a blocking `task.close` hook then does not block, with no second question in that tree;
- that trusted blocking hooks refuse a peer's handoff, main's `alp_merge` (nothing applied) and `alp_task close` (task stays in review) until their condition holds;
- that a `match.label` hook applies only to tasks with that label.

## 46. ACP providers as built (2026-10-09)

Goal (D23, phase 13, step 6): agents run on any agent that speaks the Agent Client Protocol (v1, stdio), not only Codex and Claude. This is a generic framework, tested with a scripted fake agent; no real ACP agent is wired.

- **Providers:**
  - `src/core/providers.js`: `validateProvider`, `loadProvider(library, id)`, `listProviders`, `acpModel`.
  - `providers/<id>.json` is `{ kind: "acp", label?, description?, command, args?, env?, models? }`. Unknown keys get a suggestion. `codex`, `claude` and `acp` are refused as ids.
  - Providers live in the library only. `libraryEntries('providers')` skips the project layer, and `library-edit` refuses the project scope (`INVALID_SCOPE`). A project's provider would run a command from its repository.
  - `providers` is an edit kind (`{ provider }`). `usedBy` lists agents whose `agent.json` names it, and project settings whose `runtime.provider` does. An agent naming a provider that is neither built in nor in the library is refused when saved.
- **Resolving:**
  - `RuntimeKind` gains `acp`. `resolveSession` takes the model `acp:<id>[/<model>]`, or an `agent.json` / settings `provider` that is not codex or claude.
  - The mapping keeps `model` as `<id>[/<model>]` and carries the provider as `mapping.acp`.
  - A model outside the provider's `models` is refused. `thinking` is always `none`. A review copy is refused: ALP cannot keep an ACP agent's commands inside it.
- **`AcpTransport`** (`src/runtime/acp-transport.ts`), behind the runtime's normalized protocol:
  - It spawns the command and sends `initialize` (protocol 1, no fs or terminal client capabilities: the agent uses its own tools).
  - `thread/start` maps to `session/new { cwd, mcpServers }`, then `session/set_model` when a model was chosen and the agent offers `models`.
  - `thread/resume` maps to `session/load` when `agentCapabilities.loadSession`; the history the agent replays is dropped. It fails otherwise.
  - `turn/start` maps to `session/prompt`. The first prompt of a new session carries the developer instructions. A turn after a cancel waits up to 10 s for the cancelled prompt's answer.
  - `turn/interrupt` maps to `session/cancel`, and answers open permission requests `cancelled`. `turn/steer` is refused, so `steerMail` delivers mail after the turn.
  - `thread/fork` is unsupported, and recall entries are not recorded for ACP assignments.
  - Session updates are mapped as follows:
    - `agent_message_chunk` becomes `item/agentMessage/delta`, then `item/completed` when the message ends.
    - `tool_call` and `tool_call_update` become `commandExecution` items.
    - `usage_update` becomes `thread/tokenUsage/updated`.
  - The stop reason `end_turn` completes the turn and `cancelled` interrupts it. Others fail it, as does a prompt error. An auth error says to sign in.
- **ALP tools:** the plan named a CLI bridge (`alp mcp-bridge --session`) through alpd's socket. As built, the bridge is self-contained:
  - When a session has ALP tools, the transport listens on a local socket (`$TMPDIR/alp-acp-*.sock`, or a named pipe on Windows).
  - It adds the stdio MCP server `alp` to `session/new`: `process.execPath -e <bridge>`, with `ALP_BRIDGE_SOCKET` and a random `ALP_BRIDGE_TOKEN`.
  - The bridge speaks MCP (`initialize`, `tools/list`, `tools/call`) and forwards to the socket. The first line must carry the token.
  - Calls run through the runtime's `item/tool/call`, shown as `dynamicToolCall` items. The agent's own tool call for them is not shown twice.
  - This works under the CLI's alpd and the plugin's copy of alpd alike, with no path to the package.
- **Permissions:**
  - `session/request_permission` goes to the runtime as `item/acp/permission`. `acpPermission(toolCall, tools)` reads its kind, its command (`rawInput.command`) and its locations.
  - `acpDecision`:
    - ALP's tools are allowed;
    - then the profile's Bash rules hold for the command (deny, allow, ask);
    - then the mode: read-only allows read, search, think and fetch; workspace-write allows all but paths outside the workdir and temp; full access allows all.
  - Beyond the mode, a profile with `beyondMode: "ask"` asks the user through `askPermission`, with "Always allow" adding `Bash(<command>)`. Otherwise it is refused.
  - Refusals and questions are logged as `permission`. The answer picks the agent's `allow_once`/`allow_always` or `reject_once`/`reject_always` option, else `cancelled`.
  - The session's instructions state the mode and that ALP's tools come from the `alp` server.
- **CLI and screen:**
  - `alp provider add|edit|show|cp|mv|rm|test` and `alp providers`. `alp provider test` runs `initialize` (`src/client/acp-probe.js`, on `mcp-probe`'s exported `stdioSession`) and reports the agent, `loadSession`, HTTP MCP and auth methods.
  - The settings screen has a Providers section (library only, hidden in the project panel), a provider form, a Test result, and ACP providers in the agent form's Provider select.
  - `alp.library.*` accepts `providers`.
- **Doctor:** the `providers` check lists them, warns when a command is not found, and always states the limits: no sandbox, no steer, resume only with `session/load`, no recall or review copies.

**Evidence.** `test/acp.test.js`, with `test/support/fake-acp.js`, checks:
- provider validation, the library-only scope, `usedBy`, `alp provider test`, and the doctor warning;
- a session on `acp:fake`: initialize capabilities, `session/new` with the `alp` server, instructions only in the first prompt, a streamed answer, tools listed and `alp_pin` called through the bridge (one tool item, no shell twin), and a command's output;
- permissions under a profile in read-only: a read allowed, an allow rule allowed, a deny rule refused, an edit beyond the mode asked and allowed, an ask rule asked and denied, with the run log; and `acpDecision` for workspace-write and full access;
- a cancelled turn (and a refused steer), a failed prompt, and an agent that exits;
- model choice through `session/set_model`, a model outside `models` refused, a missing provider, resuming through `session/load` without replayed history or repeated instructions, and the refused review copy.

`test/settings-screen.test.js` checks the Providers section, the provider form and the agent form's ACP options.

## 47. Two-column settings and beads-style tasks as built (2026-10-09)

Goal: the user found the settings screen and the Tasks panel hard to use. The settings screen becomes a two-column layout with a fixed, foldable aside and a secondary menu on top of the working area. The Tasks panel follows how beads-ui and beads_viewer (bv) show tasks.

- **`client/side-nav.tsx`:**
  - `SideNavLayout` draws the aside and the working area.
    - The aside has groups (first level), kinds with an icon and a count (second level), and the open kind's entries with a source dot (third level).
    - It is 216 px wide, or 52 px folded to icons. It folds on its own below 640 px (`COLLAPSE_BELOW`, measured with `onLayout`) until the user toggles it. In a compact layout it opens from Menu as an overlay with a scrim.
    - The working area has a breadcrumb, badges and actions, a row of tabs as the secondary menu, a scrolling body and a fixed footer bar.
  - `Pill` and `Button` are shared by the screens.
- **`client/library.tsx`:**
  - `navGroups(scope, lists)` builds the aside: Organisation (Teams, Agents), Capabilities (Skills, MCP servers, Hooks), Runtimes (Providers, library only).
  - `LibraryWorkspace` renders a kind's `KindOverview` or an entry's `EntryEditor` from a `Selection { kind, name?, creating? }`. Saving a new entry selects it; removing one returns to its kind. It replaces `LibraryLists`.
  - `KindOverview`: source tabs with counts, New, and a table of entries with source and override pills, description, users, Duplicate, and in the project scope Override in this project and Use library.
  - `EntryEditor`: tabs from `entryTabs(kind, saved)` (an agent: General, Instructions, Skills MCP & hooks; a team: General, Members, Delegation, Supervisor, House rules; Test only for a saved entry), a note on where the entry comes from, and a footer with Save or Save as my own, the state of the draft, and Remove. `AgentForm` and `TeamForm` take the tab; without one they render everything.
  - Members get one section each (in the team, role, model, thinking); delegation one section per member.
- **Tasks (`client/tasks-panel.tsx`):**
  - `TaskRow` adds `description` (up to 4000 characters), `labels`, `paths`, `progress { done, total }` of a parent's children, and `createdAt`.
  - The toolbar has List, Board and Epics, Refresh, New (title and P0–P4), the filters Open, Ready, Closed and All with counts (`filterTasks`), and a search.
  - List: `boardSections` groups, foldable, with bv-style rows (`stateOf` dot, type icon, priority badge, id, title, assignee, `age`) and a second line of blockers, gates, epic and labels. Approve stays inline.
  - Board: columns Needs approval, Blocked, Ready, In progress, In review, Closed, with four-line cards. Epics stay off the board.
  - Epics: progress bar, done/total, and the children as a foldable tree.
  - `TaskDetail`: fields, description, handoff, close, children, and Approve, Accept and close, Close or Reopen. From 820 px the detail sits beside the list (2:3); narrower, it replaces it.

**Evidence.**
- `test/settings-screen.test.js` checks the aside's groups and order, the breadcrumb and source tabs, the overview rows and actions in both scopes, the Menu button when compact, and each editor tab for agents, teams, hooks, providers and a new MCP server.
- `test/panel.test.js` checks the grouped list and its order, filters and search, `age`, the detail alone and beside the list, the board columns without epics, and the epics view.
- Both screens were looked at in an isolated Paseo 0.11.1 (web client against a daemon with its own home and `ALP_HOME`).

## 48. Main stays reachable as built (2026-10-09)

Goal (D24): the user reaches main while its assignments run, hears how the work is going, and is asked about requests that are unclear.

**Evidence of the problem.** In the user's `tools` session on 2026-10-09, main delegated to lead and sat in `alp_wait` from 14:49:59. Two messages from the user at 14:55 and 14:56 were steered into the turn. Codex and Claude show a steer only after the running tool call returns, so main answered 28 minutes later. Main had also delegated the first, open-ended request ("a web developer tools site") without asking anything.

- **The user's words end waits.** `startPrompt`, after a user steer of a root session, calls `releaseWaiters`. Each waiting `alp_wait` or `alp_delegate` call resolves with `'user'`.
  - `alp_wait` returns `{ events: [], userMessage: true, running, next }`.
  - A waiting `alp_delegate` returns `{ assignmentId, status: 'running', userMessage: true, next }`.
  - `next` tells main to answer the user first, steer what the user's words change, then wait again. Mail stays queued for the next wait.
- **Check-ins.** The watchdog calls `checkIn` for every requester with live assignments.
  - It posts mail of the new kind `checkin`, from `alp`. For the user-facing main, it posts every `checkInMs` (runtime option; default 10 minutes; 0 turns it off). For any requester, it posts once when an assignment passes its ETA.
  - The body lists each live assignment: agent, id, task, running time, last activity (or waiting for an answer, or paused), ETA, and the last note it sent (`Assignment.lastNote`). The closing line tells main to update the user in one or two lines and act on late or silent work.
  - `waitFor` accepts check-ins in every wait. A waiting `alp_delegate` that gets only a check-in returns `status: 'running'` with the events and `next`. A result in the same batch wins.
  - Check-ins are not passive, so they steer a running turn or wake an idle one. A wake whose mail is only check-ins does not count toward `MAX_WAKES`.
  - A held (parked or paused) requester gets none. ETAs are not kept across an alpd restart.
  - The watchdog looks every 30 s at most (`watchMs` overrides it, for tests).
- **ETA.** `alp_delegate` takes `etaMinutes`, an integer from 1 to 1440, in the Codex and Claude schemas. It sets `Assignment.eta`.
- **Instructions.** The user-facing main gets two paragraphs, in the runtime and in `templates/agents/main/AGENT.md`:
  - Unclear requests: ask once, two to four questions with options and a recommended default, and the offer to decide with them. Use `alp_ask` with options while work runs.
  - Staying reachable: announce work that takes more than a few minutes, with who does it and an ETA. Delegate it with `wait: false` and `etaMinutes`. Answer the user first when a wait ends early. Report on check-ins.

**Evidence.**
- `test/reachable.test.js` checks:
  - a user steer ends a waiting `alp_delegate` and `alp_wait`, and the result is collected afterwards;
  - ten check-in wakes of an idle main, more than `MAX_WAKES`, each with running time, last activity, ETA and last note, then the result still wakes main;
  - an ETA passed under a shifted clock ends a waiting delegate with one check-in, and the next wait gets the result;
  - invalid `etaMinutes` values;
  - main's instructions and schema.
- `test/team.test.js`: user steering now ends the parent's wait, and `alp_wait` collects the lead's result.

## 49. An agent's library skills in the editor as built (2026-10-09)

Goal: the user saw no skills on main in Settings → ALP, though main gets six. Those come from `role-skills.json` in the library, keyed by agent name (`librarySkills` in `src/core/library.js`). The agent editor showed only `agent.json`'s `skills`.

- **Core (`src/core/library-edit.js`):**
  - `getEntry('agents', …)` adds `librarySkills`, the agent's list in `role-skills.json`, whatever layer defines the agent.
  - `setGivenSkills(agent, skills, { library })` writes that list through a temporary file. It drops duplicates, refuses skills not in the library, and removes the key for an empty list.
- **RPC:** `alp.library.skills { agent, skills }`, and `librarySkills` on `alp.library.get`.
- **Editor:**
  - In the library scope, an agent's skill switches show the union of `librarySkills` and `agent.json`. A given skill is hinted "Default for this agent".
  - Turning a switch on adds the skill to the library's list. Turning it off removes it from the list and from `agent.json`.
  - Save writes the entry when its content changed, then the list when it changed. A built-in whose only change is its skills is saved as "Save", with no copy, so it keeps ALP's instructions.
  - In the project scope, given skills show on and locked; the others edit the project copy's `agent.json`.
  - The editor is keyed by the list too, so a reload shows what was saved.

**Evidence.**
- `test/library-edit.test.js`: a built-in main's `librarySkills`, setting the list without a copy, resolution, an unknown skill refused, and an empty list removed.
- `test/settings-screen.test.js`: the hinted switch in the library and the locked one in a project.
- `test/paseo.test.js` and `test/panel.test.js`: the RPC list.

## 50. Requesters hear their own mail while they wait (2026-10-09)

Goal: the D24 fix let the user's words end main's waits; lead had the same gap one level down. In the user's `tools` session, main steered lead at 15:05:07 with the user's new style requirement. Lead was waiting for peer in `alp_delegate`, whose waiter took only the peer's result or question. Lead read the steer at 15:16:24, when the peer finished.

- `waitFor(sessionId, …)` accepts, besides what the caller waits for and check-ins, any mail addressed to the waiting session itself (`event.assignment === sessionId`): its requester's steer or note, and the user's direct words. `alp_wait` with named assignments and a waiting `alp_delegate` now return on it.
- A waiting `alp_delegate` returns `status: 'running'` with the events. `next` tells the session to act on the mail, pass on what changes its assignments' work with `alp_send`, then wait again.
- Deferred mail (the supervisor's) and board mail still never end a wait.

**Evidence.** `test/reachable.test.js`: in a Cafe tree, main's steer ends lead's waiting `alp_delegate` for its peer, which keeps running, and main's note ends lead's `alp_wait` for that named assignment.

## 51. Background first as built (2026-10-10)

Goal (D25): agents delegate and run long tools in the background, and wait only when their next step needs the result, so the user can chat with main at any time.

- **Default.** `alp_delegate` returns `{ assignmentId, status: 'running' }` at once unless `wait: true`. The schema's description, the delegation instruction and the run log's `wait` field follow.
- **Instructions:**
  - The delegation instruction for every requester: work runs in the background; pass `wait: true` only when the very next step cannot go on without the result; go on with independent work; when only results are left, `alp_wait`, or end the turn and be woken.
  - Main's "Stay reachable" paragraph: end the turn rather than wait, since notes do not wake it.
  - A new line for every session, "Background first": run long shell commands in the background when the tools allow it, and in the foreground only when the next step needs their output.
  - The templates follow: main's "Staying reachable" and lead's new "Background first" section.
- **Notes do not wake.** In `deliver`, an idle session is woken only by mail other than notes from its own assignments: results, questions, check-ins, and its requester's or the user's mail. Notes still end waits and steer running turns, and ride with the next turn. A session with no live assignments is woken by whatever is left, so a finished requester still ends.

**Evidence.**
- `test/reachable.test.js`:
  - main gets `status: 'running'` with no `wait`;
  - a note leaves an idle main asleep and rides with the result's wake;
  - the instructions say background first.
- `test/team.test.js`: the wake-limit test now counts the requester's steers, after a peer's note wakes nothing.
- Tests that relied on waiting now pass `wait: true`.

## 52. A sharper supervisor (2026-10-10)

Goal: a review of the user's `tools` session showed the supervisor missing the turn where main left the user waiting 28 minutes on a vague request, and sending two wrong findings. One claimed a recurrence that main's later, refining lesson allowed. The other held main to the supervisor's own commit attribution (Sonnet 4.6, where main runs Opus 5.5). The user chose all five fixes, with Sonnet 5 as the model.

- **Times.** Every journal line is stamped with its local time (`stamp`). `eventful` ignores the stamp.
- **Waiting.** A supervised root records `userWaiting` when the user asks or steers.
  - Main's first non-empty message after that adds "main answered the user N after their message of HH:MM:SS".
  - A turn that ends with no final message while the user waits adds "the user's message of HH:MM:SS got no reply in this turn".
- **Main's session.** The digest states main's runtime, model, effort and mode, and says the supervisor's own system prompt describes its session, not main's.
- **Checklist** (`templates/agents/supervisor/AGENT.md`): unclear requests built without asking once; the user left waiting, or long work started unannounced; blocking where work could run in the background (D24, D25). Main is judged by its own session.
- **Lessons.** The supervisor reads every lesson. A later lesson on the same point refines or replaces an earlier one, so a recurrence means the latest applicable lesson was broken. This is said in the template and in the runtime's lessons line.
- **Model.** Phở and Cafe run the supervisor on `claude:claude-sonnet-5` with medium effort.

**Evidence.**
- `test/supervisor.test.js`:
  - stamped digest lines, the answered-after line, and the session line;
  - the new checklist and lesson rules in the supervisor's instructions;
  - Sonnet 5;
  - a new test for "got no reply in this turn".
- `test/paseo.test.js`: the supervisor child on Sonnet 5.

## 53. Taking over from a limited runtime, and answering the user (2026-10-10)

Goal: in the user's `tools` session on 2026-10-10, Codex hit its usage limit and the Codex peer was parked. The user asked main to switch to Claude, and the tree deadlocked until the reset:
- lead could start no other child, not even a read-only reviewer or oracle ("A child assignment is already running");
- main could not start a reviewer while lead, a shared writer, was open;
- lead's handoff failed (its tool input reached ALP unparsed), and its turn ended waiting on the parked peer.

Throughout, main answered the user's two messages only with tool calls.

- **`alp_cancel { assignmentId, reason? }`** (requester tool, Codex and Claude schemas) ends a running or parked assignment as `canceled` through `finishAssignment`, quietly, with its own assignments. Its changes stay where it made them. Its task goes back to open, it leaves the parked list, and the run log records `assignment.canceled`. An agent name works when it names one live assignment.
- **Parking a held assignment wakes the requester.** A park that ends only when the user resumes (usage limit, `alp pause --now`) posts `stalled`, not a passive note. It says the requester can wait, start other work, or `alp_cancel` it and delegate the rest on another runtime. A park that continues by itself (a restarted process) stays a passive note.
- **Read-only beside writers.** Read-only peers, advisors and reviewers start beside any running assignment. A writer is refused only beside another writer, unless both have their own worktree; a parked writer still counts. The refusal names a parked assignment and suggests `alp_cancel`.
- **Answer the user.**
  - Every root records `userWaiting` when the user asks or steers, and clears it at main's first non-empty message.
  - From a minute on, every ALP tool result of that root (except `alp_ask`) carries `userWaiting`: the user wrote at HH:MM:SS, has had no reply for N, and tool calls alone show them nothing.
  - `USER_WROTE` says the same.

**Evidence.**
- `test/pause.test.js`: a parked Codex writer wakes main with the `alp_cancel` advice; a second writer is refused with a `next` naming the parked one; a Fable reviewer starts beside it; `alp_cancel` closes it, reopens its task and empties the parked list; a Claude peer takes the task.
- `test/reachable.test.js`: the reminder appears after a minute and stops after main's message.
- `test/runtime.test.js`: `alp_cancel` has a Claude schema.
- `test/golden/log.txt`: the usage-limit park is mail of kind `stalled`.

## 54. The user's language (2026-10-10)

Goal (D26): the user reads one language, set in ALP settings, and everything that reaches them is written in it, approvals above all. Unset, it is Vietnamese.

- **Setting.** `language` in `$ALP_HOME/settings.json`, a language name of at most 40 characters (`validateUserSettings`). `src/core/user-settings.js` reads it (`userLanguage`: the setting, else Vietnamese; a broken file falls back too), shows it (`languageSetting`) and writes it atomically, keeping the file's other keys (`setLanguage`, `null` clears it).
- **Where it is set.**
  - Settings → ALP has a General group with **Language**: a list of common languages (Tiếng Việt, English, 日本語, 한국어, 中文, Français, Deutsch, Español), Other with a name to type, and Reset to the default. RPC `alp.settings.language.get` and `alp.settings.language.set`.
  - `alp language [name | --reset] [--json]`.
- **Sessions.** `resolveSession` resolves the language for each session (`RuntimeOptions.language`, else the setting), so a change applies to new sessions. Each session's instructions get one line (`languageInstruction`):
  - a root session (main) writes in it everything the user reads: replies, `alp_ask` questions and options, approval requests and what it says about them, gate notes, and task titles and descriptions. Briefs, handoffs and mail between agents may use any language; GitHub issues follow the repository;
  - an assignment puts its `alp_ask` questions to the user in it;
  - the supervisor checks that main does.
- **ALP's own words** (`src/runtime/language.ts`). Vietnamese and English word tables cover:
  - `alp_skill` and `alp_issue` approvals, with their choices (Duyệt / Từ chối);
  - permission questions (Cho phép lần này / Luôn cho phép / Từ chối);
  - the hook trust question (Tin cậy workspace này / Để sau);
  - the usage-limit, usage-warning, pause and resume notices, written per root session.
  Another language gets English from ALP. Answers in either language count (`CHOICES`, `APPROVALS`).
- `templates/agents/main/AGENT.md` and the supervisor's checklist now refer to the language ALP names.

**Evidence.**
- `test/language.test.js`: the setting and its default; the word tables and answers in both languages; main's and an assignment's instruction line; a setting picked up by a new session; `alp language`.
- `test/permissions.test.js`: a default (Vietnamese) permission question, its choices and body, and answers in both languages.
- `test/settings-screen.test.js`: the General → Language view.
- `test/panel.test.js`, `test/paseo.test.js`: the two RPCs.
- Tests that assert ALP's English text run with `language: 'English'`.

## 55. One Tasks pill (2026-10-10)

Goal: on the phone the composer showed two pills: Paseo's own "0/1 tasks", made from the todo list ALP reports at the end of a turn, which lists tasks but opens none; and ALP's "Tasks · 2" (PR #45). The user chose to keep one, ALP's.

- The provider no longer sends the todo item to Paseo. It keeps the ids by the session id Paseo knows (`server/session-tasks.ts`), and `alp.tasks.list` returns them as `sessions`, limited to the project's tasks.
- A pill finds its session by the agent's persistence handle (`persistence.sessionId`), which is not the agent's id, then by the agent's id.
- The pill lists the session's tasks first, done ones as Done, then the project's other open tasks, at most eight in all; its label counts the session's done tasks ("Tasks · 1/2"). Without session tasks it counts open tasks as before.
- The runtime and `alp run` keep the todo list.

**Evidence.**
- `test/paseo.test.js`: a task main started is kept for the pill, and Paseo gets no todo item.
- `test/panel.test.js`: menu order and label with session tasks; a pill finds its session through the persistence handle.

## 56. Turns the runtime starts by itself (2026-10-10)

Goal: in the user's `tools` session, main ran its CI watch in the background, as D25 asks. When the command ended, Claude Code answered in a turn of its own, which ALP had not started. ALP refused every tool call in it ("ALP tools are unavailable"), so main could not close its task.

- `ClaudeTransport` adopts such a turn: the first message of the session's own (not a sub-agent's) that arrives with no turn running starts one with a new id and reports `turn/started`. The result ends it with `turn/completed`, as for any turn.
- The runtime follows a `turn/started` it did not ask for when no turn of its own runs: the turn becomes the session's active one, with `turn.started` of origin `runtime`. ALP's tools work in it, and its end runs the usual turn-end path: hooks, supervisor review, the todo list and settling. A `turn/started` while ALP's own turn runs changes nothing.

**Evidence.** `test/reachable.test.js`: the transport adopts a turn once, not for a sub-agent; the runtime follows a turn the runtime started, `alp_board` works in it, its end is a turn end, and a late report does not take over ALP's turn.

## 57. The runtime compacts; ALP keeps its state (2026-10-10)

Goal (D27): §35 measured a Claude session against a 200k window it guessed until the first result. Assignments run one turn and never see a result, so a peer on Opus 5.5 (1M) was told to hand off now at about 164k. Amp's experience (D27) is that pushing agents to manage their context is not worth it. So the runtime compacts, ALP measures against the point where it does, sees it happen, and gives the session ALP's state again after.

- **Measuring.**
  - `ClaudeTransport` reads `getContextUsage({ detail: 'summary' })` once the session starts. `rawMaxTokens` is the window and `autoCompactThreshold` is where Claude compacts. Measured on 0.3.292: Opus 5.5, Fable 5.1 and Sonnet 5.5 have 1M and compact at 967k; Haiku 4.5 has 200k and compacts at 167k; `autoCompactWindow: 400000` gives 400k and 367k.
  - `thread/tokenUsage/updated` carries `autoCompactTokens` when known. Before Claude has said what its window is, `modelContextWindow` is `null` and ALP says nothing; a result's window is used only when none was measured.
  - Codex reports its window itself. ALP takes 90% of it, or of the context setting, as the compaction point.
- **The advisory.** Once per filling, at 90% of the compaction point, one note: an assignment keeps working, with no handoff needed for it; a root keeps pins and task notes current. Below 50% of the compaction point, or after a compaction, it may come again. Supervisors are skipped. The run log records `{ event: 'context', tokens, compactAt, level: 'soon' }`. Log entries from §35 still print as before.
- **Seeing a compaction.**
  - Codex reports one as a `contextCompaction` item, started then completed. `ClaudeTransport` reports Claude's in the same shape: from `status: 'compacting'` to `compact_boundary`, with `trigger`, `preTokens` and `postTokens`. A `compact_result: 'failed'` completes it as failed.
  - The runtime shows it as a timeline item `compaction` (`running`, then `completed` or `failed`). The Paseo provider maps it to Paseo's own compaction row, or to a warning when it failed.
  - The run log records `{ event: 'compacted', trigger, preTokens, postTokens }`, which `alp log` prints as `◑ peer's context compacted from 89k to 12k`. A supervisor's journal notes it.
- **Restoring after it.** A completed compaction posts one note from `alp` (steered in during a turn, passive otherwise). It holds:
  - for an assignment, its brief as given (task brief, continuation and words, up to 8000 characters); it is kept on the session and in the live book, so a recovered assignment has it too;
  - the session's open assignments with their state and age, finished worktree changes waiting for `alp_merge` or `alp_discard`, and its questions waiting for the user;
  - for a root, the task digest and the board.
- **The context setting.** `agent.json` may set `context`: `"auto"` (the default, the model's) or 100000 to 1000000 tokens. Claude gets it as `autoCompactWindow`; Codex as `model_auto_compact_token_limit` at 90% of it; ACP agents ignore it. Settings → agent → General has a Context select: Auto, 200k, 400k, 600k or 1M.

**Evidence.** `test/context.test.js`:
- for a peer: nothing below the compaction point, one note at 82k of 90k without `alp_handoff`, the compaction shown running then completed, logged, and the brief returned; a reported compaction point is used, and the note comes again after a compaction; a failed compaction is logged and changes nothing else;
- main gets its open assignments and tasks after a compaction, and between turns a passive note with no turn;
- the setting reaches Claude as `context` and Codex as `model_auto_compact_token_limit` (400k → 360k), and bad values are refused;
- `ClaudeTransport` reports no guessed window, then the measured one over a result's, and a compaction from start to boundary, and a failed one.

`test/golden/log.txt` shows the advisory, the compaction and the restore note.

## 58. Asking a paused runtime about its limit (2026-10-10)

Goal (D28): a Codex limit paused Codex at 07:55. The limit reset at 12:35, but with `autoResume` off by default, Codex stayed paused until the user noticed at 13:28 that main could not delegate to it. The reset time was also only a guess: a limit can lift early.

- While a pause `by: 'alpd'` holds a runtime, `watchLimits` runs one interval timer (`LIMIT_CHECK_MS`, 60 s; `limitCheckMs` in tests). Each tick runs `checkLimit` for each paused runtime. The timer stops when no limit pause is left.
- `limitLifted` asks the runtime through the `orchestrationContext` of a session open on it. Without such a session, it starts a short-lived transport in the temp directory and closes it after. `ClaudeTransport` answers without a session by starting a Claude process that sends no prompt: `usage_EXPERIMENTAL…`, about 1.8 s. Codex answers `account/rateLimits/read`, about 1 s. No model call is made.
- `usageAllows` (in `runtime-context.ts`) is `true` when every known window is below 100% and Codex's spend control is not reached, `false` when one is used up, and `undefined` when the report says nothing.
- When it is lifted, or unknown and the earlier reset time is a minute past:
  - `autoResume` (now default true in alpd): resume, so parked assignments continue, with the notice "resumed by alpd, after the limit lifted";
  - `autoResume: false`: one notice per pause (`limitLifted`), and the user resumes.
- Each check stamps `checkedAt` on the pause, saved with it; `alp ps` prints "last asked … ago".
- `alp_delegate` to a runtime a limit paused calls `checkLimit` first, unless the last check was under 15 s ago (`LIMIT_FRESH_MS`).
- At start, pauses an earlier alpd left are checked at once.
- Pauses the user made are never checked or lifted.
- The limit notice and the parked note say that ALP resumes by itself, or that the user runs `alp resume` when `autoResume` is off.

**Evidence.** `test/limit-watch.test.js`:
- `usageAllows` on Codex and Claude reports, spend control, and unknown;
- a limit pause is checked each interval and resumed when the report clears;
- a delegation asks at once and goes ahead, and the parked peer continues;
- with `autoResume` off, one notice and the pause stays;
- at start, a left pause is checked by a probe process, which is closed after; a report that clears before the reset time resumes it, and a user pause is left alone.

Live: a probe of the real Codex (28% / 59%) and Claude (9% / 48%) without a session answered `true` in about 1 s and 1.8 s.

## 59. Agents that use their skills (2026-10-10)

Goal (D29): in the user's `tools` project, Codex agents read their skills in every session (lead 3/3, peer 4/4). Claude agents rarely did: lead read one in 3 of 9 sessions, always prompt-leverage, and peer read none in 4. Four Claude lead sessions made 10 commits without reading smart-commits. The instructions listed only a name and a path ("read a SKILL.md only when needed"), and Claude did not see ALP's skills among its own.

- **The listing.** `InstructionsAdapter` lists each skill as `- name (path): description`, with the frontmatter `description` (plain, quoted or folded, clipped to 400 characters by `skillDescription`). It tells the agent to read a skill's `SKILL.md` before work its description matches, and to say which skill it uses. Bodies stay lazy.
- **Claude's own skills.**
  - `nativeSessionConfig` passes `skills: [{ name, path }]` to Claude sessions.
  - `ClaudeTransport` builds a plugin, `skillPlugin`, in `$TMPDIR/alp-skills/<uuid>`: `.claude-plugin/plugin.json` names it `alp`, and `skills/<name>` links each skill's directory. It is passed as `plugins: [{ type: 'local', path, skipMcpDiscovery: true }]`, rebuilt on a restart, and removed on close. If it cannot be made, the listing still names the files.
  - The instructions add that the skills are Claude Code skills `alp:<name>`.
  - `Skill` joins the tools a read-only session may use; what a skill leads to is checked as itself.
- **Logging use.** `skillUse` looks at each started item of a session with skills. Claude's Skill tool appears as the command `Skill {"skill":"alp:<name>"}`; a command or tool input naming the skill's `SKILL.md` counts as reading it. Each skill is logged once per session as `{ event: 'skill', agent, skill, via: 'skill' | 'read' }`, and noted in a supervisor's journal.

Only the agent's own skills are listed or loaded; the others' files stay readable on disk, but nothing points to them.

**Evidence.**
- `test/skill-use.test.js`:
  - Claude gets the skills and the `alp:` note, and Codex gets the descriptions only;
  - use is logged once per skill, by reading or by the Skill tool, and an unknown skill is not logged;
  - the plugin links each skill directory and is made again from scratch;
  - a read-only session may run Skill but not Write.
- `test/skills.test.js`: the listing carries each shipped skill's description, and `skillDescription` handles plain, quoted, folded, missing and long text.
- Live: a read-only Claude session given peer's skills listed `alp:bug-loop`, `alp:smart-commits` and `alp:xia`. Asked to debug, Haiku 4.5 ran `Skill {"skill":"alp:bug-loop"}`, and the plugin directory was gone after close.

## 60. ALP as an ACP agent (2026-10-10)

Goal (D30, step 1): editors that speak the Agent Client Protocol use ALP as their agent. `alp acp` serves ACP v1 on stdio with `@agentclientprotocol/sdk` 1.7.0, bundled into `dist/acp.js`. It is a client of alpd, as the Paseo plugin is (`src/acp/agent.ts`), and starts alpd when needed.

- **Initialize.** `loadSession`, `sessionCapabilities.list` and `close`, embedded context in prompts, and http/sse MCP servers. No authentication: alpd uses the user's Codex and Claude logins.
- **A new session** gets an id `acp-<uuid>` and a preview from the new `session.preview` RPC (`runtime.preview(spec)`): the project's teams, and the team, main, model and mode it would run with. The team is the one chosen, else settings' `workflow.mode`, else Phở (`DEFAULT_TEAM`), as Paseo does. Config options: `team` (category `model`) and `mode` (category `mode`, also as the legacy `modes`). The session opens in alpd on its first prompt (`session.create`, `persist: true`), so the team can change until then; after that only the mode can, through `session.configure`.
- **Prompts.** Text, `@path` for a resource link, and an embedded resource inlined as `<file path>`. `session.prompt` with `delivery: 'auto'`, so a turn main started by itself takes the words as a steer. The prompt answers when its turn ends: `end_turn`, `cancelled`, or an error for a failed turn. `session/cancel` is `session.interrupt`, which stops the subtree.
- **Updates**, from the root's events only; children show through main's `alp_delegate` tool call:
  - assistant text as `agent_message_chunk`, only what is new since the last snapshot of the item;
  - tool calls as `tool_call` then `tool_call_update`, with a kind from the tool or the command's first word (Claude's `Read {…}` is `read`, `Edit` is `edit`, a shell command is `execute`) and the output, clipped to 20,000 characters;
  - mail and ALP's own prompts to main as a completed `other` tool call "ALP: …", not as the user's words; another viewer's prompt as `user_message_chunk`;
  - notices and compactions as a quoted `ALP:` line, the task list as a `plan`.
  Updates go out in order, and a prompt answers after its updates. Work after the prompt (wake turns) streams into the thread too.
- **Questions to the user** appear as a message with the options. `/answer <text>` and `/dismiss [reason]` (offered as available commands) answer the oldest open question of the tree.
- **List and load.** `session/list` lists persistent roots of the project. `session/load` attaches with replay: the history comes as updates before the answer, the user's prompts as `user_message_chunk`. A closed root reopens on its next prompt (`resume`). A session of another project is refused.
- **Editor MCP servers** become `mcpServers` of the spec, beside the agents' own.
- When the editor closes stdin, each open root is released: alpd closes it once idle and lets running work finish.

**Evidence.** `test/acp-agent.test.js`, an editor over in-memory ndjson streams against an in-process alpd with scripted agents:
- a new session lists Phở and Cafe, starts nothing until the first prompt, takes Cafe and read-only, and opens with them; text arrives as deltas, a command as a tool call with its output, the user's words are not echoed, and the team is fixed after;
- a question from main reaches the thread and `/answer SQLite` answers it;
- cancel ends a turn as `cancelled`; a second editor lists the session by its first prompt and loads its history, and a load from another project is refused;
- prompt blocks and ACP MCP servers convert as expected.

Live: `node src/cli.js acp` on a temp `ALP_HOME` answered `initialize` (version 0.6.0), `session/new` in an empty directory (set up as an ALP project; Phở and Cafe, full access) and `session/list`.

## 61. The local web app (2026-10-10)

Goal (D30, steps 2–3): installing ALP is enough to code from a browser. alpd serves a web app shaped after Paseo's, and the page speaks alpd's own protocol, so it sees whole trees, tasks and questions.

- **Serving** (`src/daemon/web.ts`): an HTTP server on `127.0.0.1`, port 7433 or `settings.web.port` (the next of 10 when busy), started after the socket unless `settings.web.enabled` is false; alpd runs on without it if it cannot start. `$ALP_HOME/web.json` (0600) holds `{ port, token, url, pid }`; the token is made once and kept, so an open page survives restarts.
  - The page, its script and stylesheet are built by esbuild from `web/` and embedded in `alpd.js` (`alp:web`), so alpd needs no files beside it, under the CLI and under Paseo alike. Any path without an extension gets the page.
  - Every response checks `Host` is `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding), and sends `Content-Security-Policy` (`default-src 'self'`, sockets to this port only), `X-Frame-Options: DENY` and no caching.
- **The socket** `/ws` needs the token (compared in constant time) and an `Origin` of the page itself, so no other site in the browser can reach alpd. Messages are alpd's JSON-RPC, one per WebSocket message, through `DaemonServer.accept(send)`, a connection like a socket client's: `daemon.hello` first, events as notifications. `ws` is bundled; the bundles carry a `require` shim for it.
- **New RPCs** for viewers outside Paseo (`src/daemon/workspace-rpc.ts`), acting as the user as the plugin's server does:
  - `tasks.list` / `tasks.add` / `tasks.change` (close, reopen, approve), with the rows the Tasks panel shows, now in `src/core/task-rows.js` and shared with the plugin;
  - `project.browse { path? }`: the folders in a directory (hidden ones left out, at most 500), whether each is an ALP project;
  - `project.changes { projectRoot }`: branch, `git status` files and `git diff HEAD`, clipped to 400,000 characters.
- **`alp web [--print]`** starts alpd when needed, waits for this alpd's `web.json`, and opens `<url>#token=<token>`. The token rides in the fragment, which the browser never sends; the page keeps it in localStorage and drops it from the address.
- **The page** (`web/src`, React 19, about 220 KB):
  - The connection says hello, reconnects with backoff, and replays each followed tree after alpd comes back. Items are snapshots by id (§4.2), in the order first seen, rendered once per frame.
  - **Sidebar**, rebuilt after Paseo's own (`left-sidebar.tsx`, `sidebar-workspace-list.tsx`, `theme.ts` there), on request on 2026-10-10:
    - nav rows New session (⌘⇧O; the project on screen, else the latest), History (every session by day, searchable) and Search (⌘K, a palette over sessions and projects);
    - a "Projects" section: each project's row has Paseo's 16 px identity square (initial on one of its ten colors, by the same hash of the path), a chevron on hover, and on hover a new-session button and a menu (new session, copy path, remove an empty one); clicking folds it, remembered;
    - its sessions as Paseo's workspace rows (36 px, radius 8, indented 16, title at 76% opacity), with Paseo's status slot: a blue ring while working, an amber alert when an agent asks the user (`question.list`), a red dot when failed; six show, the rest under "Show N more"; a folded project carries its busiest state as a badge on its square;
    - a session row's menu, Paseo's (`sidebar/sidebar-workspace-menu.tsx` there), on request on 2026-10-10: a "⋮" at the row's end on hover (or right-click) opens a 260 px menu with Copy path, Copy branch name (`project.info`), Rename session (in place: Enter saves, Escape cancels), Mark as unread / read, Pin to top / Unpin, Labels › (a page of labels to check, and a new one typed in), Open in file manager (`project.reveal`) and Archive (⇧⌘⌫ archives the session on screen, after a confirm);
    - read state, pins and labels belong to the browser, as Paseo keeps them per client (`web/src/prefs.ts`, localStorage): a finished session updated since the user last had it on screen shows Paseo's green dot (the first visit counts everything as seen); an idle one shows a faint 6 px dot; pinned sessions sit in a "Pinned" section above the projects with their project's square, and labels show as chips under the title;
    - a footer line: open a project, help, and settings (appearance: system, dark, light);
    - 320 px wide by default, resizable from 200 to 600 (double-click resets), hidden with ⌘B.
    Sessions are polled every 4 s with `session.list`, pauses with `daemon.pauses`; a pause banner shows above the session. Colors are Paseo's: sidebar `#141716`, hover `#1E2120`, selected `#272A29`, status dots `#5caaf6`, `#35c264`, `#f7796d`, `#db932e`, and its light theme.
  - **Rename and archive** are alpd's, so every viewer sees them: `session.rename { sessionId, title }` (a root; 1–200 characters, whitespace folded; the record keeps its time) and `session.archive { sessionId, archived? }` (a root; closes it with its tree and sets `archived` on its record). `session.list` leaves archived sessions out unless `includeArchived`; History shows them under "Show archived" with Unarchive, and a new turn on an archived session brings it back. `project.info { projectRoot }` gives `{ git, branch? }`; `project.reveal { path }` opens an existing absolute directory with `open`, `explorer` or `xdg-open`.
  - **Session:** the header (title, project, team, main's model, permission select while idle, side-panel toggle); the timeline (user bubbles; Markdown replies; tool rows with icons by kind, expandable output, and for `alp_delegate` a link to the child's session; mail and ALP's prompts as collapsed notes; notices; compaction dividers; task lists); questions with options, a reply box and dismiss; the composer (Enter sends, Shift+Enter for a new line, stop while running). A message to a running root steers it; to a closed one resumes it (`session.create` with `resume`); to an assignment goes as the user's mail (`session.message`).
  - **New session:** `session.preview` for the teams and main; a team and permission select in the composer; it creates `web-<uuid>` with `persist: true` and prompts.
  - **Side panel:** Team (`session.status` every 2 s: agents and their state, assignments, worktrees to merge), Tasks (sections as the Paseo panel; approve, close, reopen, add), Changes (files and a diff by file).
  - The Markdown renderer builds React elements and never inserts HTML, so an agent's text cannot run in the page that holds the token; links must be http(s).
  - Paseo's dark palette and tokens, with a light scheme; the side panel hides under 900 px, the sidebar under 640 px.

**Evidence.**
- `test/web.test.js`, with an in-process alpd on a free port:
  - the page and its headers, any route serves it, a missing file is 404, another Host is 403, and `web.json` records where;
  - a socket with a wrong token is refused (401), from another origin is refused (403), must say hello first, and answers `session.preview`;
  - tasks added, listed and closed; a directory that is not a project is refused; folders browse with their project flag; changes without git and with an untracked file;
  - a root renamed (folded whitespace; empty and unknown refused), archived (closed, gone from the list, there with `includeArchived`) and unarchived; `project.info` without git and on a branch; `project.reveal` refuses a relative or missing path;
  - settings accept `web.enabled` and `web.port` and refuse a low port and unknown fields.
- Live, on a temp `ALP_HOME` and port 7533: `alp web --print` started alpd and printed the address; the page connected, a new Phở session in read-only ran `ls` on Claude Opus 5.5, its tool row and Vietnamese reply streamed in, the Team tab showed main and the supervisor, Changes listed the untracked files, and dark and light schemes rendered.
- Live, for the session menu: the menu opened from the kebab with Paseo's eight items; a label checked and one added, the session pinned (it moved to Pinned with its square and chips), renamed in place, marked unread (green badge), archived (it left the sidebar and showed under Show archived) and unarchived (back in Pinned).

## 62. The ALP web app on Paseo's app (2026-10-10)

Goal (D31): the browser app is Paseo's own web app, so it feels like Paseo, with ALP underneath. Steps 1–2 here: the build and the protocol core.

- **Build** (`scripts/build-paseo-web.mjs`, `paseo-web/`): `paseo-web/upstream.json` pins Paseo's repository and commit (0.11.2, `b63a325`); `paseo-web/patches/` holds ALP's changes as `git format-patch` files; `paseo-web/LICENSE` is Paseo's Apache 2.0 licence and `paseo-web/NOTICE` says what ALP changes. The script keeps a checkout in `.cache/paseo-web` (or `$ALP_PASEO_SRC`) at the pinned commit, applies the patches, installs the monorepo only when its lockfile changed, runs Paseo's patch step and `build:app-deps`, and exports the app with `expo export --platform web`. The export, with `.br` and `.gz` copies of each text file, the licence, the notice and `alp-web-app.json` (commit and patches), goes to `dist/web-app` and beside the Paseo plugin's alpd. A build takes about 70 s after the first install; the app is about 21 MB, 2 MB brotli.
  - Patch 1: on the web the app connects to `location.host` with the token from the `#token=` fragment, passes it as the host password, refreshes a stored password only when a different one comes (probing again with the same one would replace the live client), and never falls back to a Paseo daemon on `localhost:6767`. `public/alp-token.js` runs before the bundle, keeps the token in localStorage as `alp.token` and drops it from the address, since the app's router rewrites the URL before the app reads it.
  - Patch 2: the app is named ALP (title, manifest).
  - Patch 3: a viewed-timeline sync made for a new client starts from the connection state it already has; Paseo only told it on the next change, so a replaced client never loaded a timeline.
  - Patch 4: ALP's logo (from the ALP website's `logo.svg`, `alp-wordmark-on-light.svg` and `apple-touch-icon.png`): the in-app mark (`PaseoLogo`, kept by name) draws the ALP wordmark in the theme's foreground colour; the status favicons are the ALP tile with Paseo's blue (running) and green (attention) dots; `favicon.png`, `icon.png`, the PWA icons and the Apple touch icon are the ALP tile.
  - Patch 5: the interface says ALP where it said Paseo, in every language ("an ALP server" in English; Paseo's Spanish strings had the name glued to its neighbours and are spaced), and `alp daemon status` for Paseo's CLI; `paseo.json` and `$PASEO_PORT` stay, as names of Paseo features ALP has not got. Star and "Create GitHub issue" link to ALP's repository, the startup screen's docs to its README; the Sponsor and Discord links are gone.
  - Patch 6: an `rpc_error` with code `not_implemented` shows alpd's text as a toast ("Tính năng đang phát triển" in the user's language), at most once every 5 s for each request type, and the error the app shows elsewhere (a failed terminal, a failed fork) is that text alone, without Paseo's request type and code after it.
  - Patch 7: no "What's new" in the help menu or the settings, since it showed Paseo's release notes, not ALP's.
  - Patch 8: a catalog entry whose bundle reads `alp-preloaded:<id>:<digest>` runs the factory the same-origin script `/alp-plugins.js` registered as `window.__ALP_PLUGINS__[id]`, instead of evaluating code, so the page keeps a CSP without `'unsafe-eval'` (step 7). `index.html` loads that script after `alp-token.js`.
  - To change the app: commit on top of the pinned commit in a Paseo checkout, `git format-patch` into `paseo-web/patches/`, and rebuild.
- **Serving** (`src/daemon/web.ts`): when `dist/web-app` (beside `alpd.js`, or `$ALP_WEB_APP`) has an `index.html` and `web.app` is not `classic`, alpd serves it instead of the D30 page: files from that directory only (encoded climbs stay inside), the `.br` or `.gz` copy the browser accepts, the page for any path without an extension, `/_expo/static/` cached as immutable and the rest `no-cache`. Its CSP allows only this origin, inline styles, `data:`/`blob:` images, fonts, media and workers, WebAssembly, and sockets to this port. `web.json` gains a `serverId` (`alp-` and 16 hex), made once like the token.
- **Protocol core** (`src/daemon/paseo/gateway.ts`): `/ws` on the page's origin (Host and Origin checked as in §61) carries Paseo's frames. The token comes in the `hello` as `auth: { kind: "password" }` or as the `paseo.bearer.<token>` subprotocol, which alpd echoes; a missing or wrong one gets `hello.rejected` (`password_required`, `incorrect_password`) and close 4401, a protocol below 1 `incompatible_protocol` and 4003. A good hello gets `status` / `server_info` with the server id, host name, version and the features ALP lights up; `ping` frames get `pong`, session `ping` requests get their `pong` with times; `client_heartbeat` and other one-way messages are dropped. Any request without a handler gets `rpc_error` with code `not_implemented` ("<type> is not in ALP yet"), so nothing waits out the app's 60 s timeout. `src/daemon/paseo/index.ts` holds the handlers and features, empty at this step.
- **Ported from Paseo** (Apache 2.0, attributed in each file): `src/daemon/paseo/timeline-projection.ts` and `timeline-store.ts`, Paseo's timeline rows, projection (assistant and reasoning merges, tool lifecycles) and paged fetch with epochs, for the agent timelines of step 3. `@getpaseo/protocol` 0.11.2 is a dev dependency for its types and its validator.

**Evidence.**
- `test/paseo-web.test.js`, every frame alpd sends checked with Paseo's own `validateWSOutboundMessage` (the validator the app runs):
  - the page for a route, `no-cache`, the CSP; the bundle in brotli with the immutable cache; a missing bundle 404; an encoded climb out of the directory 404;
  - a socket from another origin refused 403; a hello without the token `password_required` and close 4401; a wrong token `incorrect_password`; the right one `server_info` with the server id; WebSocket and session pings answered; a terminal request answered `not_implemented` at once;
  - the token as `paseo.bearer.*`, echoed by alpd, and a hello without auth then accepted.
- Live, on a temp `ALP_HOME` at port 7533: the build from a scratch checkout with both patches; the app loaded as "ALP" from alpd with no CSP errors, took the token from the address and dropped it, connected, and asked for its agents, which alpd answered as in development.

**Step 3: agents and timelines (2026-10-10).** alpd shows its sessions to the app as agents of one provider, `alp`, in Paseo's legacy mode (no owned subscriptions, no selective timelines): the app asks for agents, groups them by `cwd` into workspaces, and every `agent_update` and `agent_stream` goes to every client.

- **Connection** (`src/daemon/paseo/alp-client.ts`): the bridge talks to alpd in its own process through `daemon.accept`, the same JSON-RPC the CLI and the Paseo plugin use, and gets the same events.
- **Agents** (`src/daemon/paseo/agents.ts`): a root session (closed and archived included) is an agent: title, `cwd` = project root, model = its team (`workflow.mode`, or `runtime:model` for a custom team), modes from the runtime catalog, status `running` / `idle` / `initializing` / `error` (closed and persistent shows idle), `requiresAttention` after a finished or failed turn until cleared, `archivedAt`, and `persistence { provider: 'alp', sessionId }`. Its placement is a non-git checkout until step 8. The bridge polls `session.list` every 2 s and on session events and sends the difference as `agent_update` upserts and removals.
- **Timelines**: each live root gets a timeline store (ported, §62 step 1–2) filled from `session.attach { replay: true }` without broadcasting, then from item events, each an `agent_stream` with seq and epoch. `src/daemon/paseo/timeline-items.ts` turns ALP's item snapshots into Paseo's appends, as Paseo does for plugin providers: assistant text as deltas with the item id as `messageId`; a user message once, with the app's `clientMessageId` as its id so the app's own copy is replaced; notices as notifications; compaction as loading / completed (a failed one as a warning); todos with `completed`; tool calls as shell or unknown detail with `error: null` unless failed. Turn start and end become `turn_started`, `turn_completed`, `turn_canceled`, `turn_failed`, plus an `attention_required` stream event after a finished or failed turn. `fetch_agent_timeline_request` pages the store as Paseo's server does (tail of 200 by default, all after a cursor).
- **Requests**: `fetch_agents_request` (offset paging, archived left out), `fetch_agent_request`, `fetch_agent_timeline_request`, `get_providers_snapshot_request` (ALP's teams as the models, from `session.preview`), `create_agent_request` (a persistent `web-<uuid>` session with the chosen team and mode, titled, with the first prompt; answered `agent_created` or `agent_create_failed`), `send_agent_message_request` (opens a closed session again; a running turn is steered, or interrupted and restarted for `interrupt`), `cancel_agent_request`, `archive_agent_request`, `update_agent_request` (rename), `set_agent_mode_request`, `clear_agent_attention`.
- **Quiet answers** (`src/daemon/paseo/quiet.ts`): what the app reads by itself for features ALP has not got yet gets the empty answer of a daemon without that feature, not a refusal it would retry and log: project icons (none), checkout status (not git) and pull request status (unavailable), terminals (none, and their subscription), workspace setup (no snapshot), the daemon config (Paseo's defaults). What the user asks for by hand still answers "in development".
- **Debugging**: `ALP_PASEO_DEBUG=1` logs each inbound request, each non-session frame and each closed socket to the alpd log.
- **Load time**: in headless Chrome on this machine the app takes about 40–50 s to show its first screen; Paseo's own hosted app (`app.paseo.sh`) takes the same there, so this is the app, not alpd.

**Evidence.**
- `test/paseo-web.test.js`, every frame checked with Paseo's validator: the quiet answers; an agent created from the app with its first prompt, `turn_started`, the scripted reply streamed as an assistant append with seq and epoch, `turn_completed`; the agent listed with its project root; its timeline fetched with the user message (by the app's message id) and the reply; a second message accepted and run; an unknown agent's timeline an error; rename and archive, after which the list is empty.
- Live, on the temp `ALP_HOME` at port 7533, with a real Phở team: a fresh browser profile opened `/#token=…`, connected, listed the workspace, showed the earlier session's timeline (user message, shell `ls`, reply), sent "Reply with exactly one word: pong" from the composer, and showed the user message, the streamed "pong" and Claude's usage notice.

**Step 4: questions as cards (2026-10-10).** Whatever ALP asks the user (`alp_ask` to the user, a permission its profile or mode leaves to the user, trusting a project's hooks, approving an issue post) is one `UserQuestion` with a text and choices, answered by text (§17, §25). As the Paseo plugin does (§17), the bridge shows each as Paseo's question card on the root of its tree, so a team member's question shows on the agent the user talks to.

- **Asked**: a `question` event (from any session of an attached tree), or one `question.list` shows when the bridge reads the roots again, becomes `agent_permission_request` with a request of kind `question`: the id is the question's, the title and the header the asking agent's name, and one question with the text, the choices as options, and `allowOther` for any other answer. The root's agent lists it in `pendingPermissions`, gets attention `permission`, and its stream an `attention_required` event, so the app marks the tab and the sidebar.
- **Answered**: `agent_permission_response` from the card answers with `question.answer`: an `allow` takes the first non-empty value of `updatedInput.answers` (the chosen label or the text typed); an `allow` without one, or a `deny` (Dismiss), dismisses it with the card's message as the reason. ALP reads a permission's answer as before (allow once, always allow, deny).
- **Resolved**: `question.resolved` from alpd, wherever it was answered (the app, the CLI, Paseo, a timeout), becomes `agent_permission_resolved` with the app's own response, or a `deny` saying why it ended; a question `question.list` no longer shows is resolved the same way. A failed answer resolves the card with the error.

**Evidence.**
- `test/paseo-web.test.js`, frames checked with Paseo's validator: an agent's `alp_ask` with two choices arrives as a question card on its root with the options and `allowOther`, an `attention_required` for permission, and the agent's `pendingPermissions`; the card's answer by header reaches the agent as "Blue" and comes back as `agent_permission_resolved` with the same response, leaving nothing pending; a question without choices dismissed from the card reaches the agent as dismissed.
- Live, on the temp `ALP_HOME` with a real Phở team: asked from the composer to use `alp_ask`, main asked "Bạn thích màu nào hơn?" with Red and Blue; the app showed the card (Red, Blue, Other…, Dismiss, Submit) and marked the tab and the workspace; choosing Blue and Submit reached alpd, and main replied "You chose Blue.".

**Step 5: "in development" for what ALP has not got (2026-10-10).** Paseo's features that ALP lacks stay in the app; using one says so instead of failing or waiting.

- **The answer**: a request with no handler gets `rpc_error` code `not_implemented` whose text is `inDevelopment` in the user's language (§54: "Tính năng đang phát triển" by default, "This feature is in development" in English), read from the settings when it is sent. The app shows it as a toast (patch 6).
- **Entry points**: the app hides a feature's button until `server_info` lists the feature, so the bridge lists the entry points that only send a request on a click and the app handles a refusal of: adding, cloning, creating and removing projects, searching GitHub repositories, pinning a workspace and marking it unread, detaching and forking an agent's context, removing a provider, importing sessions, file operations and running workspace setup. Flags that change what the app reads by itself (owned subscriptions, selective timelines, project lists, labels, workspace multiplicity, plugins, usage, diagnostics and the rest) stay off, since a refusal there would break or retry without a click.
- **Voice**: dictation and voice mode send no request id and would wait out the client's timeout, so `server_info` says in `capabilities.voice` that both are off, with the same text as the reason, and the app shows them disabled.
- **More quiet answers**: a draft agent's provider features (none) and the path suggestions the app prefetches when the pointer rests on a file link (none).
- **History**: `fetch_agent_history_request` lists the agents, archived ones included unless asked not to, filtered by project, status and attention and searched by title and project, sorted by status, creation, title or last update, and paged by offset.
- **Find in chat**: `agent.timeline.search.request` searches the agent's timeline rows, ported from Paseo's `chat-search` (`src/daemon/paseo/chat-search.ts`, Apache 2.0, attributed): the query's words in order with any spaces between, case-insensitive, user and assistant messages only, 200 matches a page, each a row and its match count, with the epoch.

**Evidence.**
- `test/paseo-web.test.js`, frames checked with Paseo's validator: a terminal request answered "Tính năng đang phát triển" by default and "This feature is in development" after `language: English`; `projectAdd` listed and voice off with that reason; the provider features and path suggestions quiet; find in chat with `readme.MD` finding the assistant row that says README.md, a word in both rows finding both, a missing agent an error; history keeping archived agents, searching, sorting by title, leaving archived ones out on request and paging.
- Live, on the temp `ALP_HOME` at port 7533 with a real Phở team: History listed the sessions; find in chat for "pong" showed "1 of 2" and highlighted the match; before chat search had a handler it showed the toast "Tính năng đang phát triển"; the tab bar's + menu, Terminal, showed "Tính năng đang phát triển" at once.

**Step 6: projects and workspaces (2026-10-10).** The app leaves its legacy mode, where it made one workspace per agent directory, for Paseo's own: alpd lists projects and workspaces, and the user's title, pin, labels and archive stay in alpd.

- **The registry** (`src/daemon/paseo/workspaces.ts`): a project is a directory the user opened (`prj_` and 16 hex), a workspace a place in it where agents run (`wks_` and 16 hex), with its title, pin, labels and archive time; the label catalog has a generation and a sequence number per change, as Paseo's daemon keeps it. It is kept in `<ALP home>/state/web-workspaces.json`, written atomically. ALP's sessions know only their directory, so the registry also keeps which workspace each root belongs to: a root it has not seen goes to the oldest open workspace of its directory, or a new one (an archived root to an archived one); a root someone works in again brings its archived workspace back.
- **Descriptors**: a workspace's name is its title, else the checkout's branch, else the folder's name; its status is the most urgent of its roots' (Paseo's `deriveAgentStateBucket`: needs input, failed, running, attention, done); its activity the latest update of its roots. Agents carry their `workspaceId`, and their placement the project's id as its key. `src/daemon/paseo/git.ts` reads each directory's checkout (root, branch, remote, dirty) every 10 s without optional locks; a changed branch renames the workspace.
- **Updates**: whatever changes a workspace or project (an agent's status, a title, a branch) goes to every client as `workspace_update` or `project.update`, only when the descriptor changed; an archived workspace leaves with a `remove`, carrying its project when that has no workspace left.
- **Requests**: `fetch_workspaces_request` (filter, sort, offset paging, the projects without workspaces), `project.list`, `project.add` (a missing directory is `directory_not_found`), `project.create_directory` (one plain folder name, not an existing one), `project.rename`, `project.remove` (archives its workspaces), `open_project_request`, `workspace.create` from a directory, with its first agent when the app sends one (a worktree answers "in development"), `workspace.title.set`, `workspace.pin.set`, `archive_workspace_request` (archives its roots, which stops them), `workspace.mark_unread` (the newest finished root wants a look again), `workspace.clear_attention`, and the labels: list (a snapshot), assignment (a new name joins the catalog), update (rename, colour; a taken name is `label_name_taken`), delete and its inspection.
- **Finding folders and files** (`src/daemon/paseo/files.ts`): `directory_suggestions_request` without a `cwd` completes a typed path (`/` or `~`) from its parent's folders, or finds a name in folders under home (four levels, at most 5000 folders, skipping hidden ones, `node_modules` and `~/Library`), best and nearest first; with a `cwd` it searches the workspace's files and folders (git's list when it is a repository, so ignored files stay out), by name, or by path suffix for file links.
- **Features**: `workspaceMultiplicity`, `projectList`, `projectAdd`, `stableProjectIdentity`, `projectRemove`, `projectCreateDirectory`, `workspacePinning`, `workspaceMarkUnread`, `workspaceLabels`. Owned subscriptions stay off: the app takes the pushes by type. Recovering an archived workspace (`workspaceRecovery`) is not offered yet.

**Evidence.**
- `test/paseo-web.test.js`, frames checked with Paseo's validator: a typed path completed, a workspace file found by name and by suffix; a missing project directory refused; a project added once (the same id again), listed, and shown without workspaces; a workspace made with its first agent, whose `workspaceId` and project key match; a worktree "in development"; title, pin, a label assigned, renamed with its `previousName` and seq 2, inspected and deleted; read and unread again; the registry on disk; archiving that removes the workspace with its project kept and archives the agent; a folder made and its project removed.
- Live, on the temp `ALP_HOME` at port 7533: the sidebar showed the project and its workspace from alpd; Pin moved it under Pinned; Rename made it "Tài liệu"; Add a project, Search for directory, found the typed folder and added it; New workspace there with Phở and "Reply with exactly one word: ok" made the workspace and the agent, which answered "ok".

**Step 7: ALP's own panels and the team as subagents (2026-10-10).** ALP's Paseo plugin (plugins/paseo, §22, §43) runs in the web app, from alpd, and the members of a root's team show as Paseo's provider subagents.

- **The plugin's client** (`scripts/build-paseo.mjs`): `plugins/paseo/index.client.tsx` is compiled as Paseo's daemon compiles a plugin's client bundle (CommonJS, `jsx: automatic`, ES2020 without async/await, the SDK, React, React Native, React Query and zod left to the app, re-exports made eager), wrapped as a function of `require`, and embedded in alpd as `alp:plugin-client` with the manifest's id and requirements. alpd serves it as `/alp-plugins.js` (no-cache, the app's CSP), which patch 8 runs.
- **The plugin's server** (`src/daemon/paseo/plugins.ts`): `plugin.catalog.get` lists `alp-provider` with the `alp-preloaded:` bundle and its requirements; `plugin.list` shows it running, so Settings → the host → Plugins reaches its settings screen; `plugin.rpc.invoke` runs the plugin's own handlers (`registerTaskRpc`, `registerLibraryRpc`) in alpd, the input and output checked with their contracts as Paseo's daemon checks them, a failure `handler_error` and an unknown method `method_not_found`. The Tasks panel and screen, the ALP project panel, the composer's Tasks pill, the command-center items, `/alp-tasks` and the ALP settings screen work as in Paseo's desktop app; the sessions a task was worked in are not listed (the provider fills them there). Features: `plugins`, `pluginSettings`, `pluginManagement`; the daemon config says plugins are on.
- **Subagents** (`src/daemon/paseo/agents.ts`): a session opened with a parent in a tree the bridge follows is a subagent of the root: its agent name as the title, its first message (the brief) as the description, `runtime:model` as the subtitle, its requester as `parentSubagentId` when that is not the root, its status running, then completed, failed or canceled with its turns and its end. Its items go into a timeline of its own (not the root's), each pushed as `agent.provider_subagents.update` `timeline`, and its changes as `upsert`; a root's history replay fills them without pushing. `agent.provider_subagents.list` and `agent.provider_subagents.timeline.get` (paged as a root's timeline) answer from them. Features: `providerSubagents`, `projectedSubagentTimeline`, `providerSubagentNesting`.
- **Not yet**: a Team panel of the tree's assignments and worktrees waiting for a merge; the team is seen through its subagents for now. Opening the plugin's settings screen by its address on a fresh load shows it unavailable until the catalog arrives; from the Plugins page it opens.

**Evidence.**
- `test/paseo-web.test.js`: `/alp-plugins.js` served as JavaScript under a CSP without `'unsafe-eval'`, registering a factory that, given the app's module names, returns the plugin's setup; the features; the catalog entry and the plugin list; tasks listed, added, listed and closed, the library's teams listed through `plugin.rpc.invoke`; a bad input `handler_error`, an unknown method `method_not_found`. A root delegating to `lead`: the subagent upserted running with the root as parent, its reply as its own timeline push and not on the root's stream, completed; listed with its brief; its timeline fetched; a missing one an error.
- Live, on the temp `ALP_HOME` at port 7533, the app rebuilt with 8 patches: the tab bar's + menu listed Tasks and ALP project; Tasks opened the plugin's Tasks panel (list, board, epics); the composer showed the Tasks pill and "3 subagents", whose list showed the supervisor's turns; Settings → ALP → Plugins listed `alp-provider` running, and its menu opened the ALP settings screen (language, teams pho and cafe, agents, skills, MCP, hooks, providers).

**Step 8: a checkout's changes and files, read-only (2026-10-11).** The workspace header shows the branch, the Changes panel the checkout's diff, and the Files panel its files, from alpd; changing anything stays "in development".

- **Status** (`src/daemon/paseo/checkout.ts`): `checkout_status_request` answers Paseo's "git, not Paseo's worktree" shape: the repository's root, branch (none when detached), whether anything changed, the base branch (origin's HEAD, else `main` or `master`), how far the branch is ahead of and behind it (against origin's copy when there is one), and its upstream with how far it is ahead of and behind that. A directory outside git answers "not git". When a watched checkout's status changes, every client gets `checkout_status_update`.
- **Diff**: `subscribe_checkout_diff_request` answers at once with the diff, uncommitted (`HEAD`, or the empty tree before the first commit, against the working tree, renames found, untracked files added one by one) or against the base branch (its merge base with `HEAD`), whitespace ignored when asked; paths from the repository's root. Paseo's unified-diff parser is ported (Apache 2.0, attributed), without syntax highlighting, and keeps a rename's old path and marks binary files; a file's patch over 1 MB, or everything past 2 MB, is "too large", and at most 200 untracked files are read. alpd reads each subscribed checkout again every 3 s and on `checkout.refresh.request` (the panel's refresh button, feature `checkoutRefresh`), and pushes `checkout_diff_update` only when the diff changed; `unsubscribe_checkout_diff_request` and a closed socket end the subscription. Pull request status says `no_remote`, so the panel does not ask the user to sign in to GitHub.
- **Files** (`src/daemon/paseo/files.ts`): `file_explorer_request` lists a directory (dotfiles too; links followed only when they stay inside the workspace; size and time) and reads a file: an image (PNG, JPEG, GIF, WebP, SVG) as base64, text as UTF-8 (JSON as `application/json`), anything else as binary without its content; more than the app's limit (50 MB at most) is "File is too large to display", and a path that leads outside the workspace is refused.
- **Read-only**: commit, push, pull, merge, pull requests, switching branches, discarding, and editing, creating, renaming or deleting files answer "in development" (§62 step 5); `workspaceFileEditing` stays off, so the file view has no editor.
- **Previews only read**: `session.preview`, which the app's team list and new-agent screen ask for, no longer runs `alp init` in the folder (`resolveSession` with `initialize: false`). Before, looking at a folder in the app wrote `ALP.md` and `.alp/settings.json` into it, and a team list asked for without a folder did so in the user's home (§62 step 3's bridge asked with the home folder).

**Evidence.**
- `test/paseo-web.test.js`, frames checked with Paseo's validator, on a temp repository: the team list of the folder writes nothing into it; status on `main` dirty with `main` as its base, and "not git" elsewhere; the uncommitted diff with the modified file's hunk line by line, the untracked text file new, the untracked binary binary; a rename pushed after a refresh with its old path; on a branch one commit ahead of `main`, the base diff; the Files panel's root and a folder listed, a link out of the workspace left out, text, an image and a binary read, a file over the limit and a path outside refused; a commit "in development".
- Live, on the temp `ALP_HOME` at port 7533 with a small repository opened as a project: the workspace named `main` after its branch; the Changes panel listed `src/greet.js` (+2 −1) and `NOTES.md` (+1), and the diff showed the Vietnamese lines; the Files panel listed `.git`, `src`, `NOTES.md`, `README.md`, and README's preview rendered; Commit showed "Tính năng đang phát triển"; the repository had no `ALP.md` or `.alp` afterwards.
