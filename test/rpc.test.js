import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpc, PayblameError } from '../src/index.js';

test('rpc retries 429 with backoff, then succeeds and counts calls', async () => {
  let n = 0;
  const f = async () => (++n < 3 ? new Response('busy', { status: 429, headers: { 'retry-after': '0' } }) : Response.json({ jsonrpc: '2.0', id: 1, result: 650240 }));
  const rpc = createRpc({ rpcUrl: 'http://rpc.test', fetch: f });
  assert.equal(await rpc.getMinimumBalanceForRentExemption(0), 650240);
  assert.equal(n, 3);
  assert.equal(rpc.stats.calls, 1);
});

test('rpc maps timeouts, HTTP errors and JSON-RPC errors to UPSTREAM', async () => {
  const slow = createRpc({ rpcUrl: 'http://rpc.test', timeoutMs: 20, fetch: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))) });
  await assert.rejects(slow.getAccountInfo('x'), (e) => e instanceof PayblameError && e.code === 'UPSTREAM' && e.status === 502);
  const down = createRpc({ rpcUrl: 'http://rpc.test', retries: 0, fetch: async () => new Response('no', { status: 500 }) });
  await assert.rejects(down.getAccountInfo('x'), /HTTP 500/);
  const gpaOff = createRpc({ rpcUrl: 'http://rpc.test', fetch: async () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'getProgramAccounts is disabled' } }) });
  await assert.rejects(gpaOff.getProgramAccounts('p', {}), /disabled/);
  assert.throws(() => createRpc({}), /No RPC URL/);
});

test('getMultipleAccounts batches 100 keys per call and keeps order', async () => {
  const seen = [];
  const f = async (u, init) => { const b = JSON.parse(init.body); seen.push(b.params[0].length); return Response.json({ jsonrpc: '2.0', id: b.id, result: { value: b.params[0].map((k) => ({ lamports: Number(k) })) } }); };
  const rpc = createRpc({ rpcUrl: 'http://rpc.test', fetch: f });
  const keys = Array.from({ length: 250 }, (_, i) => String(i));
  const out = await rpc.getMultipleAccounts(keys);
  assert.deepEqual(seen, [100, 100, 50]);
  assert.deepEqual(out.map((a) => a.lamports), keys.map(Number));
});
