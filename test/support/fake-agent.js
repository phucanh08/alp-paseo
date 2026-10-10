// Scripted native agents for runtime tests (ALPD §39). A test drives each agent by
// hand: it calls ALP tools, reports usage, finishes, stalls, crashes or hits a
// usage limit, as Codex and Claude do through their transports.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../../src/core/init.js';
import { createAlpRuntime } from '../../dist/runtime/index.js';

let calls = 0;

/** A transport factory for createAlpRuntime; every agent it starts is pushed to `agents`. */
export function fakeTransport(agents) {
  return () => {
    const index = agents.length;
    let turns = 0;
    const agent = {
      calls: [], threadId: `thread-${index}`, turnId: undefined, closed: false,
      async initialize() {},
      /** What it says of its catalog and usage; set `limits` to a usage report (ALPD §58). */
      async orchestrationContext() { return this.limits ? { runtime: 'codex', usage: this.limits } : { available: false }; },
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        // A resumed thread keeps its id, as after a restart or recovery.
        if (method === 'thread/resume') { this.threadId = params.threadId; return { thread: { id: params.threadId } }; }
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      /** The turns ALP started, and what it steered into running ones. */
      get started() { return this.calls.filter(call => call.method === 'turn/start'); },
      get steered() { return this.calls.filter(call => call.method === 'turn/steer').map(call => call.params.input[0].text); },
      get config() { return this.calls.find(call => call.method === 'thread/start')?.params; },
      /** Calls an ALP tool and returns its parsed answer. */
      async call(tool, args) {
        return JSON.parse((await this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId: `${tool}-${index}-${++calls}`, namespace: null, tool, arguments: args })).contentItems[0].text);
      },
      /** Ends the running turn with a final message. */
      finish(text = 'done') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `out-${index}-${++calls}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
      /** Files a handoff after `ms`, then finishes: an agent slow to report. */
      async slowHandoff(ms, handoff, text = 'done') {
        await new Promise(resolve => setTimeout(resolve, ms));
        await this.call('alp_handoff', handoff);
        this.finish(text);
      },
      /** Reports how full its context is, and where its runtime compacts it when it says. */
      usage(totalTokens, modelContextWindow = 100_000, autoCompactTokens) {
        this.notification('thread/tokenUsage/updated', { threadId: this.threadId, turnId: this.turnId, tokenUsage: { last: { totalTokens }, total: { totalTokens }, modelContextWindow, ...(autoCompactTokens ? { autoCompactTokens } : {}) } });
      },
      /** Compacts its context, as Codex reports it: a contextCompaction item from start to end. */
      compact(preTokens, postTokens, { failed = false } = {}) {
        const item = { type: 'contextCompaction', id: `compact-${index}-${++calls}` };
        this.notification('item/started', { threadId: this.threadId, turnId: this.turnId, item });
        this.notification('item/completed', { threadId: this.threadId, turnId: this.turnId, item: { ...item, ...(failed ? { status: 'failed', error: 'summary failed' } : { status: 'completed', trigger: 'auto', preTokens, postTokens }) } });
      },
      /** Fails the running turn on a used-up Codex window. */
      limit(resetsAt = Math.floor(Date.now() / 1000) + 3600) {
        this.notification('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt }, secondary: null } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'failed', error: { message: 'You have hit your usage limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } } });
      },
      /** The native process dies mid-turn. */
      crash(message = 'app-server exited with code 1') {
        this.failure(new Error(message));
      },
    };
    agents.push(agent);
    return agent;
  };
}

/** Waits up to 3 s for `check` to hold. */
export async function until(check, what = 'condition') {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`Expected ${what} did not arrive`);
}

/**
 * A project with a root session `root` that has started a turn. Returns the runtime,
 * its agents (main first), and the run log reader.
 */
export async function tree(t, { prefix = 'alp-fake-', open = {}, options = () => ({}) } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  const root = path.join(directory, 'project');
  await initProject(root);
  const runs = path.join(directory, 'runs');
  const agents = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(agents), supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: runs, ...options(directory) });
  t.after(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await runtime.open('root', { cwd: root, ...open });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
  const runLog = async (rootId = 'root') => (await readFile(path.join(runs, `${rootId}.jsonl`), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, root, runs, runtime, agents, main: agents[0], runLog };
}
