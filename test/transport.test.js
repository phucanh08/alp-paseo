import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexTransport } from '../plugins/paseo/server/dist/index.js';

test('transport closes pending requests if child exits', async t => {
  const transport = new CodexTransport(process.execPath, process.cwd(), {}, ['-e', 'setTimeout(() => process.exit(7), 20)']);
  t.after(() => transport.close());
  await assert.rejects(transport.request('initialize', {}, 2000), /exited/);
});
test('transport enforces bounded request timeout and shuts down', async t => {
  const transport = new CodexTransport(process.execPath, process.cwd(), {}, ['-e', 'process.stdin.resume()']);
  t.after(() => transport.close());
  await assert.rejects(transport.request('initialize', {}, 50), /timed out/);
  await assert.rejects(transport.request('model/list', {}), /closed/);
});
test('transport handles spawn error without hanging', async t => {
  const transport = new CodexTransport('alp-nonexistent-executable', process.cwd(), {});
  t.after(() => transport.close());
  await assert.rejects(transport.initialize(), /ENOENT/);
});

test('transport answers dynamic tool requests while rejecting approval requests', async t => {
  const script = `
    const readline = require('node:readline');
    let requestId;
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'probe') {
        requestId = m.id;
        console.log(JSON.stringify({id: 'tool', method: 'item/tool/call', params: {tool: 'alp_delegate'}}));
      } else if (m.id === 'tool') {
        console.log(JSON.stringify({id: 'approval', method: 'item/commandExecution/requestApproval', params: {}}));
      } else if (m.id === 'approval') {
        console.log(JSON.stringify({id: requestId, result: {approvalRejected: !!m.error}}));
      }
    });
  `;
  const transport = new CodexTransport(process.execPath, process.cwd(), {}, ['-e', script]);
  t.after(() => transport.close());
  let calls = 0;
  transport.onRequest(async (method, params) => {
    assert.equal(method, 'item/tool/call'); assert.equal(params.tool, 'alp_delegate'); calls++;
    return { success: true, contentItems: [{ type: 'inputText', text: 'real result' }] };
  });
  assert.deepEqual(await transport.request('probe', {}, 2000), { approvalRejected: true });
  assert.equal(calls, 1);
});

test('optional catalog/usage timeout does not close a healthy runtime', async t => {
  const script = `require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const m = JSON.parse(line);
    if (m.method === 'probe') console.log(JSON.stringify({ id: m.id, result: { alive: true } }));
  });`;
  const transport = new CodexTransport(process.execPath, process.cwd(), {}, ['-e', script]);
  t.after(() => transport.close());
  await assert.rejects(transport.request('account/rateLimits/read', {}, 50, false), /timed out/);
  assert.deepEqual(await transport.request('probe', {}, 2000), { alive: true });
});
