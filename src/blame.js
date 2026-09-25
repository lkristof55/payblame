// The two lookups: recipient -> every coin that pays it (the reverse index), and coin -> who it pays.
import { PUMP_FEES, PUMP, DISC_B58, SHARING, SYSTEM_PROGRAM, slotOffset, platformName } from './constants.js';
import { accountData, decodeSharingConfig, decodeSocialFeePda, decodeBondingCurve, tokenAmount, isMintAccount, isSharingConfig, isSocialFeePda } from './layout.js';
import { socialFeePda, sharingConfigPda, bondingCurvePda, creatorVaultPdas } from './pda.js';
import { parseQuery } from './query.js';
import { createRpc, rentExempt } from './rpc.js';
import { resolveLogin, resolveId, resolveIds, memoryCache } from './github.js';
import { extractDeclared, diffDeclared } from './declared.js';
import { formatBlame, formatCoin, ticker } from './format.js';
import { PayblameError } from './errors.js';
import { encodeBase58 } from './base58.js';

const BAD_INPUT = 'q must be a GitHub login, github:<login>, ghid:<id>, x:<id>, a wallet or a mint';
const now = () => performance.now();
const ms = (a, b) => Math.round(b - a);
const isoFromUnix = (s) => (s > 0 ? new Date(s * 1000).toISOString() : null);
const defaultCache = memoryCache();

/**
 * Shared option handling.
 * @typedef {{ rpcUrl?: string, rpc?: ReturnType<typeof createRpc>, githubToken?: string,
 *   fetch?: typeof fetch, cache?: {get(k:string):Promise<any>, set(k:string,v:any):Promise<void>}, timeoutMs?: number }} Options
 */
function context(opts = {}) {
  const f = opts.fetch ?? globalThis.fetch;
  const rpc = opts.rpc ?? createRpc({ rpcUrl: opts.rpcUrl, fetch: f, timeoutMs: opts.timeoutMs });
  const gh = { githubToken: opts.githubToken, fetch: f, cache: opts.cache ?? defaultCache, timeoutMs: opts.timeoutMs };
  return { rpc, gh, fetch: f, timeoutMs: opts.timeoutMs ?? 8000 };
}

function meta(ctx, t0, timing, cached = false) {
  return { fetchedAt: new Date().toISOString(), cached, timingMs: { resolve: 0, probes: 0, accounts: 0, metadata: 0, ...timing, total: ms(t0, now()) }, rpcCalls: ctx.rpc.stats.calls };
}

/**
 * One input box: parse `q`, classify base58 addresses with one getAccountInfo, and dispatch.
 * @param {string} q
 * @param {Options & { limit?: number }} [opts]
 * @returns {Promise<object>} RecipientBlame | CoinBlame
 */
export async function lookup(q, opts = {}) {
  const parsed = parseQuery(q);
  if (parsed.kind === 'invalid') throw new PayblameError('BAD_INPUT', BAD_INPUT);
  const ctx = context(opts);
  const t0 = now();
  if (parsed.kind !== 'address') return blameRecipient(parsed, { ...opts, rpc: ctx.rpc }, { t0, query: q.trim() });
  if (parsed.address === SYSTEM_PROGRAM) throw new PayblameError('BAD_INPUT', 'The all-zero address matches every empty shareholder slot; it is not a recipient');
  // 200 bytes is enough to see a mint (82 bytes, or AccountType at byte 165) and any pump_fees header.
  const account = await ctx.rpc.getAccountInfo(parsed.address, { dataSlice: { offset: 0, length: 200 } });
  const resolveMs = ms(t0, now());
  if (isMintAccount(account)) return blameCoin(parsed.address, { ...opts, rpc: ctx.rpc }, { t0, resolveMs, query: q.trim() });
  if (account && account.owner === PUMP_FEES) {
    const b = accountData(account.data);
    // A SharingConfig address: blame the coin it belongs to (mint @11).
    if (isSharingConfig(b) && b.length >= SHARING.mint + 32) {
      const mint = encodeBase58(b.subarray(SHARING.mint, SHARING.mint + 32));
      return blameCoin(mint, { ...opts, rpc: ctx.rpc }, { t0, resolveMs, query: q.trim() });
    }
  }
  return blameRecipient({ kind: 'address', address: parsed.address, account }, { ...opts, rpc: ctx.rpc }, { t0, resolveMs, query: q.trim() });
}

// ---------------------------------------------------------------- recipient path

/** The reverse index: 10 memcmp probes, one per shareholder slot, pubkeys only. */
export async function probeSharingConfigs(rpc, recipient) {
  const probes = await Promise.all(Array.from({ length: SHARING.maxShareholders }, (_, i) =>
    rpc.getProgramAccounts(PUMP_FEES, {
      dataSlice: { offset: 0, length: 0 },
      filters: [{ memcmp: { offset: 0, bytes: DISC_B58.SharingConfig } }, { memcmp: { offset: slotOffset(i), bytes: recipient } }],
    })));
  const slotOf = new Map();
  const hitsPerSlot = probes.map((list) => list.length);
  probes.forEach((list, i) => { for (const { pubkey } of list) if (!slotOf.has(pubkey)) slotOf.set(pubkey, i); });
  return { slotOf, hitsPerSlot };
}

/** Pending creator fees in a coin's two vaults: max(0, pump vault - rentExempt(0)) + PumpSwap WSOL vault. */
export function pendingFromVaults(pumpVaultLamports, ammVaultLamports, rent0) {
  return Math.max(0, pumpVaultLamports - rent0) + ammVaultLamports;
}

/** Build one CoinLine (pure). */
export function coinLine({ sharingConfig, config, recipient, pumpVaultLamports, ammVaultLamports, ammVaultExists, rent0, asset }) {
  const slot = config.shareholders.findIndex((s) => s.address === recipient);
  if (slot < 0) return null;
  const bps = config.shareholders[slot].bps;
  const pendingLamports = pendingFromVaults(pumpVaultLamports, ammVaultLamports, rent0);
  return {
    mint: config.mint,
    symbol: asset?.symbol ?? null,
    name: asset?.name ?? null,
    sharingConfig,
    slot,
    shareholderCount: config.shareholders.length,
    bps,
    status: config.status,
    version: config.version,
    admin: config.admin,
    adminRevoked: config.adminRevoked,
    pumpVaultLamports,
    ammVaultLamports,
    ammVaultExists,
    pendingLamports,
    pendingForRecipientLamports: Math.floor((pendingLamports * bps) / 10000),
    coRecipients: config.shareholders.filter((_, i) => i !== slot).map((s) => ({ address: s.address, bps: s.bps })),
  };
}

export const sortCoinLines = (lines) => lines.sort((a, b) => b.pendingForRecipientLamports - a.pendingForRecipientLamports || (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));

function assetMeta(a) {
  if (!a) return null;
  const md = a.content?.metadata || {};
  const name = md.name || null;
  const symbol = ticker(md.symbol || a.token_info?.symbol || null);
  const description = typeof md.description === 'string' ? md.description : null;
  return { name, symbol, description };
}

/** Recipient account figures from its SocialFeePda (or the wallet's lamports). */
export function recipientAccount(type, account, rent179) {
  if (type === 'wallet') {
    return { exists: !!account, lamports: account?.lamports ?? 0, unclaimedLamports: null, totalClaimedLamports: null, lastClaimedAt: null, everClaimed: null, receivedLamports: null };
  }
  const b = account ? accountData(account.data) : null;
  if (!account || !isSocialFeePda(b)) {
    return { exists: false, lamports: account?.lamports ?? 0, unclaimedLamports: 0, totalClaimedLamports: 0, lastClaimedAt: null, everClaimed: false, receivedLamports: 0 };
  }
  const d = decodeSocialFeePda(b);
  const unclaimed = Math.max(0, account.lamports - rent179);
  return {
    exists: true,
    lamports: account.lamports,
    unclaimedLamports: unclaimed,
    totalClaimedLamports: d.totalClaimed,
    lastClaimedAt: isoFromUnix(d.lastClaimed),
    everClaimed: d.lastClaimed > 0 || d.totalClaimed > 0,
    receivedLamports: d.totalClaimed + unclaimed,
  };
}

/**
 * Every coin whose SharingConfig pays a recipient.
 * @param {string | {kind:'github',login:string}|{kind:'ghid',id:string}|{kind:'x',id:string}|{kind:'address',address:string,account?:any}} input
 * @param {Options & { limit?: number }} [opts]
 */
export async function blameRecipient(input, opts = {}, internal = {}) {
  const parsed = typeof input === 'string' ? parseQuery(input) : input;
  if (!parsed || parsed.kind === 'invalid') throw new PayblameError('BAD_INPUT', BAD_INPUT);
  const ctx = context(opts);
  const limit = Math.max(1, Math.min(250, Math.floor(Number(opts.limit ?? 100)) || 100));
  const t0 = internal.t0 ?? now();
  const timing = { resolve: internal.resolveMs ?? 0 };
  const query = internal.query ?? (typeof input === 'string' ? input.trim() : '');

  // 1. resolve the recipient address
  let recipient;
  let account; // undefined = not fetched yet
  let loginPromise = null;
  const tr = now();
  if (parsed.kind === 'github') {
    const u = await resolveLogin(parsed.login, ctx.gh);
    if (!u) throw new PayblameError('GITHUB_NOT_FOUND', `GitHub user ${parsed.login} not found`);
    recipient = { type: 'github', address: socialFeePda(u.id, 2), platform: 'github', userId: u.id, login: u.login, accountType: u.type ?? null, githubDeleted: false };
  } else if (parsed.kind === 'ghid' || parsed.kind === 'x') {
    const p = parsed.kind === 'x' ? 1 : 2;
    recipient = { type: parsed.kind === 'x' ? 'x' : 'github', address: socialFeePda(parsed.id, p), platform: platformName(p), userId: parsed.id, login: null, accountType: null, githubDeleted: false };
    if (p === 2) loginPromise = resolveId(parsed.id, ctx.gh);
  } else if (parsed.kind === 'address') {
    if (parsed.address === SYSTEM_PROGRAM) throw new PayblameError('BAD_INPUT', 'The all-zero address matches every empty shareholder slot; it is not a recipient');
    account = parsed.account;
    if (account === undefined) account = await ctx.rpc.getAccountInfo(parsed.address);
    const b = account && account.owner === PUMP_FEES ? accountData(account.data) : null;
    if (b && isSocialFeePda(b)) {
      const d = decodeSocialFeePda(b);
      const type = d.platform === 2 ? 'github' : d.platform === 1 ? 'x' : 'social';
      recipient = { type, address: parsed.address, platform: platformName(d.platform), userId: d.userId, login: null, accountType: null, githubDeleted: false };
      if (d.platform === 2) loginPromise = resolveId(d.userId, ctx.gh);
    } else {
      recipient = { type: 'wallet', address: parsed.address, platform: null, userId: null, login: null, accountType: null, githubDeleted: false };
    }
  } else {
    throw new PayblameError('BAD_INPUT', BAD_INPUT);
  }
  timing.resolve += ms(tr, now());

  // 2. probes, in parallel with the recipient's own account and the rent constants
  const tp = now();
  const [{ slotOf, hitsPerSlot }, acct, rent0, rent179] = await Promise.all([
    probeSharingConfigs(ctx.rpc, recipient.address),
    account !== undefined ? account : ctx.rpc.getAccountInfo(recipient.address),
    rentExempt(ctx.rpc, 0),
    recipient.type === 'wallet' ? 0 : rentExempt(ctx.rpc, 179),
  ]);
  timing.probes = ms(tp, now());

  // 3. decode the first `limit` configs (by address, deterministic) and read their vaults
  const all = [...slotOf.keys()].sort();
  const chosen = all.slice(0, limit);
  const ta = now();
  const cfgAccs = chosen.length ? await ctx.rpc.getMultipleAccounts(chosen, { dataSlice: { offset: 0, length: SHARING.sliceLength } }) : [];
  const configs = [];
  chosen.forEach((pk, i) => {
    const acc = cfgAccs[i];
    if (!acc || acc.owner !== PUMP_FEES) return;
    try { configs.push({ sharingConfig: pk, config: decodeSharingConfig(accountData(acc.data)), vaults: creatorVaultPdas(pk) }); } catch { /* not decodable: skip */ }
  });
  const vaultKeys = configs.flatMap((c) => [c.vaults.pumpVault, c.vaults.ammVaultAta]);
  const tm = now();
  const [vaultAccs, assets, loginInfo] = await Promise.all([
    vaultKeys.length ? ctx.rpc.getMultipleAccounts(vaultKeys, { dataSlice: { offset: 64, length: 8 } }) : [],
    configs.length ? ctx.rpc.getAssetBatch(configs.map((c) => c.config.mint)).catch(() => null) : [],
    loginPromise ?? null,
  ]);
  timing.accounts = ms(ta, now());
  timing.metadata = ms(tm, now());
  if (loginInfo) {
    recipient.login = loginInfo.login ?? null;
    recipient.accountType = loginInfo.type ?? null;
    recipient.githubDeleted = !!loginInfo.deleted;
  }
  const assetByMint = new Map();
  for (const a of Array.isArray(assets) ? assets : []) if (a?.id) assetByMint.set(a.id, assetMeta(a));

  const coins = [];
  configs.forEach((c, i) => {
    const pumpAcc = vaultAccs[2 * i];
    const ammAcc = vaultAccs[2 * i + 1];
    const line = coinLine({
      sharingConfig: c.sharingConfig,
      config: c.config,
      recipient: recipient.address,
      pumpVaultLamports: pumpAcc?.lamports ?? 0,
      ammVaultLamports: ammAcc ? tokenAmount(accountData(ammAcc.data)) : 0,
      ammVaultExists: !!ammAcc,
      rent0,
      asset: assetByMint.get(c.config.mint),
    });
    if (line) coins.push(line);
  });
  sortCoinLines(coins);

  const result = {
    kind: 'recipient',
    query,
    recipient,
    account: recipientAccount(recipient.type, acct, rent179),
    coins,
    totals: {
      coins: slotOf.size,
      listed: coins.length,
      truncated: slotOf.size > chosen.length,
      mutable: coins.filter((c) => !c.adminRevoked).length,
      pendingForRecipientLamports: coins.reduce((s, c) => s + c.pendingForRecipientLamports, 0),
    },
    probeHits: hitsPerSlot,
    blame: [],
    meta: null,
  };
  result.blame = formatBlame(result);
  result.meta = meta(ctx, t0, timing);
  return result;
}

// ---------------------------------------------------------------- coin path

/** DexScreener: the most liquid pair of a Solana token. Null on any failure (optional metadata). */
export async function dexPair(mint, { fetch: f = globalThis.fetch, timeoutMs = 8000 } = {}) {
  try {
    const res = await f(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const pairs = await res.json();
    if (!Array.isArray(pairs) || !pairs.length) return null;
    const p = pairs.reduce((best, x) => ((x.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? x : best), pairs[0]);
    const base = p.baseToken?.address === mint ? p.baseToken : p.quoteToken;
    return { marketCapUsd: p.marketCap ?? p.fdv ?? null, dexId: p.dexId ?? null, pairUrl: p.url ?? null, name: base?.name ?? null, symbol: ticker(base?.symbol ?? null) };
  } catch { return null; }
}

/** Classify decoded shareholders: SocialFeePda (github / x / other social) or plain wallet. */
export function classifyShareholders(shareholders, accounts, rent179) {
  return shareholders.map((s, i) => {
    const acc = accounts[i];
    const b = acc && acc.owner === PUMP_FEES ? accountData(acc.data) : null;
    if (b && isSocialFeePda(b)) {
      const d = decodeSocialFeePda(b);
      const unclaimed = Math.max(0, acc.lamports - rent179);
      return {
        address: s.address, bps: s.bps,
        kind: d.platform === 2 ? 'github' : d.platform === 1 ? 'x' : 'social',
        platform: d.platform, userId: d.userId, login: null, accountType: null, githubDeleted: false,
        unclaimedLamports: unclaimed, totalClaimedLamports: d.totalClaimed, lastClaimedAt: isoFromUnix(d.lastClaimed),
        everClaimed: d.lastClaimed > 0 || d.totalClaimed > 0,
        pendingForShareholderLamports: 0,
      };
    }
    return {
      address: s.address, bps: s.bps, kind: 'wallet', platform: null, userId: null, login: null, accountType: null, githubDeleted: false,
      unclaimedLamports: null, totalClaimedLamports: null, lastClaimedAt: null, everClaimed: null, pendingForShareholderLamports: 0,
    };
  });
}

/**
 * Who a coin pays: its SharingConfig split, each recipient's claim record, the pending vaults,
 * and a diff between the handles its metadata names and the on-chain recipients.
 * @param {string} mint
 * @param {Options} [opts]
 */
export async function blameCoin(mint, opts = {}, internal = {}) {
  const ctx = context(opts);
  const t0 = internal.t0 ?? now();
  const timing = { resolve: internal.resolveMs ?? 0 };
  const sharingConfig = sharingConfigPda(mint);
  const curveAddr = bondingCurvePda(mint);
  const v = creatorVaultPdas(sharingConfig);

  const tm = now();
  const metaP = Promise.all([
    ctx.rpc.getAsset(mint).then(assetMeta).catch(() => null),
    dexPair(mint, ctx),
  ]).then((r) => { timing.metadata = ms(tm, now()); return r; });

  const ta = now();
  const [accs, rent0, rent179] = await Promise.all([
    ctx.rpc.getMultipleAccounts([sharingConfig, curveAddr, v.pumpVault, v.ammVaultAta]),
    rentExempt(ctx.rpc, 0),
    rentExempt(ctx.rpc, 179),
  ]);
  let config = null;
  if (accs[0] && accs[0].owner === PUMP_FEES) {
    try { config = decodeSharingConfig(accountData(accs[0].data)); } catch { config = null; }
  }
  const curveDecoded = accs[1] && accs[1].owner === PUMP ? decodeBondingCurve(accountData(accs[1].data)) : null;
  if (!config && !curveDecoded) {
    await metaP.catch(() => null);
    throw new PayblameError('NOT_PUMP', 'Not a pump.fun mint: no bonding curve and no SharingConfig');
  }
  // Fees accrue to the vaults of the curve's creator: the SharingConfig for fee-shared coins,
  // the creator wallet for legacy coins.
  let vaults = v;
  let pumpAcc = accs[2];
  let ammAcc = accs[3];
  const creator = curveDecoded?.creator ?? sharingConfig;
  const extra = [];
  if (creator !== sharingConfig) {
    vaults = creatorVaultPdas(creator);
    extra.push(vaults.pumpVault, vaults.ammVaultAta);
  }
  const holders = config ? config.shareholders : [];
  const holderKeys = holders.map((s) => s.address);
  const more = extra.length || holderKeys.length
    ? await ctx.rpc.getMultipleAccounts([...extra, ...holderKeys], { dataSlice: { offset: 0, length: 72 } })
    : [];
  if (extra.length) { pumpAcc = more[0]; ammAcc = more[1]; }
  const holderAccs = more.slice(extra.length);
  timing.accounts = ms(ta, now());

  const pumpVaultLamports = pumpAcc?.lamports ?? 0;
  const ammVaultLamports = ammAcc ? tokenAmount(accountData(ammAcc.data)) : 0;
  const pendingLamports = pendingFromVaults(pumpVaultLamports, ammVaultLamports, rent0);

  let shareholders = classifyShareholders(holders, holderAccs, rent179);
  for (const s of shareholders) s.pendingForShareholderLamports = Math.floor((pendingLamports * s.bps) / 10000);
  const ghIds = shareholders.filter((s) => s.kind === 'github').map((s) => s.userId);
  const [[das, dex], logins] = await Promise.all([
    metaP,
    ghIds.length ? resolveIds(ghIds, { ...ctx.gh, max: 10 }) : new Map(),
  ]);
  for (const s of shareholders) {
    const u = s.kind === 'github' ? logins.get(s.userId) : null;
    if (u) { s.login = u.login ?? null; s.accountType = u.type ?? null; s.githubDeleted = !!u.deleted; }
  }

  const name = das?.name ?? dex?.name ?? null;
  const symbol = das?.symbol ?? dex?.symbol ?? null;
  const description = das?.description ?? null;
  const diffTargets = config
    ? shareholders
    : (curveDecoded?.creator ? [{ address: curveDecoded.creator, bps: 10000, kind: 'wallet' }] : []);
  const { declared, mismatch, diff } = diffDeclared(extractDeclared({ name, symbol, description }), diffTargets);

  const result = {
    kind: 'coin',
    query: internal.query ?? mint,
    mint,
    name,
    symbol,
    description: description ? description.slice(0, 280) : null,
    marketCapUsd: dex?.marketCapUsd ?? null,
    dexId: dex?.dexId ?? null,
    pairUrl: dex?.pairUrl ?? null,
    curve: { address: curveAddr, exists: !!curveDecoded, complete: curveDecoded ? curveDecoded.complete : null, creator: curveDecoded?.creator ?? null },
    feeSharing: !!config,
    sharingConfig,
    config: config ? { version: config.version, status: config.status, admin: config.admin, adminRevoked: config.adminRevoked, shareholders } : null,
    vaults: { pumpVault: vaults.pumpVault, pumpVaultLamports, ammVaultAta: vaults.ammVaultAta, ammVaultLamports, pendingLamports },
    declared,
    mismatch,
    diff,
    blame: [],
    meta: null,
  };
  result.blame = formatCoin(result, { rent0 });
  result.meta = meta(ctx, t0, timing);
  return result;
}
