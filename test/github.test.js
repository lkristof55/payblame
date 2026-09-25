import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLogin, resolveId, resolveIds, isNumericId, memoryCache, PayblameError } from '../src/index.js';

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const mock = (routes) => {
  const calls = [];
  const f = async (url, init) => { calls.push(String(url)); for (const [re, fn] of routes) if (re.test(String(url))) return fn(url, init); throw new Error(`no route ${url}`); };
  f.calls = calls;
  return f;
};

test('resolveLogin: success is cached both ways', async () => {
  const f = mock([[/\/users\/sample-dev$/i, () => json(200, { login: 'sample-dev', id: 1000001, type: 'User' })]]);
  const cache = memoryCache();
  assert.deepEqual(await resolveLogin('Sample-Dev', { fetch: f, cache }), { id: '1000001', login: 'sample-dev', type: 'User' });
  assert.deepEqual(await resolveLogin('sample-dev', { fetch: f, cache }), { id: '1000001', login: 'sample-dev', type: 'User' });
  assert.equal(f.calls.length, 1);
  assert.equal((await resolveId('1000001', { fetch: f, cache })).login, 'sample-dev');
  assert.equal(f.calls.length, 1);
});

test('resolveLogin: 404 -> null', async () => {
  const f = mock([[/\/users\//, () => json(404, { message: 'Not Found' })]]);
  assert.equal(await resolveLogin('nobody-here', { fetch: f }), null);
});

test('resolveLogin: rate limited -> avatar redirect fallback gives the id', async () => {
  const f = mock([
    [/api\.github\.com/, () => json(403, { message: 'rate limit' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600) })],
    [/github\.com\/sample-dev\.png/, () => new Response(null, { status: 302, headers: { location: 'https://avatars.githubusercontent.com/u/1000001?v=4' } })],
  ]);
  assert.deepEqual(await resolveLogin('sample-dev', { fetch: f }), { id: '1000001', login: 'sample-dev', type: null, source: 'avatar-redirect' });
});

test('resolveLogin: rate limited and fallback down -> GITHUB_RATE_LIMIT with retryAfterSeconds', async () => {
  const f = mock([
    [/api\.github\.com/, () => json(429, { message: 'slow down' }, { 'retry-after': '42' })],
    [/\.png$/, () => { throw new Error('offline'); }],
  ]);
  await assert.rejects(resolveLogin('sample-dev', { fetch: f }), (e) => e instanceof PayblameError && e.code === 'GITHUB_RATE_LIMIT' && e.status === 429 && e.retryAfterSeconds === 42);
});

test('resolveId: deleted account (404) and rate limit (null)', async () => {
  const f = mock([[/\/user\/1$/, () => json(404, {})], [/\/user\/2$/, () => json(403, {}, { 'x-ratelimit-remaining': '0' })]]);
  assert.deepEqual(await resolveId('1', { fetch: f }), { id: '1', login: null, type: null, deleted: true });
  assert.equal(await resolveId('2', { fetch: f }), null);
});

test('resolveIds: cached ids are free, the network budget is capped, a failure stops spending', async () => {
  const cache = memoryCache();
  await cache.set('gh/id/10', { at: Date.now(), value: { id: '10', login: 'cached', type: 'User', deleted: false } });
  let n = 0;
  const f = mock([[/\/user\/(\d+)$/, (url) => { n++; const id = /(\d+)$/.exec(url)[1]; return id === '13' ? json(403, {}, { 'x-ratelimit-remaining': '0' }) : json(200, { id: Number(id), login: `u${id}`, type: 'User' }); }]]);
  const out = await resolveIds(['10', '11', '12', '13', '14', '15', '16'], { fetch: f, cache, max: 4, concurrency: 1 });
  assert.equal(out.get('10').login, 'cached');
  assert.equal(out.get('11').login, 'u11');
  assert.equal(out.get('13'), null);
  assert.equal(out.get('14'), null); // after the rate-limit hit, no more requests
  assert.equal(out.get('16'), null); // over the budget of 4
  assert.equal(n, 3);
});

test('text user_ids (a handle, a name, a URL stored on chain) are never sent to GitHub', async () => {
  const f = mock([[/\/user\/(\d+)$/, (url) => json(200, { login: `sample-login-${String(url).slice(-2)}`, id: Number(String(url).split('/').pop()), type: 'User' })]]);
  assert.equal(isNumericId('1000001'), true);
  for (const t of ['sample_x_0007', '~07', 'a name', 'x.com/someone', '']) assert.equal(isNumericId(t), false, t);
  assert.equal(await resolveId('a name', { fetch: f }), null);
  const m = await resolveIds(['~07', '1000012', 'sample_gh_0001', '1000013'], { fetch: f, cache: memoryCache() });
  assert.equal(m.get('~07'), null);
  assert.equal(m.get('sample_gh_0001'), null);
  assert.equal(m.get('1000012').login, 'sample-login-12');
  assert.equal(m.get('1000013').login, 'sample-login-13', 'a text id does not stop the numeric lookups after it');
  assert.equal(f.calls.length, 2);
});
