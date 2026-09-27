import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateLedger, applyLogins, maskLedger, ledgerRowId, buildLedger, accountData, clearRentCache, LOGIN_MASK, decodeSocialFeePda, formatLedger } from '../src/index.js';
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

// The straightforward form aggregateLedger had before it read the fields in place and kept its top lists
// incrementally: decodeSocialFeePda every account, then sort every GitHub row three times. Same output expected.
function aggregateBySort(list, { rentExemptLamports, snapshotAt, top = 25, topClaimed = 10, recent = 15 }) {
  const counts = { total: 0, github: 0, x: 0, pump: 0, other: 0 };
  const github = { accounts: 0, everClaimed: 0, neverClaimed: 0, neverClaimedOver1Sol: 0, unclaimedLamports: 0, unclaimedNeverClaimedLamports: 0, totalClaimedLamports: 0 };
  const x = { accounts: 0, unclaimedLamports: 0, totalClaimedLamports: 0 };
  const gh = [];
  let skipped = 0;
  for (const a of list) {
    let d;
    try { d = decodeSocialFeePda(a.data); } catch { skipped++; continue; }
    counts.total++;
    const unclaimed = Math.max(0, a.lamports - rentExemptLamports);
    if (d.platform === 2) {
      counts.github++; github.accounts++; github.unclaimedLamports += unclaimed; github.totalClaimedLamports += d.totalClaimed;
      if (d.lastClaimed > 0 || d.totalClaimed > 0) github.everClaimed++;
      else { github.neverClaimed++; github.unclaimedNeverClaimedLamports += unclaimed; if (unclaimed > 1e9) github.neverClaimedOver1Sol++; }
      gh.push({ pubkey: a.pubkey, userId: d.userId, unclaimed, totalClaimed: d.totalClaimed, lastClaimed: d.lastClaimed });
    } else if (d.platform === 1) { counts.x++; x.accounts++; x.unclaimedLamports += unclaimed; x.totalClaimedLamports += d.totalClaimed; } else if (d.platform === 0) counts.pump++; else counts.other++;
  }
  const byPubkey = (a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0);
  const row = (r) => ({ githubId: r.userId, login: null, accountType: null, githubDeleted: false, socialFeePda: r.pubkey, unclaimedLamports: r.unclaimed, totalClaimedLamports: r.totalClaimed, lastClaimedAt: r.lastClaimed > 0 ? new Date(r.lastClaimed * 1000).toISOString() : null });
  const topN = (key, n, filter = () => true) => gh.filter(filter).sort((a, b) => b[key] - a[key] || byPubkey(a, b)).slice(0, n).map(row);
  const l = { snapshotAt, source: 'getProgramAccounts pump_fees SocialFeePda', rentExemptLamports, accounts: counts, github, x, topUnclaimed: topN('unclaimed', top), topClaimed: topN('totalClaimed', topClaimed), recentClaims: topN('lastClaimed', recent, (r) => r.lastClaimed > 0), blame: [] };
  if (skipped) l.skippedUndecodable = skipped;
  l.blame = formatLedger(l);
  return l;
}

test('aggregateLedger equals the decode-then-sort form: recorded snapshot, any slice of it, and edge accounts', () => {
  const opts = { rentExemptLamports: fx.rentExemptLamports, snapshotAt: fx.recordedAt };
  assert.deepEqual(aggregateLedger(accounts, opts), aggregateBySort(accounts, opts));
  for (const [s, e] of [[0, 2500], [2500, 5000], [5000, 7500], [7500, accounts.length], [100, 137]]) assert.deepEqual(aggregateLedger(accounts.slice(s, e), opts), aggregateBySort(accounts.slice(s, e), opts));
  for (const n of [0, 1, 3]) assert.deepEqual(aggregateLedger(accounts, { ...opts, top: n, topClaimed: n, recent: n }), aggregateBySort(accounts, { ...opts, top: n, topClaimed: n, recent: n }));
  // ties on every key (the pubkey decides), text and 20-char ids, u64s at and past 2^53, and what must be skipped
  const acc = (seed, data, lamports = 5e9) => ({ pubkey: fakeKey(seed), lamports, data });
  const long = encodeSocialFeePda({ userId: 'x'.repeat(21) });
  const truncated = encodeSocialFeePda({ userId: '9000000001' }).subarray(0, 30);
  const wrongDisc = encodeSocialFeePda({ userId: '9000000002' }); wrongDisc[0] ^= 1;
  const edge = [
    ...Array.from({ length: 30 }, (_, i) => acc(`tie${i}`, encodeSocialFeePda({ userId: String(9000000100 + i), totalClaimed: 7e9, lastClaimed: 1790000000 }))),
    acc('text', encodeSocialFeePda({ userId: 'sample handle ~07' })),
    acc('twenty', encodeSocialFeePda({ userId: '90000000000000000001', totalClaimed: 2 ** 53 - 1 })),
    acc('big', encodeSocialFeePda({ userId: '9000000200', totalClaimed: 2n ** 60n + 12345n, lastClaimed: 1790000001 })),
    acc('big2', encodeSocialFeePda({ userId: '9000000201', totalClaimed: 2n ** 53n + 1n })),
    acc('x', encodeSocialFeePda({ userId: '9000000300', platform: 1, totalClaimed: 5 })),
    acc('pump', encodeSocialFeePda({ userId: '9000000400', platform: 0 })),
    acc('other', encodeSocialFeePda({ userId: '9000000500', platform: 6 })),
    acc('long', long), acc('trunc', truncated), acc('disc', wrongDisc), acc('short', new Uint8Array(12)), acc('empty', new Uint8Array(0)),
  ];
  const l = aggregateLedger(edge, opts);
  assert.deepEqual(l, aggregateBySort(edge, opts));
  assert.equal(l.skippedUndecodable, 5);
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
    { pubkey: fakeKey(1), lamports: 1559560 + 5e9, data: encodeSocialFeePda({ userId: '9000900007', platform: 2 }) },
    { pubkey: fakeKey(2), lamports: 1559560, data: encodeSocialFeePda({ userId: '9000900008', platform: 6 }) },
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
    account: { lamports: 1559560 + i * 1e9, data: [Buffer.from(encodeSocialFeePda({ userId: String(9000901000 + i) })).toString('base64'), 'base64'] },
  }));
  const cache = { get: async (k) => (/^gh\/id\/900090100\d$/.test(k) ? { at: Date.now(), value: { id: k.slice(6), login: `synthetic-${k.slice(6)}`, type: 'User', deleted: false } } : null), set: async () => {} };
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
  assert.equal(open.topUnclaimed[0].login, 'synthetic-9000901003');
  assert.ok(open.blame[2].startsWith(`${list[2].pubkey.slice(0, 8)} (github:synthetic-9000901003`));
  assert.doesNotMatch(open.blame[0], /logins=masked/);
});
