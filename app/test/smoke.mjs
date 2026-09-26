// Smoke test against a running server (npm run dev in another shell, with HELIUS_API_KEY set):
//   npm run smoke                               (http://localhost:8888)
//   npm run smoke -- http://localhost:8102      (any base URL, e.g. a deploy preview)
// One real mainnet request per endpoint, with inputs that are active today. Checks shape and timing.
const base = (process.argv[2] || process.env.SMOKE_URL || 'http://localhost:8888').replace(/\/$/, '');
const SOFT_MS = 10_000; // Netlify's synchronous function limit

async function get(path) {
  const t = Date.now();
  const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
  const ms = Date.now() - t;
  const body = await r.json().catch(() => null);
  return { r, body, ms };
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const isB58 = (s) => typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const ascii = (lines) => Array.isArray(lines) && lines.every((l) => typeof l === 'string' && /^[\x20-\x7e]*$/.test(l));

// The demo coin: its description names an X handle, its SharingConfig pays one GitHub account.
const DEMO_MINT = 'J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpump';

// A pump.fun mint that is being promoted on DexScreener right now (falls back to the demo mint).
async function activeMint() {
  try {
    const r = await fetch('https://api.dexscreener.com/token-boosts/latest/v1', { signal: AbortSignal.timeout(8000) });
    const list = await r.json();
    const hit = list.find((b) => b.chainId === 'solana' && /pump$/.test(b.tokenAddress));
    if (hit) return hit.tokenAddress;
  } catch { /* fall back */ }
  return DEMO_MINT;
}

function checkCoin(b, mint) {
  must(b.kind === 'coin' && b.mint === mint, 'kind/mint');
  must(isB58(b.sharingConfig) && isB58(b.curve.address), 'derived addresses');
  must(typeof b.feeSharing === 'boolean', 'feeSharing');
  must(b.feeSharing ? b.config && Array.isArray(b.config.shareholders) && b.config.shareholders.reduce((s, x) => s + x.bps, 0) === 10000 : b.config === null, 'config/bps sum');
  must(Number.isInteger(b.vaults.pendingLamports) && b.vaults.pendingLamports >= 0, 'vaults');
  must(Array.isArray(b.declared) && typeof b.mismatch === 'boolean' && Array.isArray(b.diff), 'diff fields');
  must(ascii(b.blame) && b.blame.length >= 1, 'blame lines');
  must(typeof b.meta?.timingMs?.total === 'number', 'meta');
  must(!(b.symbol ?? '').startsWith('$') && !b.blame[0].includes(' $$'), `sigil doubled: ${b.blame[0]}`);
}

const checks = [
  ['GET /api/health', async () => {
    const { body } = await get('/api/health');
    must(body?.ok === true && typeof body.keys === 'object' && 'tokenMint' in body, JSON.stringify(body));
    // keys are reported by name only; PAYBLAME_RPC_URL can stand in for HELIUS_API_KEY
    return `keys: ${Object.entries(body.keys).map(([k, v]) => `${k}=${v ? 'set' : 'unset'}`).join(' ')}, tokenMint=${body.tokenMint ?? 'null'}`;
  }],
  ['GET /api/ledger', async () => {
    const { r, body: l, ms } = await get('/api/ledger');
    must(r.status === 200, `status ${r.status} ${JSON.stringify(l)}`);
    must(l.accounts.total > 10000 && l.github.accounts > 10000, `accounts ${JSON.stringify(l.accounts)}`);
    must(l.github.everClaimed + l.github.neverClaimed === l.github.accounts, 'claimed split');
    must(l.topUnclaimed.length === 25 && l.topClaimed.length === 10 && l.recentClaims.length === 15, 'row counts');
    must(Date.now() - Date.parse(l.snapshotAt) < 3600e3 + 60e3, `snapshot too old ${l.snapshotAt}`);
    must(ascii(l.blame) && l.blame.length === 27, 'blame');
    // logins are opt-in: the ledger never carries a login, a GitHub id or a SocialFeePda
    const rows = [...l.topUnclaimed, ...l.topClaimed, ...l.recentClaims];
    must(l.logins === 'masked' && rows.every((x) => x.masked === true && x.login === '####' && x.githubId === null && x.socialFeePda === null && /^row:[0-9a-f]{8}$/.test(x.rowId)), 'rows not masked');
    must(/ logins=masked$/.test(l.blame[0]), 'line 1 logins=masked');
    must(l.blame.slice(2).every((x) => /^row:[0-9a-f]{8} \(github:#{4} +(user|org |\? {3})\) unclaimed=\d+\.\d{3} +claimed=\d+\.\d{3} +last=(never|\d{4}-\d\d-\d\d)$/.test(x)), `Format L rows: ${l.blame[2]}`);
    return `${l.github.accounts} github accounts, ${(l.github.unclaimedLamports / 1e9).toFixed(3)} SOL unclaimed, snapshot ${l.snapshotAt}, ${ms} ms`;
  }],
  ['GET /api/lookup recipient (the demo mint\'s GitHub fee recipient, by ghid; claims every few minutes)', async () => {
    // The recipient is taken from the demo coin's on-chain split, so no login is written into this file.
    const coin = (await get(`/api/lookup?q=${DEMO_MINT}`)).body;
    const holder = coin?.config?.shareholders?.find((x) => x.kind === 'github');
    must(holder && /^\d+$/.test(holder.userId), `demo coin has no GitHub shareholder: ${JSON.stringify(coin?.config)}`);
    const { r, body: b, ms } = await get(`/api/lookup?q=ghid:${holder.userId}&limit=24`);
    must(r.status === 200, `status ${r.status} ${JSON.stringify(b)}`);
    must(b.kind === 'recipient' && b.recipient.type === 'github' && b.recipient.userId === holder.userId, 'recipient');
    must(b.recipient.address === holder.address, 'social fee pda');
    must(b.totals.coins > 10000 && b.totals.listed <= 24 && b.totals.truncated === true, `totals ${JSON.stringify(b.totals)}`);
    must(b.account.exists && b.account.everClaimed === true && b.account.totalClaimedLamports > 1e13, 'account');
    must(b.coins.every((c) => isB58(c.mint) && c.bps > 0 && c.bps <= 10000 && Number.isInteger(c.pendingForRecipientLamports)), 'coin lines');
    must(ascii(b.blame) && b.blame.length === 2 + b.coins.length, 'blame');
    must(ms < SOFT_MS, `slow: ${ms} ms`);
    return `${b.totals.coins} coins, last claim ${b.account.lastClaimedAt}, ${b.meta.rpcCalls} rpc calls, ${ms} ms`;
  }],
  ['GET /api/lookup coin (DexScreener-boosted pump.fun mint, live today)', async () => {
    const mint = await activeMint();
    const { r, body: b, ms } = await get(`/api/lookup?q=${mint}`);
    must(r.status === 200, `status ${r.status} ${JSON.stringify(b)}`);
    checkCoin(b, mint);
    must(ms < SOFT_MS, `slow: ${ms} ms`);
    return `${mint.slice(0, 8)} $${b.symbol} feeSharing=${b.feeSharing}, ${ms} ms`;
  }],
  ['GET /api/lookup coin demo mint (declared vs on-chain diff)', async () => {
    const mint = DEMO_MINT;
    const { r, body: b, ms } = await get(`/api/lookup?q=${mint}`);
    must(r.status === 200, `status ${r.status}`);
    checkCoin(b, mint);
    const gh = b.config.shareholders.find((x) => x.kind === 'github');
    must(b.feeSharing && b.mismatch && b.diff.some((l) => /^- x:@\w+$/.test(l)) && gh && b.diff.includes(`+ github:${gh.login ?? `#${gh.userId}`} ${gh.bps}bps`), `diff ${JSON.stringify(b.diff)}`);
    return `mismatch, ${b.diff.length} diff lines, ${ms} ms`;
  }],
  ['GET /api/lookup demo mint ?mask=1 (auto-run view: no login, handle, id or SocialFeePda on the wire)', async () => {
    const mint = DEMO_MINT;
    const plain = (await get(`/api/lookup?q=${mint}`)).body;
    const { r, body: m, ms } = await get(`/api/lookup?q=${mint}&mask=1`);
    must(r.status === 200, `status ${r.status}`);
    checkCoin(m, mint);
    must(m.masked === true && m.logins === 'masked', 'masked flags');
    const wire = JSON.stringify(m);
    const secrets = [
      ...plain.config.shareholders.filter((x) => x.kind !== 'wallet').flatMap((x) => [x.login, x.userId, x.address]),
      ...plain.declared.map((d) => d.handle),
    ].filter(Boolean);
    must(secrets.length >= 3 && secrets.every((x) => !wire.includes(x)), 'a login, handle, id or pda leaked');
    must(m.diff.some((l) => l === '- x:@####') && m.diff.some((l) => /^\+ github:#{4} \d+bps$/.test(l)), `masked diff ${JSON.stringify(m.diff)}`);
    must(m.vaults.pendingLamports === plain.vaults.pendingLamports || Math.abs(m.vaults.pendingLamports - plain.vaults.pendingLamports) < 1e9, 'numbers kept');
    const bad = await get(`/api/lookup?q=${mint}&mask=yes`);
    must(bad.r.status === 400 && bad.body.code === 'BAD_INPUT', 'mask=yes -> 400');
    return `${secrets.length} values masked, ${ms} ms`;
  }],
  ['GET /api/lookup bad input -> 400 BAD_INPUT', async () => {
    const { r, body } = await get('/api/lookup?q=not%20a%20login!');
    must(r.status === 400 && body.code === 'BAD_INPUT', `${r.status} ${JSON.stringify(body)}`);
  }],
];

let failed = 0;
for (const [name, fn] of checks) {
  const t = Date.now();
  try { const note = await fn(); console.log(`ok   ${name} ${Date.now() - t}ms${note ? ` (${note})` : ''}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
