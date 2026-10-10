import type { Envelope } from './types';

/**
 * The page's connection to alpd (ALPD §61): alpd's JSON-RPC over a WebSocket on the
 * page's own origin. It says hello first, reconnects when alpd restarts, and tells the
 * app so it can attach its sessions again.
 */

const PROTOCOL_VERSION = 1;
const TOKEN_KEY = 'alp.token';

export type LinkState = 'connecting' | 'open' | 'closed' | 'unauthorized';

/** The token `alp web` put in the address, kept for later visits; the address loses it. */
export function takeToken() {
  const match = /(?:^|[#&])token=([a-f0-9]{64})/.exec(location.hash);
  if (match) {
    try { localStorage.setItem(TOKEN_KEY, match[1]); } catch {}
    history.replaceState(null, '', location.pathname + location.search);
    return match[1];
  }
  try { return localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

export class Alpd {
  private ws?: WebSocket;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  private events = new Set<(envelope: Envelope) => void>();
  private states = new Set<(state: LinkState) => void>();
  private opened = new Set<() => void>();
  private ready?: Promise<void>;
  private attempt = 0;
  state: LinkState = 'connecting';

  constructor(private token: string) {
    this.connect();
  }

  private set(state: LinkState) {
    this.state = state;
    for (const listener of this.states) listener(state);
  }

  private connect() {
    this.set('connecting');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${this.token}`);
    this.ws = ws;
    let hello: (() => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    this.ready = new Promise<void>((resolve, reject) => { hello = resolve; fail = reject; });
    this.ready.catch(() => {});
    let welcomed = false;
    ws.onopen = () => {
      this.send(ws, 'daemon.hello', { protocolVersion: PROTOCOL_VERSION, client: { name: 'alp-web', version: '1' }, capabilities: [] })
        .then(() => {
          welcomed = true;
          this.attempt = 0;
          hello!();
          this.set('open');
          for (const listener of this.opened) listener();
        })
        .catch(error => fail!(error));
    };
    ws.onmessage = message => {
      let data: any;
      try { data = JSON.parse(String(message.data)); } catch { return; }
      if (data.method === 'event') { for (const listener of this.events) listener(data.params); return; }
      const waiter = this.pending.get(data.id);
      if (!waiter) return;
      this.pending.delete(data.id);
      if (data.error) waiter.reject(Object.assign(new Error(data.error.message), { code: data.error.code }));
      else waiter.resolve(data.result);
    };
    ws.onclose = () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('alpd connection closed'));
      this.pending.clear();
      fail?.(new Error('alpd connection closed'));
      // Refused before hello: the token is wrong or missing; asking again will not help.
      if (!welcomed && this.attempt >= 2) { this.set('unauthorized'); return; }
      this.set('closed');
      const delay = Math.min(500 * 2 ** this.attempt++, 5000);
      setTimeout(() => this.connect(), delay);
    };
  }

  private send(ws: WebSocket, method: string, params: unknown) {
    const id = ++this.sequence;
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async request<T = any>(method: string, params: unknown = {}): Promise<T> {
    await this.ready;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('alpd is not connected');
    return this.send(this.ws, method, params);
  }

  onEvent(listener: (envelope: Envelope) => void) { this.events.add(listener); return () => { this.events.delete(listener); }; }
  onState(listener: (state: LinkState) => void) { this.states.add(listener); return () => { this.states.delete(listener); }; }
  /** Each time the connection is ready, the first time and after a reconnect. */
  onOpen(listener: () => void) { this.opened.add(listener); return () => { this.opened.delete(listener); }; }
}
