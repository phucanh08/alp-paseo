import { useCallback, useEffect, useState } from 'react';
import { go, useAlpd } from './context';
import type { TaskRow, TreeStatus } from './types';
import { Icon } from './ui';

/** The side panel of a session: its team at work, the project's tasks, and the checkout's changes. */

type Tab = 'team' | 'tasks' | 'changes';

function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const run = () => load().then(result => { if (live) { setData(result); setError(''); } }).catch(cause => { if (live) setError(cause.message); });
    void run();
    const timer = ms ? setInterval(run, ms) : undefined;
    return () => { live = false; if (timer) clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, refresh: useCallback(() => setTick(value => value + 1), []) };
}

const STATE_LABEL: Record<string, string> = { running: 'working', waiting: 'waiting for its team', waiting_parent: 'waiting for its requester', waiting_user: 'waiting for you', idle: 'idle' };

function Team({ rootId, live }: { rootId: string; live: boolean }) {
  const alpd = useAlpd();
  const { data, error } = usePoll(() => live ? alpd.request<{ status: TreeStatus }>('session.status', { sessionId: rootId }).then(result => result.status) : Promise.resolve(null), 2000, [rootId, live]);
  if (!live) return <p className="muted pad">The session is closed; its team is not working. A message resumes it.</p>;
  if (error && !data) return <p className="muted pad">{error}</p>;
  if (!data) return <p className="muted pad">Loading…</p>;
  return (
    <div className="pad">
      <h4>Agents</h4>
      {data.sessions.map(session => (
        <button key={session.id} className="agent-row" onClick={() => go({ screen: 'session', id: session.id })}>
          <span className={`dot ${session.state === 'running' ? 'running' : session.state === 'waiting_user' ? 'warning' : 'idle'}`} />
          <span className="agent-name">{session.agent}</span>
          <span className="muted small">{STATE_LABEL[session.state] ?? session.state}{session.unreadMail ? ` · ${session.unreadMail} mail` : ''}</span>
          <span className="muted small model">{session.runtime}:{session.model}</span>
        </button>
      ))}
      {data.assignments.length > 0 && <>
        <h4>Assignments</h4>
        {data.assignments.map(assignment => (
          <div key={assignment.id} className="assignment-row">
            <span className="agent-name">{assignment.agent}</span>
            <span className="muted small">from {assignment.requester} · {assignment.status} · {assignment.mode}{assignment.worktree ? ` · ${assignment.worktree.branch}` : ''}</span>
          </div>
        ))}
      </>}
      {data.worktrees.length > 0 && <>
        <h4>Waiting to merge</h4>
        {data.worktrees.map(worktree => <div key={worktree.assignmentId} className="assignment-row"><span className="agent-name">{worktree.agent}</span><span className="muted small">{worktree.branch} · {worktree.stat}</span></div>)}
      </>}
    </div>
  );
}

const SECTIONS: Array<{ key: string; title: string; test(task: TaskRow): boolean }> = [
  { key: 'approve', title: 'Waiting for your approval', test: task => task.status !== 'closed' && !!task.approvals?.length },
  { key: 'review', title: 'In review', test: task => task.status === 'review' },
  { key: 'progress', title: 'In progress', test: task => task.status === 'in_progress' },
  { key: 'ready', title: 'Ready', test: task => task.status === 'open' && task.ready },
  { key: 'waiting', title: 'Blocked or waiting', test: task => task.status === 'open' && !task.ready && !task.approvals?.length },
  { key: 'closed', title: 'Closed', test: task => task.status === 'closed' },
];

function Tasks({ projectRoot }: { projectRoot: string }) {
  const alpd = useAlpd();
  const { data, error, refresh } = usePoll(() => alpd.request<{ tasks: TaskRow[] }>('tasks.list', { projectRoot }), 5000, [projectRoot]);
  const [title, setTitle] = useState('');
  const [open, setOpen] = useState<string>();
  const [problem, setProblem] = useState('');
  const act = (params: object) => alpd.request('tasks.change', { projectRoot, ...params }).then(refresh, cause => setProblem(cause.message));
  const add = () => alpd.request('tasks.add', { projectRoot, title: title.trim() }).then(() => { setTitle(''); refresh(); }, cause => setProblem(cause.message));
  if (error && !data) return <p className="muted pad">{error}</p>;
  const tasks = data?.tasks ?? [];
  const used = new Set<string>();
  return (
    <div className="pad">
      <div className="add-task">
        <input value={title} placeholder="New task" onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && title.trim()) void add(); }} />
        <button disabled={!title.trim()} onClick={() => void add()}><Icon name="plus" /></button>
      </div>
      {problem && <p className="error-text">{problem}</p>}
      {data && !tasks.length && <p className="muted">No tasks yet. Main records the work it plans here.</p>}
      {SECTIONS.map(section => {
        const rows = tasks.filter(task => !used.has(task.id) && section.test(task)).sort((a, b) => section.key === 'closed' ? (b.closed?.at ?? b.updatedAt).localeCompare(a.closed?.at ?? a.updatedAt) : a.priority - b.priority || a.id.localeCompare(b.id)).slice(0, section.key === 'closed' ? 15 : 100);
        rows.forEach(task => used.add(task.id));
        if (!rows.length) return null;
        return (
          <section key={section.key}>
            <h4>{section.title} <span className="muted">{rows.length}</span></h4>
            {rows.map(task => (
              <div key={task.id} className={`task ${task.status}`}>
                <button className="task-head" onClick={() => setOpen(value => value === task.id ? undefined : task.id)}>
                  <span className={`priority p${task.priority}`}>P{task.priority}</span>
                  <span className="task-title">{task.title}</span>
                  {task.progress && <span className="muted small">{task.progress.done}/{task.progress.total}</span>}
                  {task.assignee && <span className="muted small">{task.assignee}</span>}
                </button>
                {open === task.id && <div className="task-body">
                  <div className="muted small">{task.id} · {task.type}{task.waits?.length ? ` · waits on ${task.waits.join(', ')}` : ''}{task.blockedBy?.length ? ` · blocked by ${task.blockedBy.join(', ')}` : ''}</div>
                  {task.description && <p className="pre">{task.description}</p>}
                  {task.handoff && <p className="small"><strong>{task.handoff.agent ?? 'Handoff'}:</strong> {task.handoff.outcome} — {task.handoff.summary}</p>}
                  {task.closed && <p className="small muted">Closed ({task.closed.reason}){task.closed.summary ? `: ${task.closed.summary}` : ''}</p>}
                  <div className="task-actions">
                    {task.approvals?.map(approval => <button key={approval.gate} className="primary" onClick={() => void act({ id: task.id, action: 'approve', gate: approval.gate })}>Approve{approval.note ? `: ${approval.note}` : ''}</button>)}
                    {task.status !== 'closed' ? <button onClick={() => void act({ id: task.id, action: 'close' })}>Close</button> : <button onClick={() => void act({ id: task.id, action: 'reopen' })}>Reopen</button>}
                  </div>
                </div>}
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

type Changes = { git: boolean; branch?: string; files: Array<{ status: string; path: string }>; diff: string; truncated?: boolean };

/** A diff split by file, each with its lines colored. */
function DiffView({ diff }: { diff: string }) {
  const files = diff.split(/^(?=diff --git )/m).filter(part => part.trim());
  return <>{files.map((file, index) => {
    const name = /^diff --git a\/(.+?) b\//.exec(file)?.[1] ?? `file ${index + 1}`;
    return (
      <details key={index} className="diff-file" open={files.length <= 8}>
        <summary>{name}</summary>
        <pre className="diff">{file.split('\n').filter(line => !/^(diff --git|index |--- |\+\+\+ )/.test(line)).map((line, at) => <span key={at} className={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>{line}{'\n'}</span>)}</pre>
      </details>
    );
  })}</>;
}

function ChangesTab({ projectRoot }: { projectRoot: string }) {
  const alpd = useAlpd();
  const { data, error, refresh } = usePoll(() => alpd.request<Changes>('project.changes', { projectRoot }), 0, [projectRoot]);
  if (error && !data) return <p className="muted pad">{error}</p>;
  if (!data) return <p className="muted pad">Loading…</p>;
  if (!data.git) return <p className="muted pad">This project is not a git checkout.</p>;
  return (
    <div className="pad">
      <div className="changes-head"><span className="muted small">{data.branch || 'detached'} · {data.files.length} changed</span><button className="icon-button" title="Refresh" onClick={refresh}><Icon name="refresh" /></button></div>
      {data.files.map(file => <div key={file.path} className="file-row"><span className={`file-status s${file.status.replace(/\?/g, 'u')}`}>{file.status}</span><span className="file-path">{file.path}</span></div>)}
      {data.diff ? <DiffView diff={data.diff} /> : data.files.length ? <p className="muted small">Only new files; they show in the diff once added to git.</p> : <p className="muted">No changes.</p>}
      {data.truncated && <p className="muted small">The diff is longer than shown.</p>}
    </div>
  );
}

export function SidePanel({ rootId, projectRoot, live }: { rootId: string; projectRoot: string; live: boolean }) {
  const [tab, setTab] = useState<Tab>(() => { try { return (localStorage.getItem('alp.tab') as Tab) || 'team'; } catch { return 'team'; } });
  const choose = (next: Tab) => { setTab(next); try { localStorage.setItem('alp.tab', next); } catch {} };
  return (
    <aside className="side-panel">
      <nav className="tabs">
        {(['team', 'tasks', 'changes'] as Tab[]).map(name => <button key={name} className={tab === name ? 'active' : ''} onClick={() => choose(name)}>{name === 'team' ? 'Team' : name === 'tasks' ? 'Tasks' : 'Changes'}</button>)}
      </nav>
      <div className="panel-body">
        {tab === 'team' && <Team rootId={rootId} live={live} />}
        {tab === 'tasks' && <Tasks projectRoot={projectRoot} />}
        {tab === 'changes' && <ChangesTab projectRoot={projectRoot} />}
      </div>
    </aside>
  );
}
