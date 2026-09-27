// The ledger scan in pages, one page per cron run, for hosts with a small CPU budget (Cloudflare Workers Free:
// 10 ms per invocation). One getProgramAccounts over all ~12k SocialFeePdas is a ~3.8 MB answer; parsing and
// ranking it takes ~15-25 ms of CPU. Helius' getProgramAccountsV2 returns the same accounts in pages, by a
// cursor (paginationKey), so each run reads one page, adds it to a running aggregate kept in the store, and
// the run that reads the last page publishes the snapshot. The result is the same ledger aggregateLedger()
// builds from one call (counts and sums add up; every global top-N row is in its page's top-N), taken over
// the minutes the sweep lasted: snapshotAt is when the sweep started, scan.completedAt when it ended.
//
// Store keys (store 'payblame'; none of them is ever served as is):
//   ledger/sweep   the sweep in progress: cursor, pages read, running aggregate (ids, no logins)
//   ledger/raw     the last complete aggregate, unmasked ids, no logins (to add GitHub account types later)
//   ledger/latest  the published snapshot, masked (LEDGER_KEY, what /api/ledger serves)
import { aggregateLedger, applyLogins, maskLedger, formatLedger, resolveIds, accountData, rentExempt, constants } from '../../src/index.js';
import { LEDGER_KEY } from './api.mjs';

export const SWEEP_KEY = 'ledger/sweep';
export const RAW_KEY = 'ledger/raw';
export const SWEEP_MAX_AGE_MS = 12 * 3600e3; // a sweep older than this (cron paused for hours) starts over
const { PUMP_FEES, DISC_B58, SOCIAL } = constants;
const LISTS = ['topUnclaimed', 'topClaimed', 'recentClaims'];
const TOP = { topUnclaimed: 25, topClaimed: 10, recentClaims: 15 };

const byPubkey = (a, b) => (a.socialFeePda < b.socialFeePda ? -1 : a.socialFeePda > b.socialFeePda ? 1 : 0);
const ms = (iso) => (iso ? Date.parse(iso) : 0);
// the same orders aggregateLedger ranks by, on its output rows
const ORDER = {
  topUnclaimed: (a, b) => b.unclaimedLamports - a.unclaimedLamports || byPubkey(a, b),
  topClaimed: (a, b) => b.totalClaimedLamports - a.totalClaimedLamports || byPubkey(a, b),
  recentClaims: (a, b) => ms(b.lastClaimedAt) - ms(a.lastClaimedAt) || byPubkey(a, b),
};

// 60 bytes, not fetchSocialFeePdas' 59: every field still ends by byte 59, and 60 is a multiple of 3, so each
// account is 80 base64 characters without padding and a whole page decodes in one Buffer.from call.
const SLICE = Math.ceil(SOCIAL.sliceLength / 3) * 3;
const B64 = (SLICE / 3) * 4;

/** One page of SocialFeePdas and the cursor for the next (null after the last page). */
export async function fetchPage(rpc, cursor, limit) {
  const r = await rpc.call('getProgramAccountsV2', [PUMP_FEES, {
    encoding: 'base64',
    commitment: 'confirmed',
    dataSlice: { offset: 0, length: SLICE },
    filters: [{ memcmp: { offset: 0, bytes: DISC_B58.SocialFeePda } }],
    limit,
    ...(cursor ? { paginationKey: cursor } : {}),
  }]);
  const list = Array.isArray(r?.accounts) ? r.accounts : [];
  const b64 = list.map((a) => (Array.isArray(a.account.data) ? a.account.data[0] : ''));
  let data;
  if (b64.every((s) => typeof s === 'string' && s.length === B64 && !s.endsWith('='))) {
    const all = accountData([b64.join(''), 'base64']);
    data = (i) => all.subarray(i * SLICE, (i + 1) * SLICE);
  } else {
    data = (i) => accountData(list[i].account.data); // an odd length somewhere: decode one by one
  }
  return { accounts: list.map(({ pubkey, account }, i) => ({ pubkey, lamports: account.lamports, data: data(i) })), next: r?.paginationKey || null };
}

const addUp = (a, b) => Object.fromEntries(Object.keys(b).map((k) => [k, (a?.[k] ?? 0) + b[k]]));

/** Fold one page's aggregateLedger() result into the running aggregate (pure). */
export function mergePage(acc, part) {
  const out = {
    accounts: addUp(acc?.accounts, part.accounts),
    github: addUp(acc?.github, part.github),
    x: addUp(acc?.x, part.x),
    skipped: (acc?.skipped ?? 0) + (part.skippedUndecodable ?? 0),
  };
  for (const k of LISTS) out[k] = [...(acc?.[k] ?? []), ...part[k]].sort(ORDER[k]).slice(0, TOP[k]);
  return out;
}

/** The finished ledger, keyed and formatted like aggregateLedger() output (rows unmasked, logins not applied). */
export function finishLedger(acc, { snapshotAt, rentExemptLamports, pages, pageSize, completedAt }) {
  const ledger = {
    snapshotAt,
    source: 'getProgramAccounts pump_fees SocialFeePda',
    rentExemptLamports,
    accounts: acc.accounts,
    github: acc.github,
    x: acc.x,
    topUnclaimed: acc.topUnclaimed,
    topClaimed: acc.topClaimed,
    recentClaims: acc.recentClaims,
    blame: [],
  };
  if (acc.skipped) ledger.skippedUndecodable = acc.skipped;
  ledger.scan = { method: 'getProgramAccountsV2', pages, pageSize, startedAt: snapshotAt, completedAt };
  ledger.blame = formatLedger(ledger);
  return ledger;
}

/** Masked snapshot from a raw ledger and the GitHub types known so far (never stores a login). */
export function publishable(raw, logins, secret) {
  const l = applyLogins(JSON.parse(JSON.stringify(raw)), logins);
  return JSON.parse(JSON.stringify(maskLedger(l, { secret })));
}

const rowsOf = (l) => (l ? LISTS.flatMap((k) => l[k] ?? []) : []);

/**
 * One cron run: read the next page, fold it in, publish when the sweep completes; then resolve up to
 * `githubPerRun` uncached GitHub ids of the shown rows and republish if that added account types.
 * @param {{ store: any, opts: object, pageSize: number, githubPerRun: number, now?: () => number }} p
 */
export async function sweepStep({ store, opts, pageSize, githubPerRun, now = () => Date.now() }) {
  const rpc = opts.rpc;
  let state = null;
  try { state = await store.get(SWEEP_KEY); } catch { state = null; }
  if (!state || !state.startedAt || now() - Date.parse(state.startedAt) > SWEEP_MAX_AGE_MS) {
    state = { startedAt: new Date(now()).toISOString(), cursor: null, pages: 0, scanned: 0, pageSize, rent: await rentExempt(rpc, 179), acc: null };
  }
  const page = await fetchPage(rpc, state.cursor, pageSize);
  const part = aggregateLedger(page.accounts, { rentExemptLamports: state.rent, snapshotAt: state.startedAt });
  state.acc = mergePage(state.acc, part);
  state.pages += 1;
  state.scanned += page.accounts.length;
  state.cursor = page.next;

  let raw = null;
  let published = false;
  const done = !page.next || page.accounts.length === 0;
  if (done) {
    raw = finishLedger(state.acc, { snapshotAt: state.startedAt, rentExemptLamports: state.rent, pages: state.pages, pageSize, completedAt: new Date(now()).toISOString() });
    await store.setJSON(RAW_KEY, raw);
    await store.delete(SWEEP_KEY);
  } else {
    await store.setJSON(SWEEP_KEY, state);
    try { raw = await store.get(RAW_KEY); } catch { raw = null; }
  }

  // GitHub account types for the rows on show (the last complete sweep, else the running aggregate).
  // Cached ids are free; at most githubPerRun are asked this run, and the cache carries them to the next.
  const ids = [...new Set(rowsOf(raw ?? state.acc).map((r) => r.githubId).filter(Boolean))];
  if (opts.cache?.prefetch) await opts.cache.prefetch(ids.map((id) => `gh/id/${id}`));
  let added = 0; // every id GitHub answered for (found or deleted) is written to the cache once
  const cache = opts.cache && { get: (k) => opts.cache.get(k), set: (k, v) => { if (k.startsWith('gh/id/')) added++; return opts.cache.set(k, v); } };
  const logins = await resolveIds(ids, { githubToken: opts.githubToken, fetch: opts.fetch, cache, max: githubPerRun, timeoutMs: opts.timeoutMs });
  const known = [...logins.values()].filter(Boolean).length;

  if (raw && (done || added > 0)) {
    await store.setJSON(LEDGER_KEY, publishable(raw, logins, opts.maskSecret));
    published = true;
  }
  return { page: state.pages, scanned: state.scanned, accounts: page.accounts.length, done, published, githubAdded: added, githubKnown: known, githubRows: ids.length };
}

/** For /api/ledger's warming-up answer: how far the first sweep has got. */
export async function sweepProgress(store) {
  const s = await store.get(SWEEP_KEY);
  return s ? { pages: s.pages, accountsScanned: s.scanned, startedAt: s.startedAt } : null;
}
