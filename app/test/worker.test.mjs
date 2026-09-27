// worker.mjs (Cloudflare Workers entry): each /api path reaches its Netlify function, everything else goes to the
// static assets, scheduled() runs ledger-cron against the D1 binding, bindings reach process.env. Offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { compilePath, context, ROUTES, SCHEDULED } from '../worker.mjs';
import { fakeD1 } from './helpers/fake-d1.mjs';
import { accountData, decodeBase58, clearRentCache } from '../../src/index.js';
import { readGz } from '../../test/helpers/transcript.js';
import { onCloudflare } from '../lib/platform.mjs';

for (const k of ['HELIUS_API_KEY', 'PAYBLAME_RPC_URL', 'GITHUB_TOKEN', 'BIRDEYE_API_KEY', 'TOKEN_MINT', 'CF_FREE_PLAN', 'LEDGER_PAGE_SIZE', 'LOOKUP_MAX_LIMIT', 'LEDGER_MASK_SECRET']) delete process.env[k];

const assets = () => {
  const seen = [];
  return { seen, fetch: async (req) => { seen.push(new URL(req.url).pathname); return new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/plain' } }); } };
};
const ctx = () => { const waits = []; return { waits, waitUntil: (p) => waits.push(p), passThroughOnException() {} }; };
const noNetwork = () => { globalThis.fetch = async (u) => { throw new Error(`unexpected fetch ${u}`); }; };
const env = (extra = {}) => ({ DB: fakeD1(), ASSETS: assets(), HELIUS_API_KEY: 'test-key-not-real', LEDGER_MASK_SECRET: 'test-secret', ...extra });
const call = (e, path, init) => worker.fetch(new Request(`https://payblame.test${path}`, init), e, ctx());

test('routes: the three Netlify functions by config.path; the scheduled one has no route', () => {
  assert.deepEqual(ROUTES.map((r) => [r.path, r.name]), [['/api/health', 'health'], ['/api/ledger', 'ledger'], ['/api/lookup', 'lookup']]);
  assert.deepEqual(SCHEDULED.map((s) => [s.name, s.schedule]), [['ledger-cron', '*/15 * * * *']]);
  assert.deepEqual(compilePath('/api/x/:id')('/api/x/42'), { id: '42' });
  assert.equal(compilePath('/api/x/:id')('/api/x/42/y'), null);
  assert.deepEqual(compilePath('/api/*')('/api/a/b'), {});
});

test('/api/health reaches health.mjs; vars and secrets from the env reach process.env (names only in the answer)', async () => {
  noNetwork();
  const e = env({ TOKEN_MINT: '' });
  const res = await call(e, '/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.project, 'payblame');
  assert.deepEqual(body.keys, { helius: true, birdeye: false, github: false });
  assert.ok(!JSON.stringify(body).includes('test-key-not-real'));
  assert.equal(onCloudflare(), true);
  assert.deepEqual(e.ASSETS.seen, []);
});

test('/api/ledger reaches ledger.mjs and reads D1: warming up before the first snapshot, never a scan in the request', async () => {
  noNetwork();
  const e = env();
  const res = await call(e, '/api/ledger');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.warmingUp, true);
  assert.equal(body.github, null);
  assert.ok(e.DB.stats.queries >= 1);
});

test('/api/lookup reaches lookup.mjs: input errors answer without the network, non-GET is 405', async () => {
  noNetwork();
  const e = env();
  const bad = await call(e, '/api/lookup?q=not%20a%20login!');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'BAD_INPUT');
  const post = await call(e, '/api/lookup?q=sample-dev', { method: 'POST' });
  assert.equal(post.status, 405);
});

test('everything else goes to the static assets: /, files, unknown pages, unknown /api paths', async () => {
  noNetwork();
  const e = env();
  for (const p of ['/', '/style.css', '/CREDITS.md', '/nope', '/api/nope', '/api/lookup/extra', '/api']) {
    const res = await call(e, p);
    assert.equal(await res.text(), `asset ${p}`, p);
  }
  assert.equal(e.ASSETS.seen.length, 7);
});

test('context shim: params, ip from cf-connecting-ip, geo from request.cf, waitUntil -> ctx.waitUntil', async () => {
  const c = ctx();
  const req = new Request('https://payblame.test/api/x/1', { headers: { 'cf-connecting-ip': '203.0.113.7', 'cf-ray': 'abc' } });
  Object.defineProperty(req, 'cf', { value: { country: 'HR', city: 'Zagreb', timezone: 'Europe/Zagreb' } });
  const x = context(req, c, { id: '1' });
  assert.deepEqual(x.params, { id: '1' });
  assert.equal(x.ip, '203.0.113.7');
  assert.equal(x.geo.country.code, 'HR');
  assert.equal(x.site.url, 'https://payblame.test');
  const p = Promise.resolve(1);
  x.waitUntil(p);
  assert.deepEqual(c.waits, [p]);
});

// a small recorded (scrubbed) SocialFeePda set, served as getProgramAccountsV2 / getProgramAccounts
const fx = readGz(new URL('../../test/fixtures/ledger-socialfeepda.json.gz', import.meta.url));
const SET = [...fx.accounts].sort((a, b) => Buffer.compare(Buffer.from(decodeBase58(a[0])), Buffer.from(decodeBase58(b[0])))).slice(0, 400)
  .map(([pubkey, lamports, b64]) => ({ pubkey, account: { lamports, data: [Buffer.from(accountData(b64)).toString('base64'), 'base64'] } }));
function chain() {
  const methods = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (/^https:\/\/api\.github\.com\/user\/\d+$/.test(u)) return Response.json({ id: Number(u.split('/').pop()), login: 'sample-dev', type: 'User' });
    const { method, params, id } = JSON.parse(init.body);
    methods.push(method);
    if (method === 'getMinimumBalanceForRentExemption') return Response.json({ jsonrpc: '2.0', id, result: fx.rentExemptLamports });
    if (method === 'getProgramAccounts') return Response.json({ jsonrpc: '2.0', id, result: SET });
    const start = params[1].paginationKey ? SET.findIndex((a) => a.pubkey === params[1].paginationKey) + 1 : 0;
    const page = SET.slice(start, start + params[1].limit);
    return Response.json({ jsonrpc: '2.0', id, result: { accounts: page, paginationKey: start + params[1].limit < SET.length ? page.at(-1).pubkey : null } });
  };
  return methods;
}

test('scheduled() runs ledger-cron on the free plan: one getProgramAccountsV2 page per run into D1, then /api/ledger serves it', async () => {
  clearRentCache();
  const methods = chain();
  delete process.env.LEDGER_PAGE_SIZE;
  const e = env({ CF_FREE_PLAN: '1', LEDGER_PAGE_SIZE: '150' });
  const runs = [];
  for (let i = 0; i < 3; i++) { await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now() }, e, ctx()); runs.push(methods.filter((m) => m === 'getProgramAccountsV2').length); }
  assert.deepEqual(runs, [1, 2, 3]); // one page per run
  assert.ok(!methods.includes('getProgramAccounts'));
  const body = await (await call(e, '/api/ledger')).json();
  assert.equal(body.warmingUp, undefined);
  assert.equal(body.accounts.total + (body.skippedUndecodable ?? 0), SET.length);
  assert.equal(body.scan.pages, 3);
  assert.equal(body.logins, 'masked');
  assert.ok(!JSON.stringify(body).includes('sample-dev'));
  delete process.env.LEDGER_PAGE_SIZE;
});

test('scheduled() on Workers Paid (CF_FREE_PLAN=0): the full job, one getProgramAccounts, as on Netlify', async () => {
  clearRentCache();
  const methods = chain();
  delete process.env.CF_FREE_PLAN;
  const e = env({ CF_FREE_PLAN: '0' });
  await worker.scheduled({ cron: '*/15 * * * *' }, e, ctx());
  assert.deepEqual(methods.filter((m) => m.startsWith('getProgramAccounts')), ['getProgramAccounts']);
  // read D1 directly: /api/ledger keeps its answer in memory for 5 minutes, and the previous test warmed it
  const row = e.DB.rows.get('payblame\u0000ledger/latest');
  const body = JSON.parse(row.value);
  assert.equal(body.accounts.total + (body.skippedUndecodable ?? 0), SET.length);
  assert.equal(body.scan, undefined);
  assert.equal(body.logins, 'masked');
  delete process.env.CF_FREE_PLAN;
});
