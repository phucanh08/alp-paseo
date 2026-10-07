import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

/** Small stdio JSON-RPC transport for the selected runtime; never a shell command. */
export class CodexTransport {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(method: string, params: any) => void>();
  private failures = new Set<(error: Error) => void>();
  private closed = false;
  private requestHandler?: (method: string, params: any) => Promise<unknown>;
  private exit: Promise<void>;

  constructor(command: string, cwd: string, env: NodeJS.ProcessEnv, args = ['app-server', '--listen', 'stdio://']) {
    if (/\.(cmd|bat|ps1)$/i.test(command)) throw new Error('Codex executable must be a native binary, not a shell launcher');
    this.child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exit = new Promise(resolve => { this.child.once('close', resolve); this.child.once('error', () => resolve()); });
    // Drain diagnostics without writing credentials or user configuration to the host log.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('close', code => { if (!this.closed) this.fail(new Error(`Codex app-server exited (${code})`)); });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      if (line.length > 16 * 1024 * 1024) { this.fail(new Error('Codex frame exceeds size limit')); return; }
      try {
        const message = JSON.parse(line);
        if (message.method && message.id !== undefined) {
          if (message.method === 'item/tool/call' && this.requestHandler) {
            void Promise.resolve().then(() => this.requestHandler!(message.method, message.params)).then(
              result => { if (!this.closed) this.write({ id: message.id, result }); },
              error => { if (!this.closed) this.write({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); },
            ).catch(error => this.fail(error));
          } else {
            // Delegation does not grant approval for unrelated interactive requests.
            this.write({ id: message.id, error: { code: -32601, message: 'Unsupported runtime request' } });
          }
        } else if (message.id !== undefined) {
          const waiter = this.pending.get(message.id);
          if (waiter) {
            this.pending.delete(message.id); clearTimeout(waiter.timer);
            if (message.error) waiter.reject(new Error(message.error.message ?? 'Runtime request failed'));
            else waiter.resolve(message.result);
          }
        } else if (message.method) {
          for (const listener of this.listeners) listener(message.method, message.params);
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  private write(value: unknown) {
    if (this.closed) throw new Error('Runtime is closed');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  private fail(error: Error) {
    if (this.closed) return;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    for (const listener of this.failures) listener(error);
    void this.close();
  }
  request(method: string, params: unknown, timeout = 30_000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Runtime is closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new Error(`Runtime request timed out: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'alp_paseo', title: 'ALP Paseo', version: '0.0.0' }, capabilities: { experimentalApi: true } });
    this.write({ method: 'initialized' });
  }
  onNotification(listener: (method: string, params: any) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onFailure(listener: (error: Error) => void) { this.failures.add(listener); return () => this.failures.delete(listener); }
  onRequest(handler: (method: string, params: any) => Promise<unknown>) { this.requestHandler = handler; }
  async close() {
    if (this.closed) return this.exit;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Runtime closed')); }
    this.pending.clear(); this.listeners.clear(); this.failures.clear();
    this.child.stdin.end();
    const timer = setTimeout(() => {
      if (process.platform === 'win32' && this.child.pid) execFile('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else this.child.kill('SIGKILL');
    }, 1500);
    let deadline: NodeJS.Timeout | undefined;
    try { await Promise.race([this.exit, new Promise<void>(resolve => { deadline = setTimeout(resolve, 4000); })]); }
    finally { clearTimeout(timer); clearTimeout(deadline); }
  }
}
