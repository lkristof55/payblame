// The network-wide ledger: every SocialFeePda in one getProgramAccounts call, aggregated.
// Logins are opt-in: buildLedger() masks every row unless it gets { reveal: true }.
import { createHmac, randomBytes } from 'node:crypto';
import { PUMP_FEES, DISC_B58, SOCIAL } from './constants.js';
import { accountData, decodeSocialFeePda } from './layout.js';
import { createRpc, rentExempt } from './rpc.js';
import { resolveIds, memoryCache } from './github.js';
import { formatLedger, LOGIN_MASK } from './format.js';

const defaultCache = memoryCache();
const byPubkey = (a, b) => (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0);

/**
 * Aggregate decoded SocialFeePda accounts (pure).
 * @param {{ pubkey: string, lamports: number, data: Uint8Array }[]} accounts
 * @param {{ rentExemptLamports: number, snapshotAt?: string, top?: number, topClaimed?: number, recent?: number }} opts
 */
export function aggregateLedger(accounts, { rentExemptLamports, snapshotAt = new Date().toISOString(), top = 25, topClaimed = 10, recent = 15 }) {
  const counts = { total: 0, github: 0, x: 0, pump: 0, other: 0 };
  const github = { accounts: 0, everClaimed: 0, neverClaimed: 0, neverClaimedOver1Sol: 0, unclaimedLamports: 0, unclaimedNeverClaimedLamports: 0, totalClaimedLamports: 0 };
  const x = { accounts: 0, unclaimedLamports: 0, totalClaimedLamports: 0 };
  const gh = [];
  let skipped = 0;
  for (const a of accounts) {
    let d;
    try { d = decodeSocialFeePda(a.data); } catch { skipped++; continue; }
    counts.total++;
    const unclaimed = Math.max(0, a.lamports - rentExemptLamports);
    if (d.platform === 2) {
      counts.github++;
      const ever = d.lastClaimed > 0 || d.totalClaimed > 0;
      github.accounts++;
      github.unclaimedLamports += unclaimed;
      github.totalClaimedLamports += d.totalClaimed;
      if (ever) github.everClaimed++;
      else {
        github.neverClaimed++;
        github.unclaimedNeverClaimedLamports += unclaimed;
        if (unclaimed > 1e9) github.neverClaimedOver1Sol++;
      }
      gh.push({ pubkey: a.pubkey, userId: d.userId, unclaimed, totalClaimed: d.totalClaimed, lastClaimed: d.lastClaimed });
    } else if (d.platform === 1) {
      counts.x++;
      x.accounts++;
      x.unclaimedLamports += unclaimed;
      x.totalClaimedLamports += d.totalClaimed;
    } else if (d.platform === 0) counts.pump++;
    else counts.other++;
  }
  const row = (r) => ({
    githubId: r.userId, login: null, accountType: null, githubDeleted: false, socialFeePda: r.pubkey,
    unclaimedLamports: r.unclaimed, totalClaimedLamports: r.totalClaimed,
    lastClaimedAt: r.lastClaimed > 0 ? new Date(r.lastClaimed * 1000).toISOString() : null,
  });
  const topN = (key, n, filter = () => true) => gh.filter(filter).sort((a, b) => b[key] - a[key] || byPubkey(a, b)).slice(0, n).map(row);
  const ledger = {
    snapshotAt,
    source: 'getProgramAccounts pump_fees SocialFeePda',
    rentExemptLamports,
    accounts: counts,
    github,
    x,
    topUnclaimed: topN('unclaimed', top),
    topClaimed: topN('totalClaimed', topClaimed),
    recentClaims: topN('lastClaimed', recent, (r) => r.lastClaimed > 0),
    blame: [],
  };
  if (skipped) ledger.skippedUndecodable = skipped;
  ledger.blame = formatLedger(ledger);
  return ledger;
}

/** Fill login / accountType / githubDeleted on every row from a Map of id -> resolveId() result. */
export function applyLogins(ledger, logins) {
  for (const list of [ledger.topUnclaimed, ledger.topClaimed, ledger.recentClaims]) {
    for (const r of list) {
      const u = logins.get(r.githubId);
      if (u) { r.login = u.login ?? null; r.accountType = u.type ?? null; r.githubDeleted = !!u.deleted; }
    }
  }
  ledger.blame = formatLedger(ledger);
  return ledger;
}

// A per-process secret: row ids stay non-reversible, but change between processes unless a secret is passed.
const processSecret = randomBytes(32);

/** Stable, non-reversible row id: 'row:' + the first 8 hex of HMAC-SHA256(secret, socialFeePda). */
export function ledgerRowId(socialFeePda, secret = processSecret) {
  return `row:${createHmac('sha256', secret).update(socialFeePda).digest('hex').slice(0, 8)}`;
}

/**
 * Mask every row (pure, returns a copy). A masked row keeps the numbers and the User/Org type,
 * and replaces what identifies the account: login -> LOGIN_MASK, githubId -> null,
 * socialFeePda -> null (it decodes to the GitHub id), plus masked: true and rowId.
 * Idempotent: already-masked rows pass through (their login is reset to the current LOGIN_MASK, so a
 * snapshot stored under an older mask width prints the same as a fresh one).
 * @param {object} ledger
 * @param {{ secret?: string | Uint8Array }} [opts] same secret -> same row ids across snapshots
 */
export function maskLedger(ledger, { secret = processSecret } = {}) {
  const mask = (r) => (r.masked ? { ...r, login: LOGIN_MASK } : {
    ...r,
    githubId: null,
    login: LOGIN_MASK,
    socialFeePda: null,
    masked: true,
    rowId: ledgerRowId(r.socialFeePda, secret),
  });
  const out = {
    ...ledger,
    logins: 'masked',
    loginsNote: 'Logins are masked in the ledger. A real login is shown only for a specific lookup (payblame <login|ghid:id|wallet|mint>).',
    topUnclaimed: ledger.topUnclaimed.map(mask),
    topClaimed: ledger.topClaimed.map(mask),
    recentClaims: ledger.recentClaims.map(mask),
  };
  out.blame = formatLedger(out);
  return out;
}

/** Fetch every SocialFeePda (59-byte slice) in one call. */
export async function fetchSocialFeePdas(rpc) {
  const list = await rpc.getProgramAccounts(PUMP_FEES, {
    dataSlice: { offset: 0, length: SOCIAL.sliceLength },
    filters: [{ memcmp: { offset: 0, bytes: DISC_B58.SocialFeePda } }],
  });
  return list.map(({ pubkey, account }) => ({ pubkey, lamports: account.lamports, data: accountData(account.data) }));
}

/**
 * The whole-network ledger. Rows are masked unless opts.reveal is true (see maskLedger).
 * @param {{ rpcUrl?: string, rpc?: any, fetch?: typeof fetch, githubToken?: string, cache?: any, maxLookups?: number, timeoutMs?: number, reveal?: boolean, maskSecret?: string | Uint8Array }} [opts]
 */
export async function buildLedger(opts = {}) {
  const f = opts.fetch ?? globalThis.fetch;
  const rpc = opts.rpc ?? createRpc({ rpcUrl: opts.rpcUrl, fetch: f, timeoutMs: opts.timeoutMs ?? 20000 });
  const t0 = performance.now();
  const [accounts, rent179] = await Promise.all([fetchSocialFeePdas(rpc), rentExempt(rpc, 179)]);
  const ledger = aggregateLedger(accounts, { rentExemptLamports: rent179, snapshotAt: new Date().toISOString() });
  const ids = [...ledger.topUnclaimed, ...ledger.topClaimed, ...ledger.recentClaims].map((r) => r.githubId);
  const logins = await resolveIds(ids, { githubToken: opts.githubToken, fetch: f, cache: opts.cache ?? defaultCache, max: opts.maxLookups ?? 50, timeoutMs: opts.timeoutMs });
  applyLogins(ledger, logins); // resolved even when masked: the User/Org type stays visible
  if (opts.reveal) ledger.logins = 'revealed';
  const out = opts.reveal ? ledger : maskLedger(ledger, { secret: opts.maskSecret });
  Object.defineProperty(out, 'stats', { value: { rpcCalls: rpc.stats.calls, credits: rpc.stats.credits, ms: Math.round(performance.now() - t0) }, enumerable: false });
  return out;
}
