// Request handling for /api/lookup and /api/ledger: validation, caching, error mapping.
// Pure over injected deps so the tests run offline.
import { parseQuery, lookup as libLookup, buildLedger as libBuildLedger, maskLedger, maskLookup, PayblameError } from '../../src/index.js';
import { TtlCache } from './ttl.mjs';

export const TTL = { coin: 60, recipient: 300, ledger: 900 };
export const LEDGER_KEY = 'ledger/latest';
export const LEDGER_MAX_AGE_MS = 60 * 60 * 1000;
export const BAD_INPUT = 'q must be a GitHub login, github:<login>, ghid:<id>, x:<id>, a wallet or a mint';

export function json(body, status = 200, maxAge = 0) {
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (status === 200 && maxAge > 0) {
    headers['cache-control'] = `public, max-age=${maxAge}`;
    headers['netlify-cdn-cache-control'] = `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge}`;
  } else headers['cache-control'] = 'no-store';
  return new Response(JSON.stringify(body), { status, headers });
}

/** Map any thrown value to the contract's error shape. Never leaks stacks or upstream URLs. */
export function errorResponse(e, log = console.error) {
  if (e instanceof PayblameError) {
    const body = { error: e.message, code: e.code };
    if (e.retryAfterSeconds != null) body.retryAfterSeconds = e.retryAfterSeconds;
    const res = json(body, e.status);
    if (e.retryAfterSeconds != null) res.headers.set('retry-after', String(e.retryAfterSeconds));
    return res;
  }
  log(`[payblame] unexpected: ${e?.name}: ${String(e?.message).replace(/api-key=[^&\s]+/g, 'api-key=***')}`);
  return json({ error: 'Solana RPC did not answer in time', code: 'UPSTREAM' }, 502);
}

/** Normalized cache key for a query: kind + normalized q + limit. */
export function cacheKey(parsed, limit) {
  const norm = parsed.kind === 'github' ? parsed.login.toLowerCase() : parsed.kind === 'address' ? parsed.address : parsed.id;
  return `${parsed.kind}:${norm}:${limit}`;
}

export function parseLimit(raw) {
  if (raw == null || raw === '') return 100;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= 250 ? n : null;
}

/** mask=1|true masks logins/handles/ids server-side (for auto-run feeds); absent, '' or 0|false = off. */
export function parseMask(raw) {
  if (raw == null || raw === '' || raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  return null;
}

const lookupCache = new TtlCache({ max: 300 });

/**
 * GET /api/lookup?q=&limit=&mask=
 * The cache holds the unmasked result; mask=1 is applied on the way out, so both views share one upstream run.
 * @param {URL} url
 * @param {{ lookup?: typeof libLookup, options?: () => Promise<object>, cache?: TtlCache }} deps
 */
export async function lookupResponse(url, deps = {}) {
  const { lookup = libLookup, options, cache = lookupCache, maxLimit = 250 } = deps;
  try {
    const q = (url.searchParams.get('q') ?? '').trim();
    const parsed = parseQuery(q);
    const asked = parseLimit(url.searchParams.get('limit'));
    const mask = parseMask(url.searchParams.get('mask'));
    if (parsed.kind === 'invalid') throw new PayblameError('BAD_INPUT', BAD_INPUT);
    if (asked === null) throw new PayblameError('BAD_INPUT', 'limit must be an integer from 1 to 250');
    if (mask === null) throw new PayblameError('BAD_INPUT', 'mask must be 1 or 0');
    // A host with a small CPU budget (Cloudflare Workers Free) lists fewer coin lines; the count stays exact
    // and totals.truncated says the list is cut. meta.limitCap tells the caller its limit was lowered.
    const limit = Math.min(asked, maxLimit);
    const view = (body) => (mask ? maskLookup(body) : body);
    const capped = (body) => (asked > limit && body.kind === 'recipient' ? { ...body, meta: { ...body.meta, limitCap: limit } } : body);
    const key = cacheKey(parsed, limit);
    const hit = cache.get(key);
    if (hit) {
      const body = { ...hit.body, meta: { ...hit.body.meta, cached: true } };
      return json(view(capped(body)), 200, hit.ttl);
    }
    const body = await cache.once(key, async () => {
      const opts = options ? await options() : {};
      return lookup(q, { ...opts, limit });
    });
    const ttl = body.kind === 'coin' ? TTL.coin : TTL.recipient;
    cache.set(key, { body, ttl }, ttl);
    return json(view(capped(body)), 200, ttl);
  } catch (e) {
    return errorResponse(e, deps.log);
  }
}

const ledgerMemo = new TtlCache({ max: 2 });

/** Seconds since the snapshot was taken, at response time (the memo and HTTP caches keep the body a while). */
const withAge = (body, now) => ({ ...body, ageSeconds: Math.max(0, Math.round((now() - Date.parse(body.snapshotAt)) / 1000)) });

/**
 * The /api/ledger answer before any snapshot exists (only where requests never build one: Cloudflare).
 * Same shape as a ledger, with no numbers: github/accounts/x are null and the row lists are empty, so the
 * site prints its "no snapshot" state; warmingUp: true says why, and progress how far the first scan is.
 */
export function warmingUpLedger(progress = null) {
  return {
    snapshotAt: null,
    warmingUp: true,
    progress,
    ageSeconds: null,
    source: 'getProgramAccounts pump_fees SocialFeePda',
    rentExemptLamports: null,
    accounts: null,
    github: null,
    x: null,
    topUnclaimed: [],
    topClaimed: [],
    recentClaims: [],
    blame: ['# payblame --ledger warming up: no snapshot yet. the scheduled scan (every 15 min) writes the first one.'],
    logins: 'masked',
    loginsNote: 'Logins are masked in the ledger. A real login is shown only for a specific lookup (payblame <login|ghid:id|wallet|mint>).',
  };
}

/**
 * GET /api/ledger: the snapshot the cron stores, with its age (ageSeconds).
 * With `build` (Netlify): computed on demand when missing or older than 60 min.
 * Without `build` (Cloudflare: a request never runs the scan): the stored snapshot whatever its age, or
 * warmingUpLedger() (200, not cached) until the cron has written the first one.
 * Logins are never served here: every row goes through maskLedger (idempotent), so even a snapshot
 * stored before masking existed comes out masked. Real logins only come from /api/lookup?q=<that login>.
 * @param {{ store: {get(k):Promise<any>, setJSON(k,v):Promise<void>}, build?: () => Promise<object>, now?: () => number, memo?: TtlCache, maskSecret?: () => Promise<string|undefined>, progress?: () => Promise<object|null> }} deps
 */
export async function ledgerResponse(deps) {
  const { store, build, now = () => Date.now(), memo = ledgerMemo } = deps;
  const secret = async () => (deps.maskSecret ? deps.maskSecret() : undefined);
  try {
    const hot = memo.get('ledger');
    if (hot) return json(withAge(hot, now), 200, TTL.ledger);
    let snap = null;
    try { snap = await store.get(LEDGER_KEY); } catch { snap = null; }
    const age = snap?.snapshotAt ? now() - Date.parse(snap.snapshotAt) : Infinity;
    if (!build) {
      if (!snap?.snapshotAt) {
        let progress = null;
        try { progress = deps.progress ? await deps.progress() : null; } catch { progress = null; }
        return json(warmingUpLedger(progress), 200);
      }
    } else if (!snap || !(age < LEDGER_MAX_AGE_MS)) {
      try {
        const fresh = await memo.once('build', async () => maskLedger(await build(), { secret: await secret() }));
        try { await store.setJSON(LEDGER_KEY, fresh); } catch { /* serve it anyway */ }
        snap = fresh;
      } catch (e) {
        if (!snap) throw new PayblameError('UPSTREAM', 'Ledger snapshot unavailable', { cause: e });
        // an old snapshot beats an error: its snapshotAt tells the client how old it is
      }
    }
    const masked = maskLedger(snap, { secret: await secret() });
    memo.set('ledger', masked, Math.min(TTL.ledger, 300));
    return json(withAge(masked, now), 200, TTL.ledger);
  } catch (e) {
    if (e instanceof PayblameError) return errorResponse(new PayblameError('UPSTREAM', 'Ledger snapshot unavailable'), deps.log);
    return errorResponse(e, deps.log);
  }
}

/** Build a masked ledger with service options (used by the cron and the on-demand path). Never reveals. */
export async function buildLedgerWith(opts, maxLookups) {
  const ledger = await libBuildLedger({ ...opts, maxLookups, reveal: false });
  return JSON.parse(JSON.stringify(ledger));
}
