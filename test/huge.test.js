// A recipient with 20,000 coins (the largest mainnet recipient we found had 18,881) through a synthetic RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { blameRecipient, clearRentCache, decodeBase58, constants } from '../src/index.js';
import { encodeSharingConfig, encodeSocialFeePda, fakeKey, b64 } from './helpers/synth.js';

function syntheticRpc({ recipient, coins }) {
  const configs = new Map();
  for (let i = 0; i < coins; i++) {
    const slot = i % 7 === 0 ? 1 : 0;
    const holders = slot === 1 ? [[fakeKey(`co${i}`), 3000], [recipient, 7000]] : [[recipient, 10000]];
    configs.set(fakeKey(`cfg${i}`), { slot, bytes: encodeSharingConfig({ mint: fakeKey(`mint${i}`), admin: fakeKey('admin'), adminRevoked: i % 3 !== 0, shareholders: holders }) });
  }
  const stats = { calls: 0, credits: 0 };
  const vaultLamports = (k) => 650240 + (decodeBase58(k)[0] * 1e6);
  return {
    stats,
    async getProgramAccounts(program, cfg) {
      stats.calls++;
      const off = cfg.filters[1].memcmp.offset;
      assert.equal(cfg.dataSlice.length, 0, 'probes must ask for pubkeys only');
      const slot = (off - 80) / 34;
      return [...configs].filter(([, c]) => c.slot === slot).map(([pubkey]) => ({ pubkey, account: { data: ['', 'base64'], lamports: 0 } }));
    },
    async getAccountInfo() { stats.calls++; return { lamports: 1559560 + 7e9, owner: constants.PUMP_FEES, data: b64(encodeSocialFeePda({ userId: '322216527', totalClaimed: 2e13, lastClaimed: 1790340245 })) }; },
    async getMinimumBalanceForRentExemption(n) { stats.calls++; return n === 0 ? 650240 : 1559560; },
    async getMultipleAccounts(keys, { dataSlice }) {
      stats.calls += Math.ceil(keys.length / 100);
      if (dataSlice.offset === 0) return keys.map((k) => ({ owner: constants.PUMP_FEES, lamports: 5852160, data: b64(configs.get(k).bytes.subarray(0, 420)) }));
      return keys.map((k, i) => (i % 2 === 0 ? { lamports: vaultLamports(k), data: ['', 'base64'] } : null));
    },
    async getAssetBatch(ids) { stats.calls++; return ids.map((id) => ({ id, content: { metadata: { name: 'Synthetic', symbol: 'SYN' } } })); },
  };
}

test('20,000 coins: exact count, only `limit` decoded, deterministic subset, sorted', async () => {
  clearRentCache();
  const recipient = 'FfLpuH4WPn2MR8Lqn1MpwQc1HtAPPqL3qvMWZjnFHGpv';
  const rpc = syntheticRpc({ recipient, coins: 20000 });
  const r = await blameRecipient({ kind: 'address', address: recipient, account: await rpc.getAccountInfo() }, { rpc, limit: 250 });
  assert.equal(r.totals.coins, 20000);
  assert.equal(r.totals.listed, 250);
  assert.equal(r.totals.truncated, true);
  assert.equal(r.recipient.type, 'github');
  assert.equal(r.account.unclaimedLamports, 7e9);
  assert.equal(r.account.receivedLamports, 2e13 + 7e9);
  const allSorted = [...Array(20000).keys()].map((i) => fakeKey(`cfg${i}`)).sort().slice(0, 250);
  assert.deepEqual(r.coins.map((c) => c.sharingConfig).sort(), allSorted);
  for (let i = 1; i < r.coins.length; i++) {
    const a = r.coins[i - 1], b = r.coins[i];
    assert.ok(a.pendingForRecipientLamports > b.pendingForRecipientLamports || (a.pendingForRecipientLamports === b.pendingForRecipientLamports && a.mint <= b.mint));
  }
  const second = r.coins.find((c) => c.slot === 1);
  assert.equal(second.bps, 7000);
  assert.deepEqual(second.coRecipients.map((c) => c.bps), [3000]);
  assert.equal(r.blame[1].includes('(truncated)'), true);
  assert.ok(r.meta.rpcCalls < 25, `rpc calls ${r.meta.rpcCalls}`);
});

test('limit is clamped to 1..250', async () => {
  clearRentCache();
  const recipient = fakeKey('r');
  const rpc = syntheticRpc({ recipient, coins: 300 });
  const acct = null;
  const big = await blameRecipient({ kind: 'address', address: recipient, account: acct }, { rpc, limit: 10_000 });
  assert.equal(big.totals.listed, 250);
  const one = await blameRecipient({ kind: 'address', address: recipient, account: acct }, { rpc, limit: 0 });
  assert.equal(one.totals.listed, 100); // 0 / NaN falls back to the default
  const neg = await blameRecipient({ kind: 'address', address: recipient, account: acct }, { rpc, limit: -5 });
  assert.equal(neg.totals.listed, 1);
});
