import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Alpd, takeToken, type LinkState } from './rpc';
import { apply, forget } from './store';
import type { PauseState, SessionSummary } from './types';
import { SessionScreen } from './session';
import { NewSession, ProjectPicker } from './start';
import { Icon, ago, projectName, statusOf } from './ui';
import { AlpdContext, attached, follow, forgetProject, go, parse, rememberProject, savedProjects, type Route } from './context';

/**
 * The ALP web app (ALPD §61), shaped after Paseo's: projects and their sessions on the
 * left, the open session in the middle, its team, tasks and changes on the right.
 */

function useHashRoute() {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const listen = () => setRoute(parse(location.hash));
    addEventListener('hashchange', listen);
    return () => removeEventListener('hashchange', listen);
  }, []);
  return route;
}

/** alpd's sessions and pauses, asked again every few seconds. */
function useSessions(alpd: Alpd) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [pauses, setPauses] = useState<PauseState | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => Promise.all([
      alpd.request<{ sessions: SessionSummary[] }>('session.list', { rootsOnly: true, includeClosed: true }),
      alpd.request<PauseState>('daemon.pauses'),
    ]).then(([list, paused]) => { if (live) { setSessions(list.sessions); setPauses(paused); } }).catch(() => {});
    void load();
    const timer = setInterval(load, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [alpd, tick]);
  return { sessions, pauses, refresh: useCallback(() => setTick(value => value + 1), []) };
}

function Sidebar({ sessions, route, onOpenProject }: { sessions: SessionSummary[]; route: Route; onOpenProject(): void }) {
  const [, rerender] = useState(0);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
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
  }, [sessions]);
  const current = route.screen === 'session' ? route.id : undefined;
  return (
    <aside className="sidebar">
      <div className="brand"><span className="logo">ALP</span><span className="muted">local</span></div>
      <button className="nav-row" onClick={onOpenProject}><Icon name="plus" /> Open a project</button>
      <div className="projects">
        {projects.length === 0 && <p className="muted pad">No projects yet. Open one to start a session.</p>}
        {projects.map(([project, list]) => (
          <section key={project} className="project">
            <div className="project-head">
              <button className="project-name" title={project} onClick={() => setCollapsed(state => ({ ...state, [project]: !state[project] }))}>
                <Icon name={collapsed[project] ? 'chevron-right' : 'chevron-down'} /> {projectName(project)}
              </button>
              <button className="icon-button" title="New session" onClick={() => go({ screen: 'new', project })}><Icon name="edit" /></button>
              {list.length === 0 && <button className="icon-button" title="Remove from the list" onClick={() => { forgetProject(project); rerender(value => value + 1); }}><Icon name="x" /></button>}
            </div>
            {!collapsed[project] && list.slice(0, 40).map(session => (
              <button key={session.id} className={`session-row${current === session.id ? ' active' : ''}`} onClick={() => go({ screen: 'session', id: session.id })}>
                <span className={`dot ${statusOf(session)}`} />
                <span className="session-title">{session.title ?? `${session.agent} session`}</span>
                <span className="muted small">{session.updatedAt ? ago(session.updatedAt) : ''}</span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}

function Banner({ pauses }: { pauses: PauseState | null }) {
  if (!pauses) return null;
  const paused = [...(pauses.all ? [`Everything: ${pauses.all.reason}`] : []), ...Object.entries(pauses.runtimes).map(([kind, pause]) => `${kind}: ${pause.reason}${pause.resetsAt ? ` (resets ${new Date(pause.resetsAt).toLocaleTimeString()})` : ''}`)];
  if (!paused.length) return null;
  return <div className="banner warning"><Icon name="pause" /> Paused — {paused.join(' · ')}{pauses.parked.length ? ` · ${pauses.parked.length} assignment(s) parked` : ''}</div>;
}

function Home({ onOpenProject }: { onOpenProject(): void }) {
  return (
    <div className="home">
      <h1>ALP</h1>
      <p className="muted">Teams of Codex and Claude Code agents, on your machine.</p>
      <button className="primary" onClick={onOpenProject}><Icon name="folder" /> Open a project</button>
      <p className="muted small">Or pick a project on the left and start a new session.</p>
    </div>
  );
}

function Shell({ alpd }: { alpd: Alpd }) {
  const route = useHashRoute();
  const { sessions, pauses, refresh } = useSessions(alpd);
  const [picking, setPicking] = useState(false);
  const [link, setLink] = useState<LinkState>(alpd.state);
  useEffect(() => alpd.onState(setLink), [alpd]);
  return (
    <div className="shell">
      <Sidebar sessions={sessions} route={route} onOpenProject={() => setPicking(true)} />
      <main className="main">
        {link !== 'open' && <div className={`banner ${link === 'unauthorized' ? 'error' : 'info'}`}>{link === 'unauthorized' ? 'alpd refused this page. Open it again with: alp web' : link === 'closed' ? 'Lost alpd; reconnecting…' : 'Connecting to alpd…'}</div>}
        <Banner pauses={pauses} />
        {route.screen === 'home' && <Home onOpenProject={() => setPicking(true)} />}
        {route.screen === 'new' && <NewSession key={route.project} project={route.project} onStarted={refresh} />}
        {route.screen === 'session' && <SessionScreen key={route.id} id={route.id} summary={sessions.find(session => session.id === route.id)} onChanged={refresh} />}
      </main>
      {picking && <ProjectPicker onClose={() => setPicking(false)} onChoose={project => { rememberProject(project); setPicking(false); go({ screen: 'new', project }); }} />}
    </div>
  );
}

function App() {
  const alpd = useMemo(() => new Alpd(takeToken()), []);
  useEffect(() => {
    const stop = alpd.onEvent(apply);
    // alpd came back: replay each followed tree from the start, as it may have changed meanwhile.
    let first = true;
    const reopen = alpd.onOpen(() => {
      if (first) { first = false; return; }
      for (const root of [...attached]) { attached.delete(root); forget(root); void follow(alpd, root).catch(() => {}); }
    });
    return () => { stop(); reopen(); };
  }, [alpd]);
  return <AlpdContext.Provider value={alpd}><Shell alpd={alpd} /></AlpdContext.Provider>;
}

createRoot(document.getElementById('root')!).render(<App />);
