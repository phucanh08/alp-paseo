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

`src/runtime`, `src/daemon`, `src/client` are TypeScript, built with the existing esbuild script. An import-graph test (as `adapter.test.js:29` does for core) enforces that `src/runtime` and `src/daemon` never import `@getpaseo/*`. Packaging: the `alp-cli` npm package ships the CLI and daemon; `alp-paseo-plugin` expects it installed (Q5, §15).

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
- **Q5 — Packaging:** the `alp` package ships the CLI and daemon; `alp-paseo-plugin` depends on it and auto-starts the daemon. *(As built: the package is `alp-cli`, and the plugin finds an installed CLI rather than depending on it; §15.)*
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

**Packaging (Q5).** Paseo re-bundles plugin code and does not tell the plugin where it is installed, so the plugin cannot find the `alpd.js` it ships. alpd records its own path in `$ALP_HOME/alpd.json` whenever it starts. A client that must start alpd tries, in order: its own candidates (`ALP_DAEMON_ENTRY`, then the build-time path), the recorded path, then the ALP CLI: an `alp` executable on `PATH` or in common global bin directories whose real path is `<package>/src/cli.js` in a package named `alp-cli`, using `<package>/dist/alpd.js`. If alpd is already running, no path is needed. Verified with a packed plugin whose build-time path does not exist: Paseo reports a clear error until alpd has run once, then starts alpd by itself and the Paseo e2e passes. The CLI package is `alp-cli` (the npm name `alp` belongs to another author), with the `alp` command; a packed `alp-cli` installed into a fresh prefix starts alpd and is found on PATH. Both READMEs ask users to install it and run `alp daemon start` once.

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

**Next: a group channel per project (user direction, 2026-10-09; noted, not designed).** Instead of direct mail between sibling agents, each project or workspace gets one group. Agents pin their findings to its chat channel, where the others (and the user) can read them. Later there will also be a channel for pinning tasks, and tools to show these channels to the user.

**Evidence.** `test/human.test.js` covers the runtime, alpd and the Paseo bridge, including the refusal and the notes to the requester. `scripts/human-e2e.mjs` has three modes. In `cli` and `paseo`, main asks the user for a code word, answered with `alp answer` by prefix or with Paseo's question prompt. In `relay`, the user writes the word to a running peer with `alp send`, main is told, and the peer returns it. All pass on Codex and Claude.

