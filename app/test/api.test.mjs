// Service layer: validation, caching, error mapping. Offline: lookups replay recorded mainnet traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupResponse, ledgerResponse, cacheKey, parseLimit, parseMask, TTL, LEDGER_KEY } from '../lib/api.mjs';
import { TtlCache } from '../lib/ttl.mjs';
import { lookup, parseQuery, clearRentCache, PayblameError, ledgerRowId, LOGIN_MASK } from '../../src/index.js';
import { fakeKey } from '../../test/helpers/synth.js';
import { readGz, replayFetch, seededCache } from '../../test/helpers/transcript.js';
import { readFileSync } from 'node:fs';

const fx = (name) => readGz(new URL(`../../test/fixtures/${name}.json.gz`, import.meta.url));
const url = (qs) => new URL(`http://localhost/api/lookup?${qs}`);
const quiet = () => {};
function replayDeps(name, cache = new TtlCache()) {
  const f = fx(name);
  let runs = 0;
  return {
    cache,
    log: quiet,
    get runs() { return runs; },
    lookup: (q, opts) => { runs++; clearRentCache(); return lookup(q, { ...opts, fetch: replayFetch(f.transcript), cache: seededCache(f.cacheSeed), rpcUrl: 'http://replay.invalid' }); },
  };
}

test('400 for missing, malformed and oversized input, with the contract message', async () => {
  for (const qs of ['', 'q=', 'q=%20%20', 'q=not%20a%20login!', `q=${'a'.repeat(65)}`, 'q=ghid:abc', 'q=sample-dev&limit=0', 'q=sample-dev&limit=251', 'q=sample-dev&limit=abc', 'q=sample-dev&limit=1.5']) {
    const res = await lookupResponse(url(qs), { lookup: () => { throw new Error('should not run'); }, log: quiet });
    assert.equal(res.status, 400, qs);
    const body = await res.json();
    assert.equal(body.code, 'BAD_INPUT', qs);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('coin lookup: 200, contract shape, 60 s cache, second hit served from memory', async () => {
  const deps = replayDeps('coin-declared-mismatch');
  const res = await lookupResponse(url('q=J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpump'), deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), `public, max-age=${TTL.coin}`);
  const body = await res.json();
  for (const k of ['kind', 'query', 'mint', 'name', 'symbol', 'description', 'marketCapUsd', 'dexId', 'pairUrl', 'curve', 'feeSharing', 'sharingConfig', 'config', 'vaults', 'declared', 'mismatch', 'diff', 'blame', 'meta']) assert.ok(k in body, k);
  assert.equal(body.meta.cached, false);
  const again = await (await lookupResponse(url('q=J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpump'), deps)).json();
  assert.equal(again.meta.cached, true);
  assert.deepEqual(again.blame, body.blame);
  assert.equal(deps.runs, 1);
});

test('mask=1: same cached run, logins/handles/ids/PDAs masked on the wire; bad mask -> 400', async () => {
  const mint = 'J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpump';
  const deps = replayDeps('coin-declared-mismatch');
  const plain = await (await lookupResponse(url(`q=${mint}`), deps)).json();
  const res = await lookupResponse(url(`q=${mint}&mask=1`), deps);
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.equal(m.masked, true);
  assert.equal(m.logins, 'masked');
  const wire = JSON.stringify(m);
  const s = plain.config.shareholders[0];
  for (const secret of [s.login, s.userId, s.address, ...plain.declared.map((d) => d.handle)]) assert.ok(!wire.includes(secret), 'leaked a masked value');
  assert.equal(m.config.shareholders[0].login, LOGIN_MASK);
  assert.deepEqual(m.totals, plain.totals);
  assert.equal(m.vaults.pendingLamports, plain.vaults.pendingLamports);
  assert.equal(deps.runs, 1); // the masked view is served from the same cached run
  const unmasked = await (await lookupResponse(url(`q=${mint}&mask=0`), deps)).json();
  assert.equal(unmasked.config.shareholders[0].login, s.login);
  for (const bad of ['yes', '2', 'TRUE']) {
    const r = await lookupResponse(url(`q=${mint}&mask=${bad}`), deps);
    assert.equal(r.status, 400, bad);
    assert.equal((await r.json()).code, 'BAD_INPUT');
  }
});

test('recipient lookup: 300 s cache, case-insensitive login key, limit part of the key', async () => {
  const login = fx('recipient-89-coins').q; // the recorded recipient; the test doesn't name it
  const deps = replayDeps('recipient-89-coins');
  const res = await lookupResponse(url(`q=${login}`), deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), `public, max-age=${TTL.recipient}`);
  const body = await res.json();
  for (const k of ['kind', 'query', 'recipient', 'account', 'coins', 'totals', 'blame', 'meta']) assert.ok(k in body, k);
  for (const k of ['resolve', 'probes', 'accounts', 'metadata', 'total']) assert.equal(typeof body.meta.timingMs[k], 'number');
  await lookupResponse(url(`q=%40${login.toUpperCase()}`), deps);
  assert.equal(deps.runs, 1);
  assert.notEqual(cacheKey(parseQuery('sample-dev'), 100), cacheKey(parseQuery('sample-dev'), 50));
});

test('errors map to the contract: NOT_PUMP 404, rate limit 429 + retryAfterSeconds, unknown 502 without internals', async () => {
  const notPump = await lookupResponse(url('q=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), replayDeps('not-pump-usdc'));
  assert.equal(notPump.status, 404);
  assert.deepEqual(await notPump.json(), { error: 'Not a pump.fun mint: no bonding curve and no SharingConfig', code: 'NOT_PUMP' });

  const limited = await lookupResponse(url('q=someone'), { cache: new TtlCache(), log: quiet, lookup: async () => { throw new PayblameError('GITHUB_RATE_LIMIT', 'GitHub rate limit reached, try ghid:<id> or retry later', { retryAfterSeconds: 120 }); } });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '120');
  assert.deepEqual(await limited.json(), { error: 'GitHub rate limit reached, try ghid:<id> or retry later', code: 'GITHUB_RATE_LIMIT', retryAfterSeconds: 120 });

  const notFound = await lookupResponse(url('q=nobody'), { cache: new TtlCache(), log: quiet, lookup: async () => { throw new PayblameError('GITHUB_NOT_FOUND', 'GitHub user nobody not found'); } });
  assert.equal(notFound.status, 404);

  const logs = [];
  const boom = await lookupResponse(url('q=someone'), { cache: new TtlCache(), log: (m) => logs.push(m), lookup: async () => { throw new TypeError('fetch failed https://mainnet.helius-rpc.com/?api-key=SECRET123'); } });
  assert.equal(boom.status, 502);
  const text = await boom.text();
  assert.ok(!text.includes('SECRET123') && !text.includes('stack'));
  assert.ok(!logs.join('').includes('SECRET123'));
});

test('parseMask', () => {
  assert.equal(parseMask(null), false);
  assert.equal(parseMask('0'), false);
  assert.equal(parseMask('1'), true);
  assert.equal(parseMask('true'), true);
  assert.equal(parseMask('on'), null);
});

test('parseLimit', () => {
  assert.equal(parseLimit(null), 100);
  assert.equal(parseLimit('24'), 24);
  assert.equal(parseLimit('250'), 250);
  assert.equal(parseLimit('0'), null);
  assert.equal(parseLimit('-1'), null);
});

// ---------------------------------------------------------------- /api/ledger

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/ledger-snapshot.json', import.meta.url)));
function memStore(init = {}) { const m = new Map(Object.entries(init)); return { m, get: async (k) => m.get(k) ?? null, setJSON: async (k, v) => { m.set(k, v); } }; }
const at = (iso) => () => Date.parse(iso);

test('ledger: a fresh blob is served as is (0 upstream calls), 900 s cache', async () => {
  const store = memStore({ [LEDGER_KEY]: snapshot });
  const res = await ledgerResponse({ store, memo: new TtlCache(), now: () => Date.parse(snapshot.snapshotAt) + 10 * 60e3, build: () => { throw new Error('should not build'); } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), `public, max-age=${TTL.ledger}`);
  const body = await res.json();
  for (const k of ['snapshotAt', 'source', 'rentExemptLamports', 'accounts', 'github', 'x', 'topUnclaimed', 'topClaimed', 'recentClaims', 'blame']) assert.ok(k in body, k);
  assert.equal(body.topUnclaimed.length, 25);
  assert.equal(body.logins, 'masked');
});

const allRows = (l) => [...l.topUnclaimed, ...l.topClaimed, ...l.recentClaims];
const ROW_LINE = /^row:[0-9a-f]{8} \(github:#{4} {17} (user|org |\? {3})\) unclaimed=\d+\.\d{3} +claimed=\d+\.\d{3} +last=(never|\d{4}-\d\d-\d\d)$/;

test('ledger fixture: the recorded snapshot names nobody (masked rows, the one 4-# mask, no ids or PDAs)', () => {
  assert.equal(LOGIN_MASK, '####');
  assert.equal(snapshot.logins, 'masked');
  assert.ok(allRows(snapshot).every((r) => r.masked === true && r.login === LOGIN_MASK && r.githubId === null && r.socialFeePda === null && /^row:[0-9a-f]{8}$/.test(r.rowId)));
  for (const line of snapshot.blame.slice(2)) assert.match(line, ROW_LINE);
  const text = JSON.stringify(snapshot);
  assert.doesNotMatch(text, /github:(?!#)|x:@|sample-login|@[A-Za-z]/);
});

test('ledger: logins are never served, even from a snapshot stored before masking; row ids are stable per secret', async () => {
  // a legacy (unmasked) blob, as stored before this fix; synthetic logins/PDAs, real numbers
  const legacy = {
    ...snapshot,
    logins: undefined,
    topUnclaimed: snapshot.topUnclaimed.map((r, i) => ({ ...r, masked: undefined, rowId: undefined, login: `legacy-login-${i}`, githubId: String(9000100000 + i), socialFeePda: fakeKey(`u${i}`) })),
    topClaimed: snapshot.topClaimed.map((r, i) => ({ ...r, masked: undefined, rowId: undefined, login: `legacy-top-${i}`, githubId: String(9000200000 + i), socialFeePda: fakeKey(`c${i}`) })),
    recentClaims: snapshot.recentClaims.map((r, i) => ({ ...r, masked: undefined, rowId: undefined, login: `legacy-recent-${i}`, githubId: String(9000300000 + i), socialFeePda: fakeKey(`r${i}`) })),
    blame: [...snapshot.blame.slice(0, 2), `${fakeKey('u0').slice(0, 8)} (github:legacy-login-0            user) unclaimed   1869.443 claimed      0.000 last never`],
  };
  const deps = () => ({ store: memStore({ [LEDGER_KEY]: legacy }), memo: new TtlCache(), maskSecret: async () => 'svc-secret', now: () => Date.parse(snapshot.snapshotAt) + 60e3, build: () => { throw new Error('should not build'); } });
  const text = await (await ledgerResponse(deps())).text();
  assert.doesNotMatch(text, /legacy-(login|top|recent)|900[123]0000\d\d/);
  assert.ok(!text.includes(fakeKey('u0').slice(0, 8)));
  const body = JSON.parse(text);
  assert.equal(body.logins, 'masked');
  assert.match(body.loginsNote, /lookup/);
  assert.ok(allRows(body).every((r) => r.masked === true && r.login === LOGIN_MASK && r.githubId === null && r.socialFeePda === null));
  assert.equal(body.topUnclaimed[0].rowId, ledgerRowId(fakeKey('u0'), 'svc-secret'));
  assert.equal(body.blame.length, 27);
  assert.match(body.blame[0], / logins=masked$/);
  for (const line of body.blame.slice(2)) assert.match(line, ROW_LINE);
  const again = await (await ledgerResponse(deps())).json();
  assert.deepEqual(again.topUnclaimed.map((r) => r.rowId), body.topUnclaimed.map((r) => r.rowId));
});

test('ledger: an on-demand build is masked before it is stored', async () => {
  const store = memStore();
  const unmasked = { ...snapshot, snapshotAt: '2026-09-25T15:00:00.000Z', topUnclaimed: snapshot.topUnclaimed.map((r, i) => ({ ...r, masked: undefined, rowId: undefined, login: `built-${i}`, githubId: String(i + 1), socialFeePda: fakeKey(`b${i}`) })) };
  const res = await ledgerResponse({ store, memo: new TtlCache(), maskSecret: async () => 's', build: async () => unmasked });
  assert.doesNotMatch(await res.text(), /built-\d/);
  assert.doesNotMatch(JSON.stringify(store.m.get(LEDGER_KEY)), /built-\d/);
});

test('ledger: missing or >60 min old -> built on demand and stored; build failure falls back to the stale blob, else 502', async () => {
  const fresh = { ...snapshot, snapshotAt: '2026-09-25T15:00:00.000Z' };
  const empty = memStore();
  const r1 = await ledgerResponse({ store: empty, memo: new TtlCache(), build: async () => fresh });
  assert.equal(r1.status, 200);
  assert.equal(empty.m.get(LEDGER_KEY).snapshotAt, fresh.snapshotAt);

  const stale = memStore({ [LEDGER_KEY]: snapshot });
  const later = () => Date.parse(snapshot.snapshotAt) + 2 * 3600e3;
  const r2 = await ledgerResponse({ store: stale, memo: new TtlCache(), now: later, build: async () => fresh });
  assert.equal((await r2.json()).snapshotAt, fresh.snapshotAt);

  const r3 = await ledgerResponse({ store: memStore({ [LEDGER_KEY]: snapshot }), memo: new TtlCache(), now: later, log: quiet, build: async () => { throw new Error('rpc down'); } });
  assert.equal(r3.status, 200);
  assert.equal((await r3.json()).snapshotAt, snapshot.snapshotAt);

  const r4 = await ledgerResponse({ store: memStore(), memo: new TtlCache(), log: quiet, build: async () => { throw new Error('rpc down'); } });
  assert.equal(r4.status, 502);
  assert.deepEqual(await r4.json(), { error: 'Ledger snapshot unavailable', code: 'UPSTREAM' });
});

test('TtlCache expiry and in-flight de-duplication', async () => {
  let t = 0;
  const c = new TtlCache({ now: () => t });
  c.set('a', 1, 60);
  assert.equal(c.get('a'), 1);
  t = 60_001;
  assert.equal(c.get('a'), undefined);
  let runs = 0;
  const slow = () => new Promise((r) => setTimeout(() => r(++runs), 10));
  const [x, y] = await Promise.all([c.once('k', slow), c.once('k', slow)]);
  assert.equal(x, y);
  assert.equal(runs, 1);
});
