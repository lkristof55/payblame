// The network-wide ledger: every SocialFeePda in one getProgramAccounts call, aggregated.
// Logins are opt-in: buildLedger() masks every row unless it gets { reveal: true }.
import { createHmac, randomBytes } from 'node:crypto';
import { PUMP_FEES, DISC_B58, SOCIAL } from './constants.js';
import { accountData, isSocialFeePda } from './layout.js';
import { createRpc, rentExempt } from './rpc.js';
import { resolveIds, memoryCache } from './github.js';
import { formatLedger, LOGIN_MASK } from './format.js';

const defaultCache = memoryCache();
const utf8 = new TextDecoder();

// Little-endian u64 at o as a Number, the value Number(DataView.getBigUint64(o, true)) gives: exact below
// 2^53 (every lamport and timestamp field), through BigInt above it.
function u64(b, o) {
  const lo = (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
  const hi = (b[o + 4] | (b[o + 5] << 8) | (b[o + 6] << 16)) + b[o + 7] * 0x1000000;
  if (hi < 0x200000) return hi * 0x100000000 + lo;
  return Number((BigInt(hi) << 32n) | BigInt(lo));
}

/** Insert `row` into `list` (kept best-first, at most n long) if it ranks among the best n. */
function keepTop(list, n, row, better) {
  if (n <= 0 || (list.length === n && !better(row, list[n - 1]))) return;
  let i = list.length < n ? list.push(row) - 1 : n - 1;
  while (i > 0 && better(row, list[i - 1])) { list[i] = list[i - 1]; i--; }
  list[i] = row;
}
// descending by the key, then ascending by pubkey (pubkeys are unique, so the order is total)
const rank = (key) => (a, b) => a[key] > b[key] || (a[key] === b[key] && a.pubkey < b.pubkey);
const byUnclaimed = rank('unclaimed');
const byTotalClaimed = rank('totalClaimed');
const byLastClaimed = rank('lastClaimed');

/**
 * Aggregate decoded SocialFeePda accounts (pure).
 * Reads the fields decodeSocialFeePda reads (same checks: discriminator, user_id length <= 20, length) straight
 * from the bytes, decodes a user_id only for the rows it returns, and keeps the top lists as it goes instead of
 * sorting every GitHub account: the network ledger runs this over every SocialFeePda.
 * @param {{ pubkey: string, lamports: number, data: Uint8Array }[]} accounts
 * @param {{ rentExemptLamports: number, snapshotAt?: string, top?: number, topClaimed?: number, recent?: number }} opts
 */
export function aggregateLedger(accounts, { rentExemptLamports, snapshotAt = new Date().toISOString(), top = 25, topClaimed = 10, recent = 15 }) {
  const counts = { total: 0, github: 0, x: 0, pump: 0, other: 0 };
  const github = { accounts: 0, everClaimed: 0, neverClaimed: 0, neverClaimedOver1Sol: 0, unclaimedLamports: 0, unclaimedNeverClaimedLamports: 0, totalClaimedLamports: 0 };
  const x = { accounts: 0, unclaimedLamports: 0, totalClaimedLamports: 0 };
  const tops = { unclaimed: [], totalClaimed: [], lastClaimed: [] };
  const idAt = SOCIAL.userId + 4;
  let skipped = 0;
  for (const a of accounts) {
    const b = a.data;
    if (!b || b.length < idAt || !isSocialFeePda(b)) { skipped++; continue; }
    const len = (b[SOCIAL.userId] | (b[SOCIAL.userId + 1] << 8) | (b[SOCIAL.userId + 2] << 16)) + b[SOCIAL.userId + 3] * 0x1000000;
    if (len > SOCIAL.maxUserIdLen || b.length < idAt + len + 17) { skipped++; continue; }
    const o = idAt + len;
    const platform = b[o];
    const totalClaimed = u64(b, o + 1);
    const lastClaimed = u64(b, o + 9);
    counts.total++;
    const unclaimed = Math.max(0, a.lamports - rentExemptLamports);
    if (platform === 2) {
      counts.github++;
      github.accounts++;
      github.unclaimedLamports += unclaimed;
      github.totalClaimedLamports += totalClaimed;
      if (lastClaimed > 0 || totalClaimed > 0) github.everClaimed++;
      else {
        github.neverClaimed++;
        github.unclaimedNeverClaimedLamports += unclaimed;
        if (unclaimed > 1e9) github.neverClaimedOver1Sol++;
      }
      const r = { pubkey: a.pubkey, b, len, unclaimed, totalClaimed, lastClaimed };
      keepTop(tops.unclaimed, top, r, byUnclaimed);
      keepTop(tops.totalClaimed, topClaimed, r, byTotalClaimed);
      if (lastClaimed > 0) keepTop(tops.lastClaimed, recent, r, byLastClaimed);
    } else if (platform === 1) {
      counts.x++;
      x.accounts++;
      x.unclaimedLamports += unclaimed;
      x.totalClaimedLamports += totalClaimed;
    } else if (platform === 0) counts.pump++;
    else counts.other++;
  }
  const row = (r) => ({
    githubId: utf8.decode(r.b.subarray(idAt, idAt + r.len)), login: null, accountType: null, githubDeleted: false, socialFeePda: r.pubkey,
    unclaimedLamports: r.unclaimed, totalClaimedLamports: r.totalClaimed,
    lastClaimedAt: r.lastClaimed > 0 ? new Date(r.lastClaimed * 1000).toISOString() : null,
  });
  const ledger = {
    snapshotAt,
    source: 'getProgramAccounts pump_fees SocialFeePda',
    rentExemptLamports,
    accounts: counts,
    github,
    x,
    topUnclaimed: tops.unclaimed.map(row),
    topClaimed: tops.totalClaimed.map(row),
    recentClaims: tops.lastClaimed.map(row),
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
// Made on first use, not at import: some runtimes (Cloudflare Workers) refuse random bytes in global scope.
let processSecretBytes = null;
const processSecret = () => (processSecretBytes ??= randomBytes(32));

/** Stable, non-reversible row id: 'row:' + the first 8 hex of HMAC-SHA256(secret, socialFeePda). */
export function ledgerRowId(socialFeePda, secret = processSecret()) {
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
export function maskLedger(ledger, { secret = processSecret() } = {}) {
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
