import { createContext, useContext } from 'react';
import type { Alpd } from './rpc';
import type { SessionSummary } from './types';

/** What every screen shares: the alpd connection, routes, and the projects opened here. */

export const AlpdContext = createContext<Alpd>(null!);
export const useAlpd = () => useContext(AlpdContext);

export type Route = { screen: 'home' } | { screen: 'history' } | { screen: 'session'; id: string } | { screen: 'new'; project: string };

export function parse(hash: string): Route {
  const session = /^#\/s\/([\w.:-]+)$/.exec(hash);
  if (session) return { screen: 'session', id: session[1] };
  const fresh = /^#\/new\?project=(.+)$/.exec(hash);
  if (fresh) return { screen: 'new', project: decodeURIComponent(fresh[1]) };
  if (hash === '#/history') return { screen: 'history' };
  return { screen: 'home' };
}

export const go = (route: Route) => {
  location.hash = route.screen === 'session' ? `#/s/${route.id}` : route.screen === 'new' ? `#/new?project=${encodeURIComponent(route.project)}` : route.screen === 'history' ? '#/history' : '#/';
};

const PROJECTS_KEY = 'alp.projects';
export const savedProjects = (): string[] => { try { return JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? '[]'); } catch { return []; } };

/** Projects the user opened here, beside those alpd has sessions for. */
export function rememberProject(project: string) {
  const projects = [project, ...savedProjects().filter(entry => entry !== project)].slice(0, 30);
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects)); } catch {}
}

export function forgetProject(project: string) {
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(savedProjects().filter(entry => entry !== project))); } catch {}
}

/** Roots the page attached, to attach again after alpd comes back. */
export const attached = new Set<string>();

export async function follow(alpd: Alpd, sessionId: string) {
  const { session } = await alpd.request('session.attach', { sessionId, replay: !attached.has(sessionId) });
  attached.add(session.id);
  return session as SessionSummary;
}

