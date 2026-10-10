import { useEffect, useState } from 'react';
import { go, rememberProject, useAlpd } from './context';
import { Composer } from './session';
import type { SessionPreview } from './types';
import { Icon, MODES, projectName } from './ui';

/** Starting work: choosing a project folder, and a new session with its team and permissions. */

type Browse = { path: string; parent: string | null; home: string; project: boolean; directories: Array<{ name: string; project: boolean }> };

export function ProjectPicker({ onClose, onChoose }: { onClose(): void; onChoose(project: string): void }) {
  const alpd = useAlpd();
  const [where, setWhere] = useState<string>();
  const [data, setData] = useState<Browse | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    alpd.request<Browse>('project.browse', where ? { path: where } : {}).then(result => { setData(result); setTyped(result.path); setError(''); }, cause => setError(cause.message));
  }, [alpd, where]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    addEventListener('keydown', escape);
    return () => removeEventListener('keydown', escape);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={event => event.stopPropagation()}>
        <header><strong>Open a project</strong><button className="icon-button" onClick={onClose}><Icon name="x" /></button></header>
        <div className="path-bar">
          <input value={typed} spellCheck={false} onChange={event => setTyped(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') setWhere(typed.trim()); }} />
          <button onClick={() => setWhere(typed.trim())}>Go</button>
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="folders">
          {data?.parent && <button className="folder" onClick={() => setWhere(data.parent!)}><Icon name="chevron-up" /> ..</button>}
          {data?.directories.map(entry => (
            <button key={entry.name} className="folder" onDoubleClick={() => onChoose(`${data.path}/${entry.name}`.replace(/\/+/g, '/'))} onClick={() => setWhere(`${data.path}/${entry.name}`.replace(/\/+/g, '/'))}>
              <Icon name="folder" /> {entry.name}{entry.project && <span className="badge">ALP</span>}
            </button>
          ))}
        </div>
        <footer>
          <span className="muted small">{data?.project ? 'An ALP project.' : 'ALP sets this folder up as a project on the first session.'}</span>
          <button className="primary" disabled={!data} onClick={() => data && onChoose(data.path)}>Open {data ? projectName(data.path) : ''}</button>
        </footer>
      </div>
    </div>
  );
}

export function NewSession({ project, onStarted }: { project: string; onStarted(): void }) {
  const alpd = useAlpd();
  const [preview, setPreview] = useState<SessionPreview | null>(null);
  const [team, setTeam] = useState<string>();
  const [mode, setMode] = useState<string>();
  const [error, setError] = useState('');
  useEffect(() => {
    alpd.request<{ preview: SessionPreview }>('session.preview', { spec: { cwd: project, ...(team ? { workflow: team } : {}) } })
      .then(result => { setPreview(result.preview); setError(''); }, cause => setError(cause.message));
  }, [alpd, project, team]);

  async function start(text: string) {
    const sessionId = `web-${crypto.randomUUID()}`;
    await alpd.request('session.create', { sessionId, spec: { cwd: project, persist: true, workflow: preview?.team ?? team, mode: mode ?? preview?.mode } });
    await alpd.request('session.prompt', { sessionId, clientMessageId: crypto.randomUUID(), delivery: 'auto', content: [{ type: 'text', text }] });
    rememberProject(project);
    onStarted();
    go({ screen: 'session', id: sessionId });
  }

  const chosen = preview?.teams.find(entry => entry.id === (team ?? preview.team));
  return (
    <div className="new-session">
      <div className="new-inner">
        <h1>New session</h1>
        <p className="muted" title={project}><Icon name="folder" /> {project}</p>
        {error && <p className="error-text">{error}</p>}
        {chosen?.description && <p className="muted small">{chosen.description}</p>}
        {preview && <p className="muted small">Its {preview.agent} runs on {preview.runtime}:{preview.model}, {preview.thinking} effort.</p>}
        <Composer placeholder="What should the team do?" disabled={!preview} onSend={start}>
          <select value={team ?? preview?.team ?? ''} title="Team" onChange={event => setTeam(event.target.value)}>
            {(preview?.teams ?? []).map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
          <select value={mode ?? preview?.mode ?? ''} title="Permissions" onChange={event => setMode(event.target.value)}>
            {MODES.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </Composer>
      </div>
    </div>
  );
}
