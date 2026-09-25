// Minimal Solana JSON-RPC client: timeout per request, retry with backoff on 429/503, call counting.
// Pass `fetch` to record or replay traffic (the tests replay recorded mainnet responses).
import { PayblameError } from './errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ rpcUrl: string, fetch?: typeof fetch, timeoutMs?: number, retries?: number }} opts
 */
export function createRpc({ rpcUrl, fetch: f = globalThis.fetch, timeoutMs = 8000, retries = 3 } = {}) {
  if (!rpcUrl) throw new PayblameError('UPSTREAM', 'No RPC URL configured (set PAYBLAME_RPC_URL)');
  let id = 0;
  const stats = { calls: 0, credits: 0 };
  // Helius pricing (2026): getProgramAccounts and DAS calls 10 credits, other RPC methods 1.
  const creditCost = (m) => (m === 'getProgramAccounts' || /^get(Asset|Assets)/.test(m) ? 10 : 1);

  async function call(method, params) {
    stats.calls++;
    stats.credits += creditCost(method);
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params });
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await f(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        throw new PayblameError('UPSTREAM', 'Solana RPC did not answer in time', { cause: e });
      }
      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 4000) : 250 * 3 ** attempt);
        continue;
      }
      if (!res.ok) throw new PayblameError('UPSTREAM', `Solana RPC answered HTTP ${res.status}`);
      let json;
      try { json = await res.json(); } catch (e) { throw new PayblameError('UPSTREAM', 'Solana RPC sent invalid JSON', { cause: e }); }
      if (json.error) {
        if (json.error.code === 429 && attempt < retries) { await sleep(250 * 3 ** attempt); continue; }
        throw new PayblameError('UPSTREAM', `Solana RPC error on ${method}: ${String(json.error.message || json.error.code).slice(0, 120)}`);
      }
      return json.result;
    }
  }

  /** getMultipleAccounts in batches of 100 keys, results in input order (null for missing accounts). */
  async function getMultipleAccounts(keys, { dataSlice, encoding = 'base64' } = {}) {
    const batches = [];
    for (let i = 0; i < keys.length; i += 100) batches.push(keys.slice(i, i + 100));
    const cfg = { encoding, commitment: 'confirmed', ...(dataSlice ? { dataSlice } : {}) };
    const out = await Promise.all(batches.map((b) => call('getMultipleAccounts', [b, cfg])));
    return out.flatMap((r) => r.value);
  }

  const getAccountInfo = async (key, cfg = {}) => (await call('getAccountInfo', [key, { encoding: 'base64', commitment: 'confirmed', ...cfg }])).value;
  const getProgramAccounts = (program, cfg) => call('getProgramAccounts', [program, { encoding: 'base64', commitment: 'confirmed', ...cfg }]);
  const getMinimumBalanceForRentExemption = (size) => call('getMinimumBalanceForRentExemption', [size]);
  // Helius DAS (Digital Asset Standard) extensions over the same endpoint.
  const getAsset = (id) => call('getAsset', { id });
  const getAssetBatch = (ids) => call('getAssetBatch', { ids });

  return { call, stats, getMultipleAccounts, getAccountInfo, getProgramAccounts, getMinimumBalanceForRentExemption, getAsset, getAssetBatch };
}

// Rent-exempt minimums change rarely; cache per process for an hour, keyed by size.
const rentCache = new Map();
export async function rentExempt(rpc, size) {
  const hit = rentCache.get(size);
  if (hit && Date.now() - hit.at < 3600e3) return hit.value;
  const value = await rpc.getMinimumBalanceForRentExemption(size);
  rentCache.set(size, { at: Date.now(), value });
  return value;
}
export function clearRentCache() { rentCache.clear(); }
