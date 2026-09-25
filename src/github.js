// GitHub login <-> numeric id. pump.fun seeds a SocialFeePda with the immutable numeric id,
// so a login has to be turned into an id first, and ids back into logins for display.
//
// Cache: any object with async get(key) / set(key, value). Entries are { at, value } and live
// 7 days (ids never change; a rename shows up after at most a week).
import { PayblameError } from './errors.js';

const TTL_MS = 7 * 24 * 3600e3;
const API = 'https://api.github.com';

export function memoryCache() {
  const m = new Map();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); } };
}

async function cached(cache, key) {
  if (!cache) return null;
  try {
    const hit = await cache.get(key);
    if (hit && typeof hit === 'object' && 'value' in hit && Date.now() - hit.at < TTL_MS) return hit;
  } catch { /* a broken cache is a cache miss */ }
  return null;
}
async function store(cache, key, value) {
  if (!cache) return;
  try { await cache.set(key, { at: Date.now(), value }); } catch { /* best effort */ }
}

function headers(token) {
  const h = { accept: 'application/vnd.github+json', 'user-agent': 'payblame', 'x-github-api-version': '2022-11-28' };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}
const isRateLimited = (res) => res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
function retryAfter(res) {
  const ra = Number(res.headers.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) return ra;
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? Math.max(1, Math.round(reset - Date.now() / 1000)) : 60;
}

/**
 * Login -> { id, login, type }. Returns null when the login does not exist.
 * When the REST API is rate limited, falls back to the public avatar redirect
 * (github.com/<login>.png -> avatars.githubusercontent.com/u/<id>), which gives the id but
 * not the canonical login casing or the account type.
 * @param {string} login
 * @param {{ githubToken?: string, fetch?: typeof fetch, cache?: any, timeoutMs?: number }} [opts]
 */
export async function resolveLogin(login, { githubToken, fetch: f = globalThis.fetch, cache, timeoutMs = 8000 } = {}) {
  const key = `gh/login/${login.toLowerCase()}`;
  const hit = await cached(cache, key);
  if (hit) return hit.value;
  let res;
  try {
    res = await f(`${API}/users/${encodeURIComponent(login)}`, { headers: headers(githubToken), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new PayblameError('UPSTREAM', 'GitHub did not answer in time', { cause: e });
  }
  if (res.status === 404) return null;
  if (isRateLimited(res)) {
    const viaAvatar = await idFromAvatar(login, f, timeoutMs);
    if (viaAvatar === null) return null;
    if (viaAvatar) return { id: viaAvatar, login, type: null, source: 'avatar-redirect' };
    throw new PayblameError('GITHUB_RATE_LIMIT', `GitHub rate limit reached, try ghid:<id> or retry later`, { retryAfterSeconds: retryAfter(res) });
  }
  if (!res.ok) throw new PayblameError('UPSTREAM', `GitHub answered HTTP ${res.status}`);
  const u = await res.json();
  const value = { id: String(u.id), login: u.login, type: u.type === 'Organization' ? 'Organization' : 'User' };
  await store(cache, key, value);
  await store(cache, `gh/id/${value.id}`, { ...value, deleted: false });
  return value;
}

/** github.com/<login>.png redirects to avatars.githubusercontent.com/u/<id>. id string, null for 404, undefined on failure. */
async function idFromAvatar(login, f, timeoutMs) {
  try {
    const res = await f(`https://github.com/${encodeURIComponent(login)}.png`, { redirect: 'manual', headers: { 'user-agent': 'payblame' }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return null;
    const m = /\/u\/(\d+)/.exec(res.headers.get('location') || '');
    return m ? m[1] : undefined;
  } catch { return undefined; }
}

/** On-chain user_ids are usually numeric, but some SocialFeePdas hold text (a handle, a name, a URL). */
export const isNumericId = (id) => /^\d{1,20}$/.test(String(id));

/**
 * Numeric id -> { id, login, type, deleted }. `deleted: true` when GitHub answers 404 for the id.
 * Returns null when GitHub cannot be asked right now (rate limit, timeout): callers show github:#<id>.
 * A non-numeric (text) user_id is never sent to GitHub (its /user/<id> route takes numbers): null.
 */
export async function resolveId(id, { githubToken, fetch: f = globalThis.fetch, cache, timeoutMs = 8000, cacheOnly = false } = {}) {
  if (!isNumericId(id)) return null;
  const key = `gh/id/${id}`;
  const hit = await cached(cache, key);
  if (hit) return hit.value;
  if (cacheOnly) return null;
  let res;
  try {
    res = await f(`${API}/user/${encodeURIComponent(id)}`, { headers: headers(githubToken), signal: AbortSignal.timeout(timeoutMs) });
  } catch { return null; }
  if (res.status === 404) {
    const value = { id: String(id), login: null, type: null, deleted: true };
    await store(cache, key, value);
    return value;
  }
  if (!res.ok) return null;
  const u = await res.json();
  const value = { id: String(u.id), login: u.login, type: u.type === 'Organization' ? 'Organization' : 'User', deleted: false };
  await store(cache, key, value);
  return value;
}

/**
 * Resolve many ids with a concurrency cap and a budget of network lookups (cached ids are free).
 * @returns {Promise<Map<string, {id,login,type,deleted}|null>>}
 */
export async function resolveIds(ids, { max = 50, concurrency = 6, ...opts } = {}) {
  const out = new Map();
  const unique = [...new Set(ids.map(String))];
  const misses = [];
  for (const id of unique) {
    if (!isNumericId(id)) { out.set(id, null); continue; } // text user_id: nothing to ask GitHub
    const hit = await resolveId(id, { ...opts, cacheOnly: true });
    if (hit) out.set(id, hit); else misses.push(id);
  }
  const todo = misses.slice(0, max);
  for (const id of misses.slice(max)) out.set(id, null);
  let stop = false;
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      const id = todo[i++];
      const v = stop ? null : await resolveId(id, opts);
      if (v === null) stop = true; // rate limited or down: stop spending requests this run
      out.set(id, v);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return out;
}
