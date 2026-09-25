import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateLedger, applyLogins, maskLedger, ledgerRowId, buildLedger, accountData, clearRentCache, LOGIN_MASK } from '../src/index.js';
import { readGz } from './helpers/transcript.js';
import { encodeSocialFeePda, fakeKey } from './helpers/synth.js';

const fx = readGz(new URL('./fixtures/ledger-socialfeepda.json.gz', import.meta.url));
const accounts = fx.accounts.map(([pubkey, lamports, b64]) => ({ pubkey, lamports, data: accountData(b64) }));

test('ledger over the recorded mainnet snapshot: counts add up, rankings are ordered', () => {
  const l = aggregateLedger(accounts, { rentExemptLamports: fx.rentExemptLamports, snapshotAt: fx.recordedAt });
  assert.equal(l.accounts.total, accounts.length);
  assert.equal(l.accounts.github + l.accounts.x + l.accounts.pump + l.accounts.other, l.accounts.total);
  assert.equal(l.github.everClaimed + l.github.neverClaimed, l.github.accounts);
  assert.ok(l.github.accounts > 11000);
  assert.ok(l.github.unclaimedNeverClaimedLamports <= l.github.unclaimedLamports);
  assert.equal(l.topUnclaimed.length, 25);
  assert.equal(l.topClaimed.length, 10);
  assert.equal(l.recentClaims.length, 15);
  const desc = (arr, k) => arr.every((r, i) => i === 0 || arr[i - 1][k] >= r[k]);
  assert.ok(desc(l.topUnclaimed, 'unclaimedLamports'));
  assert.ok(desc(l.topClaimed, 'totalClaimedLamports'));
  assert.ok(l.recentClaims.every((r, i) => r.lastClaimedAt && (i === 0 || l.recentClaims[i - 1].lastClaimedAt >= r.lastClaimedAt)));
  assert.equal(l.blame.length, 27);
  assert.match(l.blame[0], /^# payblame --ledger \d{4}-\d\d-\d\dT\d\d:\d\dZ github-recipients=\d+$/);
});

test('applyLogins fills rows from the recorded GitHub lookups and reformats', () => {
  const l = aggregateLedger(accounts, { rentExemptLamports: fx.rentExemptLamports, snapshotAt: fx.recordedAt });
  applyLogins(l, new Map(Object.entries(fx.logins)));
  const resolved = l.topUnclaimed.filter((r) => r.login);
  assert.ok(resolved.length > 0);
  assert.ok(l.blame.some((line) => line.includes(`github:${resolved[0].login}`)));
});

test('ledger edge cases: empty, undecodable and unknown platforms', () => {
  const empty = aggregateLedger([], { rentExemptLamports: 1559560, snapshotAt: '2026-09-25T00:00:00.000Z' });
  assert.equal(empty.accounts.total, 0);
  assert.deepEqual(empty.topUnclaimed, []);
  assert.equal(empty.blame.length, 2);
  const mixed = aggregateLedger([
    { pubkey: fakeKey(1), lamports: 1559560 + 5e9, data: encodeSocialFeePda({ userId: '7', platform: 2 }) },
    { pubkey: fakeKey(2), lamports: 1559560, data: encodeSocialFeePda({ userId: '8', platform: 6 }) },
    { pubkey: fakeKey(3), lamports: 100, data: new Uint8Array(10) },
  ], { rentExemptLamports: 1559560 });
  assert.equal(mixed.accounts.github, 1);
  assert.equal(mixed.accounts.other, 1);
  assert.equal(mixed.skippedUndecodable, 1);
  assert.equal(mixed.github.neverClaimedOver1Sol, 1);
  assert.equal(mixed.github.unclaimedLamports, 5e9);
});

const rowsOf = (l) => [...l.topUnclaimed, ...l.topClaimed, ...l.recentClaims];

test('maskLedger: no login, id or PDA survives; numbers, types and totals do; ids are stable per secret', () => {
  const full = applyLogins(aggregateLedger(accounts, { rentExemptLamports: fx.rentExemptLamports, snapshotAt: fx.recordedAt }), new Map(Object.entries(fx.logins)));
  const realLogins = rowsOf(full).map((r) => r.login).filter(Boolean);
  assert.ok(realLogins.length > 10);
  const m = maskLedger(full, { secret: 'test-secret' });
  assert.equal(m.logins, 'masked');
  assert.match(m.loginsNote, /masked/);
  assert.deepEqual(m.github, full.github);
  assert.equal(m.blame.length, full.blame.length);
  assert.match(m.blame[0], / logins=masked$/);
  const text = JSON.stringify(m);
  for (const login of realLogins) assert.ok(!text.includes(`"${login}"`) && !m.blame.some((l) => l.includes(`github:${login} `)), login);
  for (const r of rowsOf(full)) assert.ok(!text.includes(r.socialFeePda) && !text.includes(`"${r.githubId}"`));
  rowsOf(m).forEach((r, i) => {
    const src = rowsOf(full)[i];
    assert.equal(r.masked, true);
    assert.equal(r.login, LOGIN_MASK);
    assert.equal(r.githubId, null);
    assert.equal(r.socialFeePda, null);
    assert.match(r.rowId, /^row:[0-9a-f]{8}$/);
    assert.equal(r.rowId, ledgerRowId(src.socialFeePda, 'test-secret'));
    assert.equal(r.unclaimedLamports, src.unclaimedLamports);
    assert.equal(r.accountType, src.accountType);
  });
  for (const line of m.blame.slice(2)) assert.match(line, /^row:[0-9a-f]{8} \(github:#{4} {17} (user|org |\? {3})\) unclaimed=\d+\.\d{3} +claimed=\d+\.\d{3} +last=(never|\d{4}-\d\d-\d\d)$/);
  // stable for one secret, different for another, idempotent, input untouched
  assert.deepEqual(maskLedger(full, { secret: 'test-secret' }).topUnclaimed, m.topUnclaimed);
  assert.notEqual(maskLedger(full, { secret: 'other' }).topUnclaimed[0].rowId, m.topUnclaimed[0].rowId);
  assert.deepEqual(maskLedger(m, { secret: 'other' }).topUnclaimed, m.topUnclaimed);
  assert.ok(full.topUnclaimed[0].socialFeePda && !full.topUnclaimed[0].masked, 'input not mutated');
});

function mockRpc(list) {
  const stats = { calls: 0, credits: 0 };
  return {
    stats,
    getProgramAccounts: async () => { stats.calls++; return list; },
    getMinimumBalanceForRentExemption: async () => { stats.calls++; return 1559560; },
  };
}

test('buildLedger masks by default; { reveal: true } is the only way to get logins', async () => {
  const list = [1, 2, 3].map((i) => ({
    pubkey: fakeKey(`gh${i}`),
    account: { lamports: 1559560 + i * 1e9, data: [Buffer.from(encodeSocialFeePda({ userId: String(1000 + i) })).toString('base64'), 'base64'] },
  }));
  const cache = { get: async (k) => (/^gh\/id\/100\d$/.test(k) ? { at: Date.now(), value: { id: k.slice(6), login: `synthetic-${k.slice(6)}`, type: 'User', deleted: false } } : null), set: async () => {} };
  const fetchNever = () => { throw new Error('no network in this test'); };
  clearRentCache();
  const masked = await buildLedger({ rpc: mockRpc(list), cache, fetch: fetchNever, maskSecret: 's' });
  assert.equal(masked.logins, 'masked');
  assert.ok(rowsOf(masked).every((r) => r.masked && r.login === LOGIN_MASK && r.githubId === null && r.socialFeePda === null));
  assert.ok(!JSON.stringify(masked).includes('synthetic-'));
  assert.equal(masked.stats.rpcCalls, 2);
  clearRentCache();
  const open = await buildLedger({ rpc: mockRpc(list), cache, fetch: fetchNever, reveal: true });
  assert.equal(open.logins, 'revealed');
  assert.equal(open.topUnclaimed[0].login, 'synthetic-1003');
  assert.ok(open.blame[2].startsWith(`${list[2].pubkey.slice(0, 8)} (github:synthetic-1003`));
  assert.doesNotMatch(open.blame[0], /logins=masked/);
});
