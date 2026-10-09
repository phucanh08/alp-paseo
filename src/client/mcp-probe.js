import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const PROTOCOL = '2025-06-18';
const client = { name: 'alp', version: '1' };

/**
 * Starts an MCP server once and lists its tools (ALPD §43), for the Test button and
 * `alp mcp test`. `server` is a normalized definition: { command, args, env, cwd } for
 * stdio, or { url, headers } for HTTP. The server is stopped afterwards.
 * @returns {Promise<{ server?: { name?: string, version?: string }, tools: Array<{ name: string, description?: string }> }>}
 */
export async function probeMcp(server, { cwd, timeoutMs = 15_000 } = {}) {
  const session = server.url ? await httpSession(server, timeoutMs) : stdioSession(server, cwd, timeoutMs);
  try {
    const init = await session.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: client });
    await session.notify('notifications/initialized');
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await session.request('tools/list', cursor ? { cursor } : {});
      for (const tool of result.tools ?? []) tools.push({ name: tool.name, ...(tool.description ? { description: tool.description } : {}) });
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return { ...(init.serverInfo ? { server: { name: init.serverInfo.name, version: init.serverInfo.version } } : {}), tools };
  } finally {
    await session.close();
  }
}

function stdioSession(server, cwd, timeoutMs) {
  const child = spawn(server.command, server.args ?? [], { cwd: server.cwd ?? cwd, env: { ...process.env, ...(server.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk; });
  const pending = new Map();
  let exited;
  const failAll = error => { for (const { reject } of pending.values()) reject(error); pending.clear(); };
  child.on('error', error => { exited = error; failAll(error); });
  child.on('exit', code => {
    exited = new Error(`${server.command} exited (${code ?? 'signal'})${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`);
    failAll(exited);
  });
  createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(`${message.error.message ?? 'MCP error'} (${message.error.code})`));
    else waiting.resolve(message.result ?? {});
  });
  child.stdin.on('error', () => {});
  let id = 0;
  return {
    request(method, params) {
      if (exited) return Promise.reject(exited);
      const current = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(current); reject(new Error(`${method} got no answer within ${timeoutMs / 1000} s`)); }, timeoutMs);
        pending.set(current, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n');
      });
    },
    async notify(method) { if (!exited) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const done = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end();
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await done;
      clearTimeout(timer);
    },
  };
}

async function httpSession(server, timeoutMs) {
  let sessionId;
  let id = 0;
  const post = async body => {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { ...(server.headers ?? {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sessionId ? { 'mcp-session-id': sessionId } : {}), 'mcp-protocol-version': PROTOCOL },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    sessionId = response.headers.get('mcp-session-id') ?? sessionId;
    if (!response.ok) throw new Error(`${server.url} answered ${response.status} ${response.statusText}`);
    return response;
  };
  return {
    async request(method, params) {
      const current = ++id;
      const response = await post({ jsonrpc: '2.0', id: current, method, params });
      const text = await response.text();
      // A streamable HTTP server answers with JSON or with server-sent events.
      const messages = (response.headers.get('content-type') ?? '').includes('text/event-stream')
        ? text.split('\n').filter(line => line.startsWith('data:')).map(line => { try { return JSON.parse(line.slice(5)); } catch { return undefined; } })
        : [JSON.parse(text)];
      const message = messages.find(entry => entry?.id === current);
      if (!message) throw new Error(`${method}: no answer in the response`);
      if (message.error) throw new Error(`${message.error.message ?? 'MCP error'} (${message.error.code})`);
      return message.result ?? {};
    },
    async notify(method) { await post({ jsonrpc: '2.0', method }); },
    async close() {
      if (sessionId) await fetch(server.url, { method: 'DELETE', headers: { ...(server.headers ?? {}), 'mcp-session-id': sessionId }, signal: AbortSignal.timeout(timeoutMs) }).catch(() => {});
    },
  };
}
