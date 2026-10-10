import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { forgetProject, go, savedProjects, type Route } from './context';
import type { SessionSummary } from './types';
import { Icon, projectName, statusOf } from './ui';

/**
 * The left sidebar, as Paseo's (packages/app/src/components/left-sidebar.tsx and
 * sidebar-workspace-list.tsx there): nav rows on top, then projects with their sessions,
 * then a line of icons at the bottom. ALP's sessions take the place of Paseo's workspaces.
 */

/** Paseo's identity colors (styles/identity-colors.ts): a project's square takes one by a hash of its key. */
const IDENTITY = ['#7a6aa8', '#3d7ea6', '#388068', '#a4673a', '#b05c80', '#6a70b8', '#368080', '#b06260', '#8f7838', '#5179b0'];

function identity(key: string) {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return IDENTITY[hash % IDENTITY.length];
}

/** Paseo shows a few of a project's workspaces and folds the rest under "Show more". */
const SHOWN = 6;
export const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 200;
const MAX_WIDTH = 600;

export type SessionBucket = 'running' | 'needs_input' | 'failed' | 'idle';

export function bucketOf(session: SessionSummary, asking: Set<string>): SessionBucket {
  if (asking.has(session.id)) return 'needs_input';
  const status = statusOf(session);
  if (status === 'running') return 'running';
  if (status === 'error') return 'failed';
  return 'idle';
}

/** The slot left of a session's title: a ring while it works, an alert when it waits for you, a dot when it failed. */
function StatusSlot({ bucket }: { bucket: SessionBucket }) {
  return (
    <span className="status-slot" aria-label={bucket}>
      {bucket === 'running' && <span className="status-ring" />}
      {bucket === 'needs_input' && <span className="status-alert">!</span>}
      {bucket === 'failed' && <span className="status-dot failed" />}
    </span>
  );
}

function ProjectIcon({ project, bucket }: { project: string; bucket?: SessionBucket }) {
  return (
    <span className="project-icon" style={{ backgroundColor: identity(project) }}>
      {projectName(project).slice(0, 1).toUpperCase()}
      {bucket && bucket !== 'idle' && <span className={`project-badge ${bucket}`} />}
    </span>
  );
}

function NavRow({ icon, label, shortcut, active, onClick }: { icon: string; label: string; shortcut?: string; active?: boolean; onClick(): void }) {
  return (
    <button className={`nav-row${active ? ' active' : ''}`} onClick={onClick}>
      <Icon name={icon} size={14} />
      <span className="nav-label">{label}</span>
      {shortcut && <kbd className="shortcut">{shortcut}</kbd>}
    </button>
  );
}

function ProjectGroup({ project, sessions, current, asking, onNewSession }: { project: string; sessions: SessionSummary[]; current?: string; asking: Set<string>; onNewSession(project: string): void }) {
  const key = `alp.collapsed.${project}`;
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  const [more, setMore] = useState(false);
  const [menu, setMenu] = useState(false);
  const toggle = () => setCollapsed(value => { try { localStorage.setItem(key, value ? '0' : '1'); } catch {} return !value; });
  // The current session always shows, even past the fold.
  const shown = more ? sessions : sessions.filter((session, index) => index < SHOWN || session.id === current);
  const hidden = sessions.length - shown.length;
  const busiest = sessions.map(session => bucketOf(session, asking)).sort((a, b) => ['needs_input', 'failed', 'running', 'idle'].indexOf(a) - ['needs_input', 'failed', 'running', 'idle'].indexOf(b))[0];
  return (
    <div className={`project-block${collapsed ? '' : ' expanded'}`}>
      <div className="project-row" onClick={toggle} title={project}>
        <span className="project-leading">
          <span className="project-leading-icon"><ProjectIcon project={project} bucket={collapsed ? busiest : undefined} /></span>
          <span className="project-leading-chevron"><Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={14} /></span>
        </span>
        <span className="project-title">{projectName(project)}</span>
        <span className="project-actions" onClick={event => event.stopPropagation()}>
          <button className="row-icon" title="New session" onClick={() => onNewSession(project)}><Icon name="plus" size={14} /></button>
          <span className="menu-anchor">
            <button className="row-icon" title="More" onClick={() => setMenu(value => !value)}><Icon name="ellipsis" size={14} /></button>
            {menu && (
              <div className="menu" onMouseLeave={() => setMenu(false)}>
                <button onClick={() => { setMenu(false); onNewSession(project); }}><Icon name="plus" size={14} /> New session</button>
                <button onClick={() => { setMenu(false); void navigator.clipboard?.writeText(project); }}><Icon name="copy" size={14} /> Copy path</button>
                {!sessions.length && <button onClick={() => { setMenu(false); forgetProject(project); dispatchEvent(new Event('alp-projects')); }}><Icon name="x" size={14} /> Remove from the list</button>}
              </div>
            )}
          </span>
        </span>
      </div>
      {!collapsed && (
        <div className="workspace-list">
          {shown.map(session => (
            <button key={session.id} className={`workspace-row${current === session.id ? ' selected' : ''}`} onClick={() => go({ screen: 'session', id: session.id })} title={session.title ?? undefined}>
              <StatusSlot bucket={bucketOf(session, asking)} />
              <span className="workspace-title">{session.title ?? `${session.agent} session`}</span>
            </button>
          ))}
          {hidden > 0 && <button className="workspace-row ghost" onClick={() => setMore(true)}><span className="status-slot" /><span className="workspace-title">Show {hidden} more</span></button>}
          {more && sessions.length > SHOWN && <button className="workspace-row ghost" onClick={() => setMore(false)}><span className="status-slot" /><span className="workspace-title">Show less</span></button>}
          {!sessions.length && <button className="workspace-row ghost" onClick={() => onNewSession(project)}><span className="status-slot"><Icon name="plus" size={14} /></span><span className="workspace-title">New session</span></button>}
        </div>
      )}
    </div>
  );
}

export type Theme = 'system' | 'dark' | 'light';

export function applyTheme(theme: Theme) {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

function SettingsMenu({ onClose }: { onClose(): void }) {
  const [theme, setTheme] = useState<Theme>(() => { try { return (localStorage.getItem('alp.theme') as Theme) || 'system'; } catch { return 'system'; } });
  const choose = (next: Theme) => { setTheme(next); applyTheme(next); try { localStorage.setItem('alp.theme', next); } catch {} };
  return (
    <div className="menu footer-menu" onMouseLeave={onClose}>
      <div className="menu-title">Appearance</div>
      {(['system', 'dark', 'light'] as Theme[]).map(option => (
        <button key={option} onClick={() => choose(option)}>
          <Icon name={theme === option ? 'check' : 'blank'} size={14} /> {option === 'system' ? 'Match the system' : option === 'dark' ? 'Dark' : 'Light'}
        </button>
      ))}
    </div>
  );
}

export function Sidebar({ sessions, asking, route, width, onWidth, onCollapse, onOpenProject, onSearch, onNewSession }: {
  sessions: SessionSummary[];
  /** Roots with a question waiting for the user. */
  asking: Set<string>;
  route: Route;
  width: number;
  onWidth(width: number): void;
  onCollapse(): void;
  onOpenProject(): void;
  onSearch(): void;
  onNewSession(project?: string): void;
}) {
  const [version, setVersion] = useState(0);
  const [settings, setSettings] = useState(false);
  useEffect(() => {
    const listen = () => setVersion(value => value + 1);
    addEventListener('alp-projects', listen);
    return () => removeEventListener('alp-projects', listen);
  }, []);
  const projects = useMemo(() => {
    const byProject = new Map<string, SessionSummary[]>();
    for (const project of savedProjects()) byProject.set(project, []);
    for (const session of sessions) {
      const list = byProject.get(session.projectRoot) ?? [];
      list.push(session);
      byProject.set(session.projectRoot, list);
    }
    const latest = (list: SessionSummary[]) => list.reduce((at, session) => (session.updatedAt ?? '') > at ? session.updatedAt ?? '' : at, '');
    return [...byProject].sort((a, b) => latest(b[1]).localeCompare(latest(a[1])) || a[0].localeCompare(b[0]));
    // savedProjects changes outside React; the version bump re-reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, version]);
  const current = route.screen === 'session' ? route.id : undefined;
  const dragging = useRef<{ x: number; width: number } | null>(null);
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  return (
    <aside className="sidebar" style={{ width } as CSSProperties}>
      <div className="sidebar-chrome">
        <span className="brand">ALP</span>
        <button className="row-icon" title="Hide the sidebar (⌘B)" onClick={onCollapse}><Icon name="panel-left" size={16} /></button>
      </div>
      <nav className="sidebar-header-group">
        <NavRow icon="plus" label="New session" shortcut="⌘⇧O" onClick={() => onNewSession()} active={route.screen === 'new'} />
        <NavRow icon="history" label="History" active={route.screen === 'history'} onClick={() => go({ screen: 'history' })} />
        <NavRow icon="search" label="Search" shortcut="⌘K" onClick={onSearch} />
      </nav>
      <div className="sidebar-list">
        <div className="section-header">
          <span>Projects</span>
          <button className="row-icon" title="Open a project" onClick={onOpenProject}><Icon name="folder-plus" size={14} /></button>
        </div>
        {projects.length === 0 && <p className="sidebar-empty">No projects yet. Open a folder to start a session in it.</p>}
        {projects.map(([project, list]) => <ProjectGroup key={project} project={project} sessions={list} current={current} asking={asking} onNewSession={onNewSession} />)}
      </div>
      <footer className="sidebar-footer">
        <button className="footer-icon" title="Open a project" onClick={onOpenProject}><Icon name="folder-plus" size={16} /></button>
        <span className="footer-spacer" />
        <a className="footer-icon" title="Help" href="https://github.com/phucanh08/alp-paseo#readme" target="_blank" rel="noopener noreferrer"><Icon name="help" size={16} /></a>
        <span className="menu-anchor">
          <button className="footer-icon" title="Settings" onClick={() => setSettings(value => !value)}><Icon name="settings" size={16} /></button>
          {settings && <SettingsMenu onClose={() => setSettings(false)} />}
        </span>
      </footer>
      <div
        className="sidebar-resize"
        onPointerDown={resize}
        onPointerMove={event => { if (dragging.current) onWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragging.current.width + event.clientX - dragging.current.x))); }}
        onPointerUp={() => { dragging.current = null; }}
        onDoubleClick={() => onWidth(DEFAULT_WIDTH)}
      />
    </aside>
  );
}

/** ⌘K: jump to a session or a project, as Paseo's command center. */
export function SearchPalette({ sessions, onClose, onNewSession }: { sessions: SessionSummary[]; onClose(): void; onNewSession(project: string): void }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const results = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (text: string) => words.every(word => text.toLowerCase().includes(word));
    const projects = [...new Set([...savedProjects(), ...sessions.map(session => session.projectRoot)])];
    return [
      ...sessions.filter(session => match(`${session.title ?? ''} ${session.agent} ${projectName(session.projectRoot)}`)).slice(0, 30).map(session => ({ kind: 'session' as const, session })),
      ...projects.filter(project => match(project)).slice(0, 10).map(project => ({ kind: 'project' as const, project })),
    ];
  }, [query, sessions]);
  const open = (at: number) => {
    const result = results[at];
    if (!result) return;
    onClose();
    if (result.kind === 'session') go({ screen: 'session', id: result.session.id });
    else onNewSession(result.project);
  };
  return (
    <div className="overlay top" onClick={onClose}>
      <div className="palette" onClick={event => event.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input autoFocus value={query} placeholder="Search sessions and projects" onChange={event => { setQuery(event.target.value); setIndex(0); }}
            onKeyDown={event => {
              if (event.key === 'Escape') onClose();
              else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(value => Math.min(results.length - 1, value + 1)); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(value => Math.max(0, value - 1)); }
              else if (event.key === 'Enter') open(index);
            }} />
        </div>
        <div className="palette-results">
          {results.length === 0 && <p className="muted pad">Nothing matches.</p>}
          {results.map((result, at) => (
            <button key={result.kind === 'session' ? result.session.id : `p:${result.project}`} className={`palette-row${at === index ? ' active' : ''}`} onMouseEnter={() => setIndex(at)} onClick={() => open(at)}>
              {result.kind === 'session'
                ? <><StatusSlot bucket={bucketOf(result.session, new Set())} /><span className="workspace-title">{result.session.title ?? `${result.session.agent} session`}</span><span className="muted small">{projectName(result.session.projectRoot)}</span></>
                : <><ProjectIcon project={result.project} /><span className="workspace-title">New session in {projectName(result.project)}</span><span className="muted small">{result.project}</span></>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const day = (iso?: string) => {
  if (!iso) return 'Earlier';
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
};

/** Every session alpd keeps, newest first, by day: Paseo's History. */
export function HistoryScreen({ sessions }: { sessions: SessionSummary[] }) {
  const [query, setQuery] = useState('');
  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = sessions.filter(session => words.every(word => `${session.title ?? ''} ${session.agent} ${session.projectRoot}`.toLowerCase().includes(word)))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const byDay = new Map<string, SessionSummary[]>();
    for (const session of rows) { const label = day(session.updatedAt); byDay.set(label, [...(byDay.get(label) ?? []), session]); }
    return [...byDay];
  }, [query, sessions]);
  return (
    <div className="history">
      <div className="history-inner">
        <h1>History</h1>
        <input className="history-search" value={query} placeholder="Search sessions" onChange={event => setQuery(event.target.value)} />
        {groups.length === 0 && <p className="muted">No sessions yet.</p>}
        {groups.map(([label, rows]) => (
          <section key={label}>
            <h4>{label}</h4>
            {rows.map(session => (
              <button key={session.id} className="history-row" onClick={() => go({ screen: 'session', id: session.id })}>
                <ProjectIcon project={session.projectRoot} />
                <span className="workspace-title">{session.title ?? `${session.agent} session`}</span>
                <span className="muted small">{projectName(session.projectRoot)} · {session.teamLabel ?? session.workflow?.mode} · {session.status}</span>
                <span className="muted small">{session.updatedAt ? new Date(session.updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
