// Which host runs the functions, and the per-invocation budgets that follow from it.
//   Netlify (and scripts/dev.mjs): the default. Nothing here changes how the functions behave there.
//   Cloudflare Workers: worker.mjs calls setHost('cloudflare') before any handler runs.
// On Cloudflare the Workers Free plan is assumed (10 ms CPU, 50 external subrequests per invocation,
// retries included) unless CF_FREE_PLAN=0, which means Workers Paid: the jobs then run in full, as on Netlify.
let host = 'netlify';

/** @param {'netlify'|'cloudflare'} h */
export function setHost(h) { host = h; }
export const onCloudflare = () => host === 'cloudflare';

const int = (v, d) => (typeof v === 'string' && /^\d{1,6}$/.test(v) ? Number(v) : d);

/**
 * @returns {{ free: boolean, fetches: number, rpcRetries: number, lookupMaxLimit: number, ledgerPageSize: number, githubPerRun: number }}
 *   fetches         hard cap on outgoing fetches per invocation (a fetch past it fails fast, like a timeout)
 *   rpcRetries      RPC retries on 429/503 (each retry is a subrequest, so it counts against `fetches`)
 *   lookupMaxLimit  most coin lines a recipient lookup decodes (the count stays exact; totals.truncated says so)
 *   ledgerPageSize  SocialFeePdas per cron run (getProgramAccountsV2 pages); 0 = one getProgramAccounts per run
 *   githubPerRun    GitHub id lookups per cron run (the 7-day cache carries the rest to the next run)
 */
export function budgets(env = process.env) {
  if (!onCloudflare()) return { free: false, fetches: Infinity, rpcRetries: 3, lookupMaxLimit: 250, ledgerPageSize: 0, githubPerRun: 50 };
  const free = env.CF_FREE_PLAN !== '0';
  return {
    free,
    fetches: free ? 45 : 1000,
    rpcRetries: 3, // Helius answers bursts of getProgramAccounts with 429; the fetch cap bounds the total
    lookupMaxLimit: Math.max(1, Math.min(250, int(env.LOOKUP_MAX_LIMIT, free ? 20 : 250))),
    ledgerPageSize: int(env.LEDGER_PAGE_SIZE, free ? 3000 : 0),
    githubPerRun: free ? 10 : 50,
  };
}

/**
 * A fetch that refuses to start the (max+1)th request of this invocation. The refusal is a rejected
 * promise, which the library already handles as an upstream failure (RPC: UPSTREAM; GitHub and
 * DexScreener lookups: null), so a burst of retries can never push an invocation past the plan's limit.
 */
export function budgetFetch(max, f = (...a) => globalThis.fetch(...a)) {
  let used = 0;
  const wrapped = (url, init) => {
    if (used >= max) return Promise.reject(new Error(`subrequest budget of ${max} reached`));
    used++;
    return f(url, init);
  };
  Object.defineProperty(wrapped, 'used', { get: () => used });
  return wrapped;
}
