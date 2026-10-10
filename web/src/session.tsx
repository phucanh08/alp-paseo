import { memo, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { follow, go, useAlpd } from './context';
import { Markdown } from './markdown';
import { childOf, useQuestions, useSession, type SessionView } from './store';
import type { SessionSummary, TimelineItem, UserQuestion } from './types';
import { SidePanel } from './panels';
import { Icon, MODES, projectName, statusOf, tokens } from './ui';

/** One session: its timeline, the questions its tree asks the user, and the composer. */

type ToolItem = Extract<TimelineItem, { kind: 'tool_call' }>;

function toolIcon(item: ToolItem) {
  const word = item.detail.type === 'shell' ? item.detail.command.trim().split(/[\s{(]/)[0] : item.name;
  if (item.name === 'alp_delegate') return 'users';
  if (/^(Read|LS|NotebookRead)$/.test(word)) return 'file';
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(word)) return 'edit';
  if (/^(Grep|Glob)$/.test(word)) return 'search';
  if (/^(WebFetch|WebSearch)$/.test(word)) return 'globe';
  if (item.name.startsWith('alp_')) return 'mail';
  return item.detail.type === 'shell' ? 'terminal' : 'tool';
}

function toolTitle(item: ToolItem) {
  if (item.detail.type === 'shell') return item.detail.command.split('\n')[0];
  const input = (item.detail.input ?? {}) as Record<string, unknown>;
  if (item.name === 'alp_delegate') return `${input.agent ?? 'agent'}: ${String(input.task ?? '').split('\n')[0]}`;
  const summary = Object.entries(input).filter(([, value]) => typeof value === 'string').map(([key, value]) => `${key}: ${String(value).split('\n')[0]}`).join(' · ');
  return `${item.name}${summary ? ` — ${summary}` : ''}`;
}

function toolOutput(item: ToolItem) {
  if (item.detail.type === 'shell') return item.detail.output;
  const output = item.detail.output as any;
  const text = Array.isArray(output) ? output.map(part => typeof part?.text === 'string' ? part.text : JSON.stringify(part)).join('\n') : output == null ? '' : typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  const input = item.detail.input && Object.keys(item.detail.input as object).length ? JSON.stringify(item.detail.input, null, 2) : '';
  return [input && `input:\n${input}`, text && `output:\n${text}`].filter(Boolean).join('\n\n');
}

/** Pretty JSON when the output is JSON, as ALP tools answer. */
const readable = (text: string) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };

const ToolRow = memo(function ToolRow({ item, sessionId }: { item: ToolItem; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const child = item.name === 'alp_delegate' ? childOf(sessionId, item.callId) : undefined;
  const output = open ? toolOutput(item) : '';
  return (
    <div className={`tool ${item.status}`}>
      <button className="tool-head" onClick={() => setOpen(value => !value)}>
        <Icon name={toolIcon(item)} />
        <span className="tool-title">{toolTitle(item)}</span>
        {item.detail.type === 'shell' && item.detail.exitCode != null && item.detail.exitCode !== 0 && <span className="badge error">exit {item.detail.exitCode}</span>}
        <span className={`state ${item.status}`}>{item.status === 'running' ? <span className="spinner" /> : item.status === 'failed' ? <Icon name="x" /> : <Icon name="check" />}</span>
      </button>
      {child && <button className="link small child-link" onClick={() => go({ screen: 'session', id: child.id })}>Open {child.snapshot?.agent ?? 'assignment'}'s session →</button>}
      {open && <pre className="tool-output">{readable(output) || (item.status === 'running' ? 'Running…' : 'No output')}{item.error ? `\n${item.error}` : ''}</pre>}
    </div>
  );
});

function Note({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const first = text.split('\n').find(line => line.trim()) ?? '';
  return (
    <div className="note">
      <button className="tool-head" onClick={() => setOpen(value => !value)}><Icon name="mail" /><span className="tool-title muted">{first}</span><Icon name={open ? 'chevron-up' : 'chevron-down'} /></button>
      {open && <div className="note-body"><Markdown text={text} /></div>}
    </div>
  );
}

const Item = memo(function Item({ item, sessionId }: { item: TimelineItem; sessionId: string }) {
  switch (item.kind) {
    case 'user_message':
      // Mail and ALP's own prompts are not the user's words.
      if (item.clientMessageId?.startsWith('alp-') || item.id.startsWith('user:alp-')) return <Note text={item.text} />;
      return <div className="user-message"><div className="bubble">{item.text}</div></div>;
    case 'assistant_message': return <div className="assistant-message"><Markdown text={item.text} /></div>;
    case 'notice': return <div className={`notice ${item.level}`}><Icon name={item.level === 'info' ? 'check' : 'alert'} /> {item.text}</div>;
    case 'compaction': return <div className="divider"><span>{item.status === 'running' ? 'Compacting the context…' : item.status === 'failed' ? 'Compacting the context failed' : `Context compacted${item.preTokens ? ` from ${tokens(item.preTokens)}` : ''}${item.postTokens ? ` to ${tokens(item.postTokens)}` : ''} tokens`}</span></div>;
    case 'todo': return (
      <div className="todo">
        {item.items.map(entry => <div key={entry.id} className={`todo-row ${entry.status}`}><span className="box">{entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '•' : ''}</span>{entry.text}</div>)}
      </div>
    );
    case 'tool_call': return <ToolRow item={item} sessionId={sessionId} />;
  }
});

function Timeline({ session }: { session: SessionView }) {
  const end = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    if (pinned.current) end.current?.scrollIntoView({ block: 'end' });
  }, [session.items, session.running]);
  return (
    <div className="timeline" ref={scroller} onScroll={event => {
      const target = event.currentTarget;
      pinned.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80;
    }}>
      <div className="timeline-inner">
        {session.order.map(id => { const item = session.items.get(id); return item ? <Item key={id} item={item} sessionId={session.id} /> : null; })}
        {session.running && <div className="working"><span className="spinner" /> Working…</div>}
        {session.error && <div className="notice error"><Icon name="alert" /> {session.error}</div>}
        <div ref={end} />
      </div>
    </div>
  );
}

function Question({ question }: { question: UserQuestion }) {
  const alpd = useAlpd();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const answer = (params: object) => alpd.request('question.answer', { questionId: question.id, ...params }).catch(cause => setError(cause.message));
  return (
    <div className="question">
      <div className="question-head"><Icon name="question" /> <strong>{question.agent}</strong> asks you</div>
      <Markdown text={question.body} />
      {!!question.options?.length && <div className="options">{question.options.map(option => <button key={option} onClick={() => answer({ text: option })}>{option}</button>)}</div>}
      <div className="question-reply">
        <input value={text} placeholder="Your answer" onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && text.trim()) void answer({ text: text.trim() }); }} />
        <button className="primary" disabled={!text.trim()} onClick={() => answer({ text: text.trim() })}>Answer</button>
        <button onClick={() => answer({ dismiss: true })}>Dismiss</button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

export function Composer({ placeholder, running, disabled, onSend, onStop, children }: { placeholder: string; running?: boolean; disabled?: boolean; onSend(text: string): Promise<void>; onStop?(): void; children?: ReactNode }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { area.current?.focus(); }, []);
  const send = async () => {
    const value = text.trim();
    if (!value || sending || disabled) return;
    setSending(true);
    setError('');
    try { await onSend(value); setText(''); } catch (cause: any) { setError(cause?.message ?? String(cause)); } finally { setSending(false); }
  };
  const keys = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  };
  return (
    <div className="composer">
      {error && <p className="error-text">{error}</p>}
      <div className="composer-box">
        <textarea ref={area} value={text} rows={Math.min(10, Math.max(2, text.split('\n').length))} placeholder={placeholder} onChange={event => setText(event.target.value)} onKeyDown={keys} />
        <div className="composer-bar">
          <div className="composer-controls">{children}</div>
          {running && onStop && <button className="icon-button stop" title="Stop main and the work it started" onClick={onStop}><Icon name="stop" /></button>}
          <button className="icon-button send" title={running ? 'Send while it works (main reads it now)' : 'Send'} disabled={!text.trim() || sending || disabled} onClick={() => void send()}><Icon name="send" /></button>
        </div>
      </div>
    </div>
  );
}

export function SessionScreen({ id, summary, onChanged }: { id: string; summary?: SessionSummary; onChanged(): void }) {
  const alpd = useAlpd();
  const [rootId, setRootId] = useState<string>();
  const [loadError, setLoadError] = useState('');
  const [reopened, setReopened] = useState(false);
  const [panel, setPanel] = useState(() => { try { return localStorage.getItem('alp.panel') !== 'closed'; } catch { return true; } });
  const session = useSession(id);
  const questions = useQuestions(rootId);
  useEffect(() => {
    let live = true;
    follow(alpd, id).then(root => { if (live) setRootId(root.id); }).catch(error => { if (live) setLoadError(error.message); });
    return () => { live = false; };
  }, [alpd, id]);
  const snapshot = session?.snapshot ?? summary;
  const child = !!snapshot?.parentId;
  // Open in alpd: after a resume here, or as alpd lists it, or as its events say.
  const open = !!session?.snapshot && !session.closed && (reopened || !summary || summary.status === 'idle' || summary.status === 'running');
  const running = !!session?.running;

  async function send(text: string) {
    if (child) { await alpd.request('session.message', { sessionId: id, text }); return; }
    if (!open) {
      await alpd.request('session.create', { sessionId: id, spec: { cwd: snapshot!.projectRoot }, resume: true });
      setReopened(true);
      onChanged();
    }
    await alpd.request('session.prompt', { sessionId: id, clientMessageId: crypto.randomUUID(), delivery: running ? 'steer' : 'auto', content: [{ type: 'text', text }] });
  }

  const togglePanel = () => setPanel(value => { try { localStorage.setItem('alp.panel', value ? 'closed' : 'open'); } catch {} return !value; });

  if (loadError && !session) return <div className="empty"><p className="error-text">{loadError}</p></div>;
  return (
    <div className={`session-screen${panel ? ' with-panel' : ''}`}>
      <div className="session-column">
        <header className="session-header">
          <div className="crumbs">
            {child && <button className="link" onClick={() => go({ screen: 'session', id: snapshot!.parentId! })}>← requester</button>}
            <span className={`dot ${summary ? statusOf(summary) : running ? 'running' : open ? 'idle' : 'closed'}`} />
            <strong className="title">{summary?.title ?? (snapshot ? `${snapshot.agent}${child ? ' (assignment)' : ''}` : 'Session')}</strong>
          </div>
          {snapshot && <div className="meta muted small">
            {projectName(snapshot.projectRoot)} · {snapshot.teamLabel ?? snapshot.workflow?.mode} · {snapshot.agent} on {snapshot.runtime}:{snapshot.model}
            {snapshot.parked ? ` · parked: ${snapshot.parked}` : ''}
          </div>}
          <div className="header-actions">
            {snapshot && !child && <select value={snapshot.mode} disabled={!open || running} title="Permissions; change while idle" onChange={event => void alpd.request('session.configure', { sessionId: id, mode: event.target.value }).catch(error => alert(error.message))}>
              {MODES.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
            </select>}
            <button className="icon-button" title={panel ? 'Hide the side panel' : 'Show team, tasks and changes'} onClick={togglePanel}><Icon name="list" /></button>
          </div>
        </header>
        {session ? <Timeline session={session} /> : <div className="timeline"><div className="timeline-inner muted">Loading…</div></div>}
        <div className="dock">
          {[...(questions?.values() ?? [])].map(question => <Question key={question.id} question={question} />)}
          <Composer
            placeholder={child ? `Write to ${snapshot?.agent ?? 'this agent'} (arrives as mail from you)` : open ? (running ? 'Add to what main is doing…' : 'Message main…') : 'Message main to resume this session…'}
            running={running && !child}
            onSend={send}
            onStop={() => void alpd.request('session.interrupt', { sessionId: id })}
          />
        </div>
      </div>
      {panel && snapshot && <SidePanel rootId={rootId ?? id} projectRoot={snapshot.projectRoot} live={open} />}
    </div>
  );
}
