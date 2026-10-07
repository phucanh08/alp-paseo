import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveDelegation } from '../src/core/delegation.js';

async function fixture(t, delegation) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-delegation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.alp'));
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ delegation }));
  return root;
}
test('delegation defaults to disabled and supports user-defined names', async t => {
  assert.deepEqual(await resolveDelegation(await fixture(t)), {});
  const graph = { coordinator: ['builder'], builder: ['auditor'] };
  assert.deepEqual(await resolveDelegation(await fixture(t, graph)), graph);
});
for (const graph of [[], 'lead', { main: 'lead' }, { main: ['../peer'] }, { main: ['lead', 'lead'] }, { main: ['main'] }, { main: ['lead'], lead: ['main'] }]) {
  test(`invalid delegation graph is rejected: ${JSON.stringify(graph)}`, async t => {
    await assert.rejects(resolveDelegation(await fixture(t, graph)), { code: 'INVALID_DELEGATION' });
  });
}
