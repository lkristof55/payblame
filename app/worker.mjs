// Cloudflare Workers entry (wrangler.jsonc). The same Netlify v2 functions, routed by their config.path:
//   fetch():     /api/* -> the function whose config.path matches, called as (Request, context);
//                anything else -> the static site (env.ASSETS: site/dist, 404.html for unknown paths).
//   scheduled(): ledger-cron, the one scheduled function (config.schedule = the cron in wrangler.jsonc).
// Env: vars and secrets reach process.env through nodejs_compat (compatibility date >= 2025-04-01); the copy
// below only fills what is missing. env.DB (D1) backs lib/store.mjs in place of Netlify Blobs.
import * as health from './netlify/functions/health.mjs';
import * as ledger from './netlify/functions/ledger.mjs';
import * as lookup from './netlify/functions/lookup.mjs';
import * as ledgerCron from './netlify/functions/ledger-cron.mjs';
import { useD1 } from './lib/store.mjs';
import { setHost } from './lib/platform.mjs';

/** Netlify-style path pattern ('/api/x/:id', '/api/*') -> exec(pathname) -> params | null. */
export function compilePath(pattern) {
  const keys = [];
  const src = pattern.split('/').map((seg) => {
    if (seg === '*') return '.*';
    if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  const re = new RegExp(`^${src}$`);
  return (p) => { const m = re.exec(p); return m ? Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) : null; };
}

export const ROUTES = [['health', health], ['ledger', ledger], ['lookup', lookup]]
  .flatMap(([name, mod]) => [].concat(mod.config.path).map((p) => ({ name, path: p, match: compilePath(p), handler: mod.default })));
export const SCHEDULED = [{ name: 'ledger-cron', schedule: ledgerCron.config.schedule, handler: ledgerCron.default }];

/** Register the bindings before any handler runs: D1 for the store, string vars/secrets for process.env. */
export function setup(env = {}) {
  setHost('cloudflare');
  if (env.DB) useD1(env.DB);
  try {
    for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && process.env[k] === undefined) process.env[k] = v;
  } catch { /* process.env is read-only here: nodejs_compat already populated it */ }
}

/** What a Netlify function gets as its second argument, from the Workers request and execution context. */
export function context(request, ctx, params = {}) {
  const url = new URL(request.url);
  const cf = request.cf || {};
  return {
    params,
    ip: request.headers.get('cf-connecting-ip') || '',
    geo: { city: cf.city, country: cf.country ? { code: cf.country } : undefined, subdivision: cf.regionCode ? { code: cf.regionCode } : undefined, timezone: cf.timezone, latitude: cf.latitude != null ? Number(cf.latitude) : undefined, longitude: cf.longitude != null ? Number(cf.longitude) : undefined },
    site: { url: url.origin },
    requestId: request.headers.get('cf-ray') || '',
    waitUntil: (p) => ctx?.waitUntil?.(p),
    cookies: { get: () => undefined, set() {}, delete() {} },
  };
}

export default {
  async fetch(request, env, ctx) {
    setup(env);
    const { pathname } = new URL(request.url);
    for (const r of ROUTES) {
      const params = r.match(pathname);
      if (!params) continue;
      try {
        const res = await r.handler(request, context(request, ctx, params));
        return res instanceof Response ? res : Response.json(res ?? null);
      } catch (e) {
        console.error(`[${r.name}] ${e?.name}: ${String(e?.message).replace(/api-key=[^&\s]+/g, 'api-key=***')}`);
        return Response.json({ error: 'function crashed', code: 'UPSTREAM' }, { status: 500 });
      }
    }
    return env.ASSETS.fetch(request);
  },

  // Awaited, not handed to waitUntil: the invocation ends when the job does (its CPU and subrequests count
  // against this invocation either way).
  async scheduled(controller, env, ctx) {
    setup(env);
    for (const job of SCHEDULED) {
      const req = new Request(`https://worker.invalid/.netlify/functions/${job.name}`, { method: 'POST', body: JSON.stringify({ next_run: null, cron: controller?.cron ?? null }) });
      await job.handler(req, context(req, ctx));
    }
  },
};
