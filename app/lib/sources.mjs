// Upstream configuration for the service. The wrappers themselves (timeouts, 429 backoff, call
// counting) live in the library at the repo root: src/rpc.js (Helius RPC + DAS), src/github.js
// (GitHub REST), src/blame.js dexPair() (DexScreener). This file only wires keys from process.env and the
// Blobs-backed GitHub id<->login cache.
import { randomBytes } from 'node:crypto';
import { PayblameError, createRpc } from '../../src/index.js';
import { getStore } from './store.mjs';
import { onCloudflare, budgets, budgetFetch } from './platform.mjs';

export const STORE = 'payblame';

/** Helius mainnet RPC URL. PAYBLAME_RPC_URL overrides it (any RPC that allows getProgramAccounts + memcmp). */
export function rpcUrl() {
  if (process.env.PAYBLAME_RPC_URL) return process.env.PAYBLAME_RPC_URL;
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new PayblameError('UPSTREAM', 'Solana RPC is not configured on the server');
  return `https://mainnet.helius-rpc.com/?api-key=${key}`;
}

/**
 * GitHub id<->login cache in the store (keys gh/login/<lower>, gh/id/<id>; 7-day TTL enforced by the library).
 * prefetch(keys) reads many keys in one query (D1) and serves them from memory afterwards.
 */
export async function githubCache() {
  const s = await getStore(STORE);
  const mem = new Map();
  return {
    get: async (k) => { if (mem.has(k)) return mem.get(k); try { return await s.get(k); } catch { return null; } },
    set: async (k, v) => { mem.set(k, v); try { await s.setJSON(k, v); } catch { /* cache is best effort */ } },
    prefetch: async (keys) => {
      try { const got = await s.getMany(keys); for (const k of keys) mem.set(k, got.get(k) ?? null); } catch { /* per-key reads then */ }
    },
  };
}

/**
 * Options every library call gets. On Cloudflare each call gets its own fetch budget (a fresh counter per
 * invocation, retries included) and an RPC client with the plan's retry count; on Netlify nothing changes.
 */
export async function libOptions(extra = {}) {
  const opts = { rpcUrl: rpcUrl(), githubToken: process.env.GITHUB_TOKEN || undefined, cache: await githubCache(), maskSecret: await maskSecret(), timeoutMs: 8000, ...extra };
  if (onCloudflare()) {
    const b = budgets();
    opts.fetch = budgetFetch(b.fetches);
    opts.rpc = createRpc({ rpcUrl: opts.rpcUrl, fetch: opts.fetch, timeoutMs: opts.timeoutMs, retries: b.rpcRetries });
  }
  return opts;
}

/**
 * Secret for the ledger's masked row ids (HMAC-SHA256(secret, socialFeePda)). LEDGER_MASK_SECRET if
 * set; otherwise a random secret generated once and kept in Blobs (key 'mask/secret'), so row ids
 * stay stable across snapshots and function instances. Never returned by any endpoint.
 */
let maskSecretMemo = null;
export async function maskSecret() {
  if (process.env.LEDGER_MASK_SECRET) return process.env.LEDGER_MASK_SECRET;
  if (maskSecretMemo) return maskSecretMemo;
  const s = await getStore(STORE);
  let v = null;
  try { v = (await s.get('mask/secret'))?.secret ?? null; } catch { v = null; }
  if (!v) {
    v = randomBytes(32).toString('hex');
    try { await s.setJSON('mask/secret', { secret: v }); } catch { /* per-instance secret: ids still non-reversible */ }
  }
  maskSecretMemo = v;
  return v;
}
