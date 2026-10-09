import type { RuntimeKind } from './resolve.js';
import type { MailEvent } from './mailbox.js';
import type { Pin } from './board.js';

/** Provider-neutral session events (plans/reference/ALPD.md §4). Viewers project them; the runtime never imports a viewer. */

export type AlpError = { message: string };

export type TimelineItem =
  | { kind: 'user_message'; id: string; text: string; clientMessageId?: string }
  | { kind: 'assistant_message'; id: string; text: string }
  | {
      kind: 'tool_call';
      id: string;
      callId: string;
      name: string;
      status: 'running' | 'completed' | 'failed';
      error?: string;
      detail:
        | { type: 'shell'; command: string; cwd?: string; output: string; exitCode?: number | null }
        | { type: 'unknown'; input: unknown; output: unknown };
    };

export type SessionSnapshot = {
  id: string;
  projectRoot: string;
  agent: string;
  runtime: RuntimeKind;
  model: string;
  mode: string;
  thinking: string;
  workflow: { mode: string; maxPeers: number };
  threadId: string;
  /** The native thread is kept and the session can be resumed. */
  persistent: boolean;
  parentId?: string;
  /** The requester's tool call that started this assignment. */
  toolCallId?: string;
  activeTurnId?: string;
  /** A turn, an assignment, a child, or undelivered mail keeps the session working. */
  busy: boolean;
};

export type AssignmentSnapshot = {
  id: string;
  agent: string;
  mode: string;
  status: string;
  startedAt: string;
  /** An isolated assignment's branch and working directory. */
  worktree?: { branch: string; path: string };
};

export type TurnOrigin = 'user' | 'wake' | 'assignment';

/** A question an agent asked the user with alp_ask to: "user". */
export type UserQuestion = {
  id: string;
  sessionId: string;
  rootId: string;
  agent: string;
  body: string;
  options?: string[];
  askedAt: string;
};

export type SessionState = 'running' | 'waiting' | 'waiting_parent' | 'waiting_user' | 'idle';

/** A live tree at one moment, for dashboards (plans/reference/ALPD.md §17). */
export type TreeStatus = {
  rootId: string;
  sessions: Array<SessionSnapshot & { state: SessionState; idleMs: number; workdir: string; unreadMail: number }>;
  assignments: Array<AssignmentSnapshot & { requester: string; isolation: 'shared' | 'worktree'; idleMs: number }>;
  questions: UserQuestion[];
  /** Finished worktree assignments waiting for alp_merge or alp_discard. */
  worktrees: Array<{ assignmentId: string; requester: string; agent: string; branch: string; files: string[]; stat: string }>;
  leases: Array<{ checkout: string; assignmentId: string; agent: string }>;
  /** Live claims on the project board held by this tree's sessions. */
  claims: Pin[];
};

export type AlpEvent =
  | { type: 'session.opened'; session: SessionSnapshot; cwd: string; effective: { model: string; thinking: string } }
  | { type: 'session.ready' }
  | { type: 'session.updated'; session: SessionSnapshot }
  | { type: 'session.closed' }
  | { type: 'session.failed'; error: AlpError }
  | { type: 'prompt.accepted'; clientMessageId: string; result: 'turn' | 'steer'; turnId: string }
  | { type: 'prompt.failed'; clientMessageId: string; error: AlpError }
  | { type: 'turn.started'; turnId: string; origin: TurnOrigin }
  | { type: 'turn.ended'; turnId: string; state: 'completed' | 'failed' | 'canceled'; error?: AlpError }
  | { type: 'item'; item: TimelineItem }
  | { type: 'mail'; mail: Omit<MailEvent, 'passive' | 'deliveredTurn'> }
  | { type: 'assignment'; assignment: AssignmentSnapshot }
  | { type: 'question'; question: UserQuestion }
  | { type: 'question.resolved'; questionId: string; outcome: 'answered' | 'dismissed' | 'timeout' | 'canceled'; answer?: string }
  /** Emitted on the session that pinned it (plans/reference/ALPD.md §18). */
  | { type: 'pin'; pin: Pin }
  | { type: 'unpin'; pinId: string; reason: 'unpinned' | 'session_ended' };

export type Envelope = {
  sessionId: string;
  /** Random per runtime instance; a cursor from another epoch is stale. */
  epoch: string;
  /** Strictly increasing per session. */
  seq: number;
  ts: string;
  event: AlpEvent;
};
