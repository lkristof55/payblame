// The free-plan ledger cron (lib/sweep.mjs): getProgramAccountsV2 pages over several runs must publish exactly
// the ledger one getProgramAccounts gives, masked, within the per-run fetch budget. Offline: the pages are cut
// from the recorded (scrubbed) SocialFeePda snapshot at the repo root; GitHub answers are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateLedger, accountData, createRpc, clearRentCache, decodeBase58, LOGIN_MASK } from '../../src/index.js';
import { readGz } from '../../test/helpers/transcript.js';
import { fakeD1 } from './helpers/fake-d1.mjs';
import { useD1, getStore } from '../lib/store.mjs';
import { sweepStep, mergePage, fetchPage, sweepProgress, SWEEP_KEY, RAW_KEY } from '../lib/sweep.mjs';
import { ledgerResponse, LEDGER_KEY } from '../lib/api.mjs';
import { budgetFetch } from '../lib/platform.mjs';
import { TtlCache } from '../lib/ttl.mjs';

const fx = readGz(new URL('../../test/fixtures/ledger-socialfeepda.json.gz', import.meta.url));
// getProgramAccountsV2 walks accounts in pubkey byte order; the sweep asks for 60-byte slices
const byBytes = (a, b) => Buffer.compare(Buffer.from(decodeBase58(a[0])), Buffer.from(decodeBase58(b[0])));
const ACCOUNTS = [...fx.accounts].sort(byBytes).map(([pubkey, lamports, b64]) => {
  const d = new Uint8Array(60);
  d.set(accountData(b64).subarray(0, 60));
  return { pubkey, account: { lamports, data: [Buffer.from(d).toString('base64'), 'base64'], owner: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', executable: false, rentEpoch: 0, space: 179 } };
});
const RENT = fx.rentExemptLamports;
const quiet = () => {};

/** A fetch that answers the RPC (V2 pages, rent) and GitHub /user/<id> with synthetic users; counts calls. */
function upstream({ failPageOnce = -1 } = {}) {
  const calls = { rpc: 0, github: 0, pages: 0 };
  let failed = false;
  const f = async (url, init = {}) => {
    const u = String(url);
    if (/^https:\/\/api\.github\.com\/user\/\d+$/.test(u)) { // GitHub REST: user by numeric id
      calls.github++;
      const id = u.split('/').pop();
      return Response.json({ id: Number(id), login: `sample-login-${id.slice(-3)}`, type: Number(id) % 7 === 0 ? 'Organization' : 'User' });
    }
    calls.rpc++;
    const { method, params, id } = JSON.parse(init.body);
    if (method === 'getMinimumBalanceForRentExemption') return Response.json({ jsonrpc: '2.0', id, result: RENT });
    assert.equal(method, 'getProgramAccountsV2');
    const cfg = params[1];
    assert.deepEqual(cfg.dataSlice, { offset: 0, length: 60 });
    const start = cfg.paginationKey ? ACCOUNTS.findIndex((a) => a.pubkey === cfg.paginationKey) + 1 : 0;
    if (calls.pages++ === failPageOnce && !failed) { failed = true; return new Response('upstream broke', { status: 500 }); }
    const page = ACCOUNTS.slice(start, start + cfg.limit);
    const next = start + cfg.limit < ACCOUNTS.length ? page.at(-1).pubkey : null;
    return Response.json({ jsonrpc: '2.0', id, result: { accounts: page, paginationKey: next, count: page.length } });
  };
  return { f, calls };
}

function memCache(store) {
  return { get: async (k) => store.get(k), set: async (k, v) => store.setJSON(k, v), prefetch: async () => {} };
}

async function runSweep({ pageSize = 3000, githubPerRun = 10, up = upstream(), store, runs = 50, now } = {}) {
  const log = [];
  for (let i = 0; i < runs; i++) {
    const f = budgetFetch(45, up.f);
    const opts = { rpc: createRpc({ rpcUrl: 'http://rpc.invalid', fetch: f, retries: 0 }), fetch: f, cache: memCache(store), maskSecret: 'test-secret', timeoutMs: 1000 };
    let r;
    try { r = await sweepStep({ store, opts, pageSize, githubPerRun, now }); } catch (e) { r = { error: e.code || e.message }; }
    log.push({ ...r, fetches: f.used });
    if (r.done) break;
  }
  return log;
}

test('a sweep of getProgramAccountsV2 pages publishes the ledger one getProgramAccounts gives (recorded snapshot)', async () => {
  clearRentCache();
  const db = fakeD1(); useD1(db);
  const store = await getStore('payblame');
  const T0 = Date.parse('2026-09-27T12:00:00.000Z');
  let t = T0;
  const log = await runSweep({ store, now: () => (t += 15 * 60e3) });
  assert.equal(log.length, Math.ceil(ACCOUNTS.length / 3000));
  assert.ok(log.every((r) => !r.error));
  assert.ok(log.at(-1).done && log.at(-1).published);
  const raw = await store.get(RAW_KEY);
  const { scan, ...rest } = raw;
  const one = JSON.parse(JSON.stringify(aggregateLedger(ACCOUNTS.map((a) => ({ pubkey: a.pubkey, lamports: a.account.lamports, data: accountData(a.account.data) })), { rentExemptLamports: RENT, snapshotAt: rest.snapshotAt })));
  assert.deepEqual(rest, one);
  assert.equal(scan.pages, log.length);
  assert.equal(scan.startedAt, new Date(T0 + 15 * 60e3).toISOString());
  assert.equal(await store.get(SWEEP_KEY), null);
  // the published snapshot: masked, same numbers, account types for the GitHub ids resolved so far
  const pub = await store.get(LEDGER_KEY);
  assert.equal(pub.logins, 'masked');
  const rows = [...pub.topUnclaimed, ...pub.topClaimed, ...pub.recentClaims];
  assert.ok(rows.every((r) => r.masked && r.login === LOGIN_MASK && r.githubId === null && r.socialFeePda === null && /^row:[0-9a-f]{8}$/.test(r.rowId)));
  assert.ok(!JSON.stringify(pub).includes('sample-login'));
  assert.deepEqual(pub.github, one.github);
  assert.deepEqual(pub.topUnclaimed.map((r) => r.unclaimedLamports), one.topUnclaimed.map((r) => r.unclaimedLamports));
  assert.ok(rows.some((r) => r.accountType));
  useD1(null);
});

test('every run stays inside the free-plan budget: one page, at most 10 GitHub lookups, <= 45 fetches', async () => {
  clearRentCache();
  const db = fakeD1(); useD1(db);
  const store = await getStore('payblame');
  const up = upstream();
  const first = await runSweep({ store, up });
  const second = await runSweep({ store, up }); // the next sweep: most GitHub ids are cached by now
  for (const r of [...first, ...second]) {
    assert.ok(r.fetches <= 12, `fetches ${r.fetches}`);
    assert.ok(r.githubAdded <= 10);
  }
  // cached ids are free: the second sweep asks GitHub for what is left, then nothing
  assert.ok(second.at(-1).githubAdded === 0 || second.at(-1).githubKnown === second.at(-1).githubRows);
  assert.ok(up.calls.github <= 10 * (first.length + second.length));
  assert.ok(db.stats.rowsWritten <= (first.length + second.length) * 13);
  useD1(null);
});

test('a failed page changes nothing: the next run reads the same page again', async () => {
  clearRentCache();
  const db = fakeD1(); useD1(db);
  const store = await getStore('payblame');
  const up = upstream({ failPageOnce: 1 });
  const log = await runSweep({ store, up, githubPerRun: 0 });
  assert.equal(log.filter((r) => r.error).length, 1);
  assert.equal(log.at(-1).scanned, ACCOUNTS.length);
  const { scan, ...rest } = await store.get(RAW_KEY);
  assert.equal(rest.accounts.total + (rest.skippedUndecodable ?? 0), ACCOUNTS.length);
  useD1(null);
});

test('mergePage: adding pages in any grouping gives the same aggregate', () => {
  const all = ACCOUNTS.map((a) => ({ pubkey: a.pubkey, lamports: a.account.lamports, data: accountData(a.account.data) }));
  const opts = { rentExemptLamports: RENT, snapshotAt: '2026-09-27T00:00:00.000Z' };
  const whole = aggregateLedger(all, opts);
  for (const size of [1000, 4096, 7000]) {
    let acc = null;
    for (let i = 0; i < all.length; i += size) acc = mergePage(acc, aggregateLedger(all.slice(i, i + size), opts));
    for (const k of ['accounts', 'github', 'x', 'topUnclaimed', 'topClaimed', 'recentClaims']) assert.deepEqual(acc[k], whole[k], `${k} @${size}`);
  }
});

test('fetchPage decodes a page in one go, and falls back to per-account decoding for other slice lengths', async () => {
  const rpc = { call: async () => ({ accounts: ACCOUNTS.slice(0, 5), paginationKey: 'next' }) };
  const p = await fetchPage(rpc, null, 5);
  assert.equal(p.next, 'next');
  assert.deepEqual(p.accounts.map((a) => [...a.data]), ACCOUNTS.slice(0, 5).map((a) => [...accountData(a.account.data)]));
  const odd = { call: async () => ({ accounts: fx.accounts.slice(0, 3).map(([pubkey, lamports, b64]) => ({ pubkey, account: { lamports, data: [b64, 'base64'] } })), paginationKey: null }) };
  const q = await fetchPage(odd, null, 3);
  assert.equal(q.next, null);
  assert.deepEqual(q.accounts.map((a) => a.data.length), [59, 59, 59]);
});

test('/api/ledger before the first sweep completes: warmingUp with progress, not cached; then the snapshot with its age', async () => {
  clearRentCache();
  const db = fakeD1(); useD1(db);
  const store = await getStore('payblame');
  await runSweep({ store, runs: 2, githubPerRun: 0 });
  const res = await ledgerResponse({ store, memo: new TtlCache(), maskSecret: async () => 's', progress: () => sweepProgress(store), log: quiet });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const w = await res.json();
  assert.equal(w.warmingUp, true);
  assert.deepEqual(w.progress.pages, 2);
  assert.equal(w.progress.accountsScanned, 6000);
  assert.equal(w.github, null);
  assert.deepEqual([w.topUnclaimed, w.topClaimed, w.recentClaims], [[], [], []]);
  assert.equal(w.logins, 'masked');
  await runSweep({ store, githubPerRun: 0 });
  const ok = await (await ledgerResponse({ store, memo: new TtlCache(), maskSecret: async () => 's', progress: () => sweepProgress(store) })).json();
  assert.equal(ok.warmingUp, undefined);
  assert.equal(ok.accounts.total + (ok.skippedUndecodable ?? 0), ACCOUNTS.length);
  assert.equal(typeof ok.ageSeconds, 'number');
  useD1(null);
});
