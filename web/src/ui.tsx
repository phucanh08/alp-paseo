import type { SessionSummary } from './types';

/** Small pieces the screens share: icons, times, names. */

const PATHS: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-up': 'M6 15l6-6 6 6',
  pause: 'M8 5v14M16 5v14',
  stop: 'M7 7h10v10H7z',
  send: 'M12 19V5M5 12l7-7 7 7',
  terminal: 'M4 17l6-5-6-5M12 19h8',
  file: 'M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9l-6-6zM14 3v6h6',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-5-5',
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  users: 'M16 19v-1a4 4 0 00-4-4H6a4 4 0 00-4 4v1M9 10a3 3 0 100-6 3 3 0 000 6zM22 19v-1a4 4 0 00-3-3.9M16 4.1a3 3 0 010 5.8',
  check: 'M5 12l5 5L20 7',
  alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  mail: 'M4 6h16v12H4zM4 6l8 7 8-7',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  diff: 'M12 3v18M5 8h4M7 6v4M15 16h4',
  tool: 'M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6z',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 5v6h-6',
  question: 'M9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01M12 21a9 9 0 100-18 9 9 0 000 18z',
  up: 'M12 19V5M5 12l7-7 7 7',
  brain: 'M12 5a3 3 0 00-5.6 1.5A3 3 0 004 11a3 3 0 001 5 3 3 0 005 2.5V5zM12 5a3 3 0 015.6 1.5A3 3 0 0120 11a3 3 0 01-1 5 3 3 0 01-5 2.5',
};

export function Icon({ name, size = 15 }: { name: string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.tool} />
    </svg>
  );
}

export function ago(iso: string) {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export const projectName = (project: string) => project.split('/').filter(Boolean).pop() ?? project;

export function statusOf(session: Pick<SessionSummary, 'status' | 'busy'>) {
  if (session.status === 'error') return 'error';
  if (session.status === 'running' || (session.status === 'idle' && session.busy)) return 'running';
  if (session.status === 'idle') return 'idle';
  return 'closed';
}

export const MODES = [
  { id: 'read-only', label: 'Read only' },
  { id: 'workspace-write', label: 'Workspace write' },
  { id: 'full-access', label: 'Full access' },
];

export const tokens = (count?: number) => count === undefined ? '' : count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
