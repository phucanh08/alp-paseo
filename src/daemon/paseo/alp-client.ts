import { PROTOCOL_VERSION } from '../../client/index.js';
import type { Envelope } from '../../runtime/index.js';
import type { DaemonServer } from '../server.js';

/**
 * The bridge's own connection to alpd, in this process: the same JSON-RPC the CLI and the
 * Paseo plugin speak, so the web app sees what every other viewer sees (ALPD §62).
 */
export type AlpClient = {
  request<T = any>(method: string, params?: object): Promise<T>;
  close(): void;
};

export async function connectInProcess(daemon: DaemonServer, onEvent: (envelope: Envelope) => void): Promise<AlpClient> {
  let next = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const connection = daemon.accept(message => {
    const frame = message as { id?: number; method?: string; params?: Envelope; result?: unknown; error?: { code: number; message: string } };
    if (frame.method === 'event' && frame.params) { onEvent(frame.params); return; }
    if (typeof frame.id !== 'number') return;
    const waiting = pending.get(frame.id);
    if (!waiting) return;
    pending.delete(frame.id);
    if (frame.error) waiting.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code }));
    else waiting.resolve(frame.result);
  });
  const client: AlpClient = {
    request(method, params = {}) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        connection.receive({ jsonrpc: '2.0', id, method, params });
      });
    },
    close() {
      connection.close();
      for (const waiting of pending.values()) waiting.reject(new Error('alpd connection closed'));
      pending.clear();
    },
  };
  await client.request('daemon.hello', { protocolVersion: PROTOCOL_VERSION, client: { name: 'alp-web', version: '1' } });
  return client;
}
