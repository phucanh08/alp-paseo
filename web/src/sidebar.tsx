import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { forgetProject, go, savedProjects, useAlpd, type Route } from './context';
import { addLabel, isUnread, markSeen, markUnread, seedSeen, toggleLabel, togglePin, usePrefs } from './prefs';
import type { SessionSummary } from './types';
import { Icon, projectName, statusOf } from './ui';

/**
 * The left sidebar, as Paseo's (packages/app/src/components/left-sidebar.tsx,
 * sidebar-workspace-list.tsx and sidebar/sidebar-workspace-menu.tsx there): nav rows on top,
 * pinned sessions, then projects with their sessions, then a line of icons at the bottom.
 * ALP's sessions take the place of Paseo's workspaces.
 */

/** Paseo's identity colors (styles/identity-colors.ts): a project's square takes one by a hash of its key. */
const IDENTITY = ['#7a6aa8', '#3d7ea6', '#388068', '#a4673a', '#b05c80', '#6a70b8', '#368080', '#b06260', '#8f7838', '#5179b0'];

export function identity(key: string) {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return IDENTITY[hash % IDENTITY.length];
}

/** Paseo shows a few of a project's workspaces and folds the rest under "Show more". */
const SHOWN = 6;
export const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 200;
const MAX_WIDTH = 600;

/** Paseo's buckets: attention is a finished session the user has not seen yet. */
export type SessionBucket = 'running' | 'needs_input' | 'failed' | 'attention' | 'idle';

export function bucketOf(session: SessionSummary, asking: Set<string>, current?: string): SessionBucket {
  if (asking.has(session.id)) return 'needs_input';
  const status = statusOf(session);
  if (status === 'running') return 'running';
  if (status === 'error') return 'failed';
  if (isUnread(session, current)) return 'attention';
  return 'idle';
}

const RANK: SessionBucket[] = ['needs_input', 'failed', 'running', 'attention', 'idle'];

/** The slot left of a session's title: a ring while it works, an alert when it waits for you, a dot otherwise. */
function StatusSlot({ bucket }: { bucket: SessionBucket }) {
  return (
    <span className="status-slot" aria-label={bucket}>
      {bucket === 'running' && <span className="status-ring" />}
      {bucket === 'needs_input' && <span className="status-alert">!</span>}
      {bucket === 'failed' && <span className="status-dot failed" />}
      {bucket === 'attention' && <span className="status-dot attention" />}
      {bucket === 'idle' && <span className="status-dot idle" />}
    </span>
  );
}

export function ProjectIcon({ project, bucket }: { project: string; bucket?: SessionBucket }) {
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

export type MenuItem =
  | { label: string; icon: string; onSelect(): void; shortcut?: string; danger?: boolean }
  | { label: string; icon: string; submenu: () => ReactNode }
  | 'separator';

/**
 * Paseo's dropdown menu (components/ui/menu): a 260 wide surface below its trigger, aligned to
 * its end, rows of icon and label, an optional shortcut chip, and pages for submenus.
 */
export function Menu({ anchor, items, onClose, width = 260 }: { anchor: HTMLElement; items: MenuItem[]; onClose(): void; width?: number }) {
  const surface = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState<{ label: string; render: () => ReactNode } | null>(null);
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const height = surface.current?.offsetHeight ?? 0;
    const below = rect.bottom + 4 + height < innerHeight;
    setPlace({ top: below ? rect.bottom + 4 : Math.max(8, rect.top - 4 - height), left: Math.max(8, Math.min(rect.right - width, innerWidth - width - 8)), width });
  }, [anchor, width, page]);
  useEffect(() => {
    const away = (event: MouseEvent) => { if (!surface.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); if (page) setPage(null); else onClose(); } };
    addEventListener('mousedown', away);
    addEventListener('keydown', escape, true);
    return () => { removeEventListener('mousedown', away); removeEventListener('keydown', escape, true); };
  }, [anchor, onClose, page]);
  // React events bubble from the menu to the row it sits in; the surface keeps them.
  return (
    <div ref={surface} className="menu-surface" style={place} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
      {page ? <>
        <button className="menu-item" onClick={() => setPage(null)}><Icon name="chevron-left" size={16} /><span className="menu-label">{page.label}</span></button>
        <div className="menu-separator" />
        {page.render()}
      </> : items.map((item, index) => {
        if (item === 'separator') return <div key={index} className="menu-separator" />;
        if ('submenu' in item) return (
          <button key={item.label} className="menu-item" onClick={() => setPage({ label: item.label, render: item.submenu })}>
            <Icon name={item.icon} size={16} /><span className="menu-label">{item.label}</span><Icon name="chevron-right" size={16} />
          </button>
        );
        return (
          <button key={item.label} className={`menu-item${item.danger ? ' danger' : ''}`} onClick={() => { onClose(); item.onSelect(); }}>
            <Icon name={item.icon} size={16} /><span className="menu-label">{item.label}</span>{item.shortcut && <kbd className="menu-shortcut">{item.shortcut}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

function LabelsPage({ id }: { id: string }) {
  const prefs = usePrefs();
  const [adding, setAdding] = useState('');
  const chosen = prefs.labels[id] ?? [];
  return <>
    {prefs.catalog.map(label => (
      <button key={label} className="menu-item" onClick={() => toggleLabel(id, label)}>
        <span className="label-swatch" style={{ backgroundColor: identity(label) }} />
        <span className="menu-label">{label}</span>
        {chosen.includes(label) && <Icon name="check" size={16} />}
      </button>
    ))}
    <div className="menu-separator" />
    <div className="menu-input">
      <input value={adding} placeholder="New label" onChange={event => setAdding(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && adding.trim()) { toggleLabel(id, addLabel(adding)); setAdding(''); } }} />
    </div>
  </>;
}

/** A session's menu, with Paseo's items: copy, rename, read state, pin, labels, file manager, archive. */
export function useSessionMenu(session: SessionSummary, { onRename, current }: { onRename(): void; current?: string }): MenuItem[] {
  const alpd = useAlpd();
  const prefs = usePrefs();
  const copy = (text: string) => void navigator.clipboard?.writeText(text);
  const unread = isUnread(session, current);
  return [
    { label: 'Copy path', icon: 'copy', onSelect: () => copy(session.projectRoot) },
    { label: 'Copy branch name', icon: 'copy', onSelect: () => void alpd.request<{ branch?: string }>('project.info', { projectRoot: session.projectRoot }).then(info => { if (info.branch) copy(info.branch); else alert('This project is not on a git branch'); }) },
    { label: 'Rename session', icon: 'pencil', onSelect: onRename },
    unread
      ? { label: 'Mark as read', icon: 'circle-check', onSelect: () => markSeen(session.id) }
      : { label: 'Mark as unread', icon: 'circle', onSelect: () => markUnread(session.id) },
    prefs.pinned.includes(session.id)
      ? { label: 'Unpin', icon: 'pin-off', onSelect: () => togglePin(session.id) }
      : { label: 'Pin to top', icon: 'pin', onSelect: () => togglePin(session.id) },
    { label: 'Labels', icon: 'tag', submenu: () => <LabelsPage id={session.id} /> },
    { label: 'Open in file manager', icon: 'folder-open', onSelect: () => void alpd.request('project.reveal', { path: session.projectRoot }) },
    { label: 'Archive', icon: 'archive', shortcut: '⇧⌘⌫', onSelect: () => void archive(alpd, session.id, current) },
  ];
}

export async function archive(alpd: ReturnType<typeof useAlpd>, id: string, current?: string) {
  await alpd.request('session.archive', { sessionId: id }).catch(error => alert(error.message));
  if (id === current) go({ screen: 'home' });
  dispatchEvent(new Event('alp-sessions'));
}

function SessionRow({ session, current, asking, pinned }: { session: SessionSummary; current?: string; asking: Set<string>; pinned?: boolean }) {
  const alpd = useAlpd();
  const prefs = usePrefs();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  // Enter ends the edit and then the input's blur would end it again.
  const editing = useRef(false);
  const items = useSessionMenu(session, { current, onRename: () => { setName(session.title ?? ''); editing.current = true; setRenaming(true); } });
  const title = session.title ?? `${session.agent} session`;
  const labels = prefs.labels[session.id] ?? [];
  const finish = (save: boolean) => {
    if (!editing.current) return;
    editing.current = false;
    setRenaming(false);
    if (save && name.trim() && name.trim() !== session.title) void alpd.request('session.rename', { sessionId: session.id, title: name.trim() }).then(() => dispatchEvent(new Event('alp-sessions')), error => alert(error.message));
  };
  return (
    <div className={`workspace-row${current === session.id ? ' selected' : ''}${pinned ? ' flush' : ''}${menu ? ' menu-open' : ''}`} role="button" tabIndex={0} title={title}
      onClick={() => { if (!renaming) go({ screen: 'session', id: session.id }); }}
      onKeyDown={event => { if (event.key === 'Enter' && !renaming) go({ screen: 'session', id: session.id }); }}
      onContextMenu={event => { event.preventDefault(); setMenu(event.currentTarget.querySelector<HTMLElement>('.row-kebab')); }}>
      <div className="workspace-main">
        {pinned ? <span className="status-slot"><ProjectIcon project={session.projectRoot} bucket={bucketOf(session, asking, current)} /></span> : <StatusSlot bucket={bucketOf(session, asking, current)} />}
        {renaming
          ? <input className="rename-input" autoFocus value={name} onClick={event => event.stopPropagation()} onChange={event => setName(event.target.value)}
              onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') finish(true); if (event.key === 'Escape') finish(false); }} onBlur={() => finish(true)} />
          : <span className="workspace-title">{title}</span>}
        <button className="row-kebab" title="Session actions" onClick={event => { event.stopPropagation(); setMenu(menu ? null : event.currentTarget); }}><Icon name="more-vertical" size={16} /></button>
      </div>
      {labels.length > 0 && (
        <div className="workspace-meta">
          {labels.map(label => <span key={label} className="label-chip" style={{ color: identity(label), borderColor: `${identity(label)}66` }}>{label}</span>)}
        </div>
      )}
      {menu && <Menu anchor={menu} items={items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function ProjectGroup({ project, sessions, current, asking, onNewSession }: { project: string; sessions: SessionSummary[]; current?: string; asking: Set<string>; onNewSession(project: string): void }) {
  const key = `alp.collapsed.${project}`;
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  const [more, setMore] = useState(false);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const alpd = useAlpd();
  const toggle = () => setCollapsed(value => { try { localStorage.setItem(key, value ? '0' : '1'); } catch {} return !value; });
  // The current session always shows, even past the fold.
  const shown = more ? sessions : sessions.filter((session, index) => index < SHOWN || session.id === current);
  const hidden = sessions.length - shown.length;
  const busiest = sessions.map(session => bucketOf(session, asking, current)).sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0];
  const items: MenuItem[] = [
    { label: 'New session', icon: 'plus', onSelect: () => onNewSession(project) },
    { label: 'Copy path', icon: 'copy', onSelect: () => void navigator.clipboard?.writeText(project) },
    { label: 'Open in file manager', icon: 'folder-open', onSelect: () => void alpd.request('project.reveal', { path: project }) },
    ...(!sessions.length ? [{ label: 'Remove from the list', icon: 'x', onSelect: () => { forgetProject(project); dispatchEvent(new Event('alp-projects')); } }] : []),
  ];
  return (
    <div className={`project-block${collapsed ? '' : ' expanded'}`}>
      <div className={`project-row${menu ? ' menu-open' : ''}`} onClick={toggle} title={project}>
        <span className="project-leading">
          <span className="project-leading-icon"><ProjectIcon project={project} bucket={collapsed ? busiest : undefined} /></span>
          <span className="project-leading-chevron"><Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={14} /></span>
        </span>
        <span className="project-title">{projectName(project)}</span>
        <span className="project-actions" onClick={event => event.stopPropagation()}>
          <button className="row-icon" title="New session" onClick={() => onNewSession(project)}><Icon name="plus" size={14} /></button>
          <button className="row-icon" title="Project actions" onClick={event => setMenu(menu ? null : event.currentTarget)}><Icon name="ellipsis" size={14} /></button>
        </span>
        {menu && <Menu anchor={menu} items={items} onClose={() => setMenu(null)} />}
      </div>
      {!collapsed && (
        <div className="workspace-list">
          {shown.map(session => <SessionRow key={session.id} session={session} current={current} asking={asking} />)}
          {hidden > 0 && <button className="workspace-row ghost" onClick={() => setMore(true)}><span className="workspace-main"><span className="status-slot" /><span className="workspace-title">Show {hidden} more</span></span></button>}
          {more && sessions.length > SHOWN && <button className="workspace-row ghost" onClick={() => setMore(false)}><span className="workspace-main"><span className="status-slot" /><span className="workspace-title">Show less</span></span></button>}
          {!sessions.length && <button className="workspace-row ghost" onClick={() => onNewSession(project)}><span className="workspace-main"><span className="status-slot"><Icon name="plus" size={14} /></span><span className="workspace-title">New session</span></span></button>}
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

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => { try { return (localStorage.getItem('alp.theme') as Theme) || 'system'; } catch { return 'system'; } });
  const choose = (next: Theme) => { setTheme(next); applyTheme(next); try { localStorage.setItem('alp.theme', next); } catch {} };
  return [theme, choose] as const;
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
  const prefs = usePrefs();
  const [version, setVersion] = useState(0);
  const [settings, setSettings] = useState<HTMLElement | null>(null);
  const [theme, setTheme] = useTheme();
  useEffect(() => {
    const listen = () => setVersion(value => value + 1);
    addEventListener('alp-projects', listen);
    return () => removeEventListener('alp-projects', listen);
  }, []);
  const current = route.screen === 'session' ? route.id : undefined;
  useEffect(() => { seedSeen(sessions); }, [sessions]);
  // The session on screen is read, as far as it has come.
  const shownSession = sessions.find(session => session.id === current);
  useEffect(() => { if (shownSession) markSeen(shownSession.id, shownSession.updatedAt); }, [shownSession?.id, shownSession?.updatedAt]);
  const pinned = useMemo(() => prefs.pinned.map(id => sessions.find(session => session.id === id)).filter((session): session is SessionSummary => !!session), [prefs.pinned, sessions]);
  const projects = useMemo(() => {
    const byProject = new Map<string, SessionSummary[]>();
    for (const project of savedProjects()) byProject.set(project, []);
    for (const session of sessions) {
      const list = byProject.get(session.projectRoot) ?? [];
      if (!prefs.pinned.includes(session.id)) list.push(session);
      byProject.set(session.projectRoot, list);
    }
    const latest = (list: SessionSummary[]) => list.reduce((at, session) => (session.updatedAt ?? '') > at ? session.updatedAt ?? '' : at, '');
    return [...byProject].sort((a, b) => latest(b[1]).localeCompare(latest(a[1])) || a[0].localeCompare(b[0]));
    // savedProjects changes outside React; the version bump re-reads it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, version, prefs.pinned]);
  const dragging = useRef<{ x: number; width: number } | null>(null);
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = { x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const themeItems: MenuItem[] = (['system', 'dark', 'light'] as Theme[]).map(option => ({
    label: option === 'system' ? 'Match the system' : option === 'dark' ? 'Dark' : 'Light',
    icon: theme === option ? 'check' : 'blank',
    onSelect: () => setTheme(option),
  }));
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
        {pinned.length > 0 && (
          <div className="pinned-section">
            <div className="section-header"><span>Pinned</span></div>
            {pinned.map(session => <SessionRow key={session.id} session={session} current={current} asking={asking} pinned />)}
          </div>
        )}
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
        <button className="footer-icon" title="Settings" onClick={event => setSettings(settings ? null : event.currentTarget)}><Icon name="settings" size={16} /></button>
        {settings && <Menu anchor={settings} items={themeItems} width={220} onClose={() => setSettings(null)} />}
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

/** Every session alpd keeps, newest first, by day: Paseo's History; archived ones on request. */
export function HistoryScreen({ sessions }: { sessions: SessionSummary[] }) {
  const alpd = useAlpd();
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState<SessionSummary[] | null>(null);
  const loadArchived = () => alpd.request<{ sessions: SessionSummary[] }>('session.list', { rootsOnly: true, includeClosed: true, includeArchived: true })
    .then(result => setArchived(result.sessions.filter(session => session.archived)), () => setArchived([]));
  const rowsOf = archived ?? sessions;
  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = rowsOf.filter(session => words.every(word => `${session.title ?? ''} ${session.agent} ${session.projectRoot}`.toLowerCase().includes(word)))
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    const byDay = new Map<string, SessionSummary[]>();
    for (const session of rows) { const label = day(session.updatedAt); byDay.set(label, [...(byDay.get(label) ?? []), session]); }
    return [...byDay];
  }, [query, rowsOf]);
  return (
    <div className="history">
      <div className="history-inner">
        <div className="history-head">
          <h1>{archived ? 'Archived' : 'History'}</h1>
          <button onClick={() => { if (archived) setArchived(null); else void loadArchived(); }}><Icon name="archive" size={14} /> {archived ? 'Show history' : 'Show archived'}</button>
        </div>
        <input className="history-search" value={query} placeholder="Search sessions" onChange={event => setQuery(event.target.value)} />
        {groups.length === 0 && <p className="muted">{archived ? 'Nothing is archived.' : 'No sessions yet.'}</p>}
        {groups.map(([label, rows]) => (
          <section key={label}>
            <h4>{label}</h4>
            {rows.map(session => (
              <div key={session.id} className="history-row" role="button" tabIndex={0} onClick={() => go({ screen: 'session', id: session.id })}>
                <ProjectIcon project={session.projectRoot} />
                <span className="workspace-title">{session.title ?? `${session.agent} session`}</span>
                <span className="muted small">{projectName(session.projectRoot)} · {session.teamLabel ?? session.workflow?.mode} · {session.status}</span>
                {archived
                  ? <button onClick={event => { event.stopPropagation(); void alpd.request('session.archive', { sessionId: session.id, archived: false }).then(() => { void loadArchived(); dispatchEvent(new Event('alp-sessions')); }); }}>Unarchive</button>
                  : <span className="muted small">{session.updatedAt ? new Date(session.updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : ''}</span>}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
