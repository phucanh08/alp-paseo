import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { Alpd, takeToken, type LinkState } from './rpc';
import { apply, forget } from './store';
import type { PauseState, SessionSummary } from './types';
import { SessionScreen } from './session';
import { NewSession, ProjectPicker } from './start';
import { Icon } from './ui';
import { applyTheme, archive, DEFAULT_WIDTH, HistoryScreen, SearchPalette, Sidebar, type Theme } from './sidebar';
import { AlpdContext, attached, follow, go, parse, rememberProject, savedProjects } from './context';

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

/** alpd's sessions, pauses and the roots whose agents wait for the user, asked again every few seconds. */
function useSessions(alpd: Alpd) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [pauses, setPauses] = useState<PauseState | null>(null);
  const [asking, setAsking] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => Promise.all([
      alpd.request<{ sessions: SessionSummary[] }>('session.list', { rootsOnly: true, includeClosed: true }),
      alpd.request<PauseState>('daemon.pauses'),
      alpd.request<{ questions: Array<{ rootId: string }> }>('question.list'),
    ]).then(([list, paused, questions]) => {
      if (!live) return;
      setSessions(list.sessions);
      setPauses(paused);
      setAsking(new Set(questions.questions.map(question => question.rootId)));
    }).catch(() => {});
    void load();
    const timer = setInterval(load, 4000);
    // A rename or an archive asks again at once.
    addEventListener('alp-sessions', load);
    return () => { live = false; clearInterval(timer); removeEventListener('alp-sessions', load); };
  }, [alpd, tick]);
  return { sessions, pauses, asking, refresh: useCallback(() => setTick(value => value + 1), []) };
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

const stored = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const store = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch {} };

function Shell({ alpd }: { alpd: Alpd }) {
  const route = useHashRoute();
  const { sessions, pauses, asking, refresh } = useSessions(alpd);
  const [picking, setPicking] = useState(false);
  const [searching, setSearching] = useState(false);
  const [width, setWidth] = useState(() => Number(stored('alp.sidebar.width', String(DEFAULT_WIDTH))) || DEFAULT_WIDTH);
  const [hidden, setHidden] = useState(() => stored('alp.sidebar.hidden', '0') === '1');
  const [link, setLink] = useState<LinkState>(alpd.state);
  useEffect(() => alpd.onState(setLink), [alpd]);
  useEffect(() => { store('alp.sidebar.width', String(width)); }, [width]);
  useEffect(() => { store('alp.sidebar.hidden', hidden ? '1' : '0'); }, [hidden]);

  // The project a new session starts in: the one on screen, else the latest worked in; else choose one.
  const current = route.screen === 'session' ? sessions.find(session => session.id === route.id)?.projectRoot : route.screen === 'new' ? route.project : undefined;
  const newSession = useCallback((project?: string) => {
    const where = project ?? current ?? sessions[0]?.projectRoot ?? savedProjects()[0];
    if (where) go({ screen: 'new', project: where });
    else setPicking(true);
  }, [current, sessions]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'k') { event.preventDefault(); setSearching(value => !value); }
      else if (key === 'b') { event.preventDefault(); setHidden(value => !value); }
      else if (key === 'o' && event.shiftKey) { event.preventDefault(); newSession(); }
      else if (key === 'backspace' && event.shiftKey && route.screen === 'session') {
        // Paseo's ⇧⌘⌫: archive the session on screen (a root; a team member's screen is not one).
        const target = event.target as HTMLElement;
        if (target.closest('input, textarea, [contenteditable]') || !sessions.some(session => session.id === route.id)) return;
        event.preventDefault();
        if (confirm('Archive this session? It closes and leaves the sidebar; History can bring it back.')) void archive(alpd, route.id, route.id);
      }
    };
    addEventListener('keydown', keys);
    return () => removeEventListener('keydown', keys);
  }, [newSession, route, sessions, alpd]);

  return (
    <div className="shell">
      {!hidden && <Sidebar sessions={sessions} asking={asking} route={route} width={width} onWidth={setWidth} onCollapse={() => setHidden(true)} onOpenProject={() => setPicking(true)} onSearch={() => setSearching(true)} onNewSession={newSession} />}
      <main className="main">
        {hidden && <button className="row-icon sidebar-reopen" title="Show the sidebar (⌘B)" onClick={() => setHidden(false)}><Icon name="panel-left" size={16} /></button>}
        {link !== 'open' && <div className={`banner ${link === 'unauthorized' ? 'error' : 'info'}`}>{link === 'unauthorized' ? 'alpd refused this page. Open it again with: alp web' : link === 'closed' ? 'Lost alpd; reconnecting…' : 'Connecting to alpd…'}</div>}
        <Banner pauses={pauses} />
        {route.screen === 'home' && <Home onOpenProject={() => setPicking(true)} />}
        {route.screen === 'history' && <HistoryScreen sessions={sessions} />}
        {route.screen === 'new' && <NewSession key={route.project} project={route.project} onStarted={refresh} />}
        {route.screen === 'session' && <SessionScreen key={route.id} id={route.id} summary={sessions.find(session => session.id === route.id)} onChanged={refresh} />}
      </main>
      {picking && <ProjectPicker onClose={() => setPicking(false)} onChoose={project => { rememberProject(project); setPicking(false); dispatchEvent(new Event('alp-projects')); go({ screen: 'new', project }); }} />}
      {searching && <SearchPalette sessions={sessions} onClose={() => setSearching(false)} onNewSession={project => go({ screen: 'new', project })} />}
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

applyTheme(stored('alp.theme', 'system') as Theme);
createRoot(document.getElementById('root')!).render(<App />);
