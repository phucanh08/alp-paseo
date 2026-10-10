// The shapes alpd sends (src/runtime/events.ts, src/daemon/server.ts), as the page uses them.

export type ToolDetail =
  | { type: 'shell'; command: string; cwd?: string; output: string; exitCode?: number | null }
  | { type: 'unknown'; input: unknown; output: unknown };

export type TimelineItem =
  | { kind: 'user_message'; id: string; text: string; clientMessageId?: string }
  | { kind: 'assistant_message'; id: string; text: string }
  | { kind: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string }
  | { kind: 'compaction'; id: string; status: 'running' | 'completed' | 'failed'; trigger?: string; preTokens?: number; postTokens?: number }
  | { kind: 'todo'; id: string; items: Array<{ id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }> }
  | { kind: 'tool_call'; id: string; callId: string; name: string; status: 'running' | 'completed' | 'failed'; error?: string; detail: ToolDetail };

export type SessionSnapshot = {
  id: string;
  projectRoot: string;
  agent: string;
  runtime: string;
  model: string;
  mode: string;
  thinking: string;
  workflow: { mode: string; maxPeers: number; supervisor: boolean };
  teamLabel?: string;
  parentId?: string;
  toolCallId?: string;
  activeTurnId?: string;
  busy: boolean;
  parked?: string;
  persistent?: boolean;
};

export type SessionSummary = SessionSnapshot & {
  status: 'initializing' | 'idle' | 'running' | 'closed' | 'error';
  title?: string;
  updatedAt?: string;
  lastError?: { message: string };
  archived?: boolean;
};

export type UserQuestion = { id: string; sessionId: string; rootId: string; agent: string; body: string; options?: string[]; askedAt: string };

export type AlpEvent =
  | { type: 'session.opened'; session: SessionSnapshot; cwd: string }
  | { type: 'session.ready' }
  | { type: 'session.updated'; session: SessionSnapshot }
  | { type: 'session.closed' }
  | { type: 'session.failed'; error: { message: string } }
  | { type: 'prompt.accepted'; clientMessageId: string; result: 'turn' | 'steer'; turnId: string }
  | { type: 'prompt.failed'; clientMessageId: string; error: { message: string } }
  | { type: 'turn.started'; turnId: string; origin: string }
  | { type: 'turn.ended'; turnId: string; state: 'completed' | 'failed' | 'canceled'; error?: { message: string } }
  | { type: 'item'; item: TimelineItem }
  | { type: 'question'; question: UserQuestion }
  | { type: 'question.resolved'; questionId: string }
  | { type: 'mail' | 'assignment' | 'pin' | 'unpin' };

export type Envelope = { sessionId: string; epoch: string; seq: number; ts: string; event: AlpEvent };

export type SessionPreview = {
  teams: Array<{ id: string; label: string; description?: string }>;
  team: string;
  teamLabel?: string;
  agent: string;
  runtime: string;
  model: string;
  mode: string;
  thinking: string;
};

export type TreeStatus = {
  rootId: string;
  sessions: Array<SessionSnapshot & { state: string; idleMs: number; workdir: string; unreadMail: number }>;
  assignments: Array<{ id: string; agent: string; mode: string; status: string; startedAt: string; requester: string; isolation: string; worktree?: { branch: string } }>;
  worktrees: Array<{ assignmentId: string; agent: string; branch: string; files: string[]; stat: string }>;
};

export type TaskRow = {
  id: string; title: string; type: string; priority: number; status: 'open' | 'in_progress' | 'review' | 'closed';
  parent?: string; assignee?: string; ready: boolean; blockedBy?: string[]; waits?: string[];
  approvals?: Array<{ gate: string; note: string }>;
  handoff?: { outcome: string; summary: string; agent?: string };
  closed?: { reason: string; summary?: string; at: string };
  description?: string; progress?: { done: number; total: number }; updatedAt: string;
};

export type PauseState = {
  all?: { reason: string };
  runtimes: Record<string, { reason: string; resetsAt?: string }>;
  parked: Array<{ assignmentId: string; agent: string }>;
};
