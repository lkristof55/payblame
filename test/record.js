// Records mainnet fixtures for the offline tests. Run once:
//   PAYBLAME_RPC_URL=https://mainnet.helius-rpc.com/?api-key=... PAYBLAME_RECORD_LOGIN=<login> node test/record.js
// PAYBLAME_RECORD_LOGIN: the GitHub login for the recipient fixture (ours was a recipient with 89 coins; the
//   repo doesn't name it). Unset = keep the existing recipient fixture (its synthetic ids then come from the
//   earlier recording, not from this run's map). The replay test expects a never-claimed
//   recipient with more than 600 SOL unclaimed, so a different login may need those two assertions adjusted.
// Optional PAYBLAME_CACHE_FILE: a JSON file of GitHub cache entries to reuse (saves the 60/h GitHub quota).
// Nothing is written raw: every fixture goes through test/helpers/scrub.js first (numeric GitHub/X ids ->
// synthetic 9000000001+ with every SocialFeePda moved to the synthetic id's PDA, GitHub logins ->
// sample-login-NN keyed by that id, declared handles -> sample_handle, metadata bodies trimmed), then
// `expect` is re-derived by replaying the scrubbed transcript, so the fixture and its expectation agree.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { lookup, createRpc, fetchSocialFeePdas, rentExempt, clearRentCache, memoryCache, encodeBase58, PayblameError, socialFeePda } from '../src/index.js';
import { recordingFetch, loggingCache, writeGz, replayFetch, seededCache } from './helpers/transcript.js';
import { Scrubber, scrubSocialFeePdas, IdRemapper, LEDGER_NOTE } from './helpers/scrub.js';
import { randomBytes } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'fixtures');
const rpcUrl = process.env.PAYBLAME_RPC_URL;
if (!rpcUrl) { console.error('set PAYBLAME_RPC_URL'); process.exit(2); }
if (!process.env.PAYBLAME_RECORD_LOGIN) console.error('PAYBLAME_RECORD_LOGIN unset: keeping test/fixtures/recipient-89-coins.json.gz');

// persistent GitHub cache (optional)
const cacheFile = process.env.PAYBLAME_CACHE_FILE;
const store = cacheFile && existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
const fileCache = { get: async (k) => store[k] ?? null, set: async (k, v) => { store[k] = v; } };

async function newestPumpMint() {
  try {
    const r = await fetch('https://frontend-api-v3.pump.fun/coins?offset=0&limit=5&sort=created_timestamp&order=DESC&includeNsfw=false', { signal: AbortSignal.timeout(8000) });
    const list = await r.json();
    const c = (Array.isArray(list) ? list : list.coins || []).find((x) => x.mint);
    if (c) return c.mint;
  } catch { /* fall through */ }
  const r = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', { signal: AbortSignal.timeout(8000) });
  return (await r.json()).find((p) => p.chainId === 'solana' && p.tokenAddress.endsWith('pump')).tokenAddress;
}

// names: 'placeholder' on every pump coin (a coin's name or symbol can spell a person or a handle); description: 'drop' where unused
const scenarios = [
  ...(process.env.PAYBLAME_RECORD_LOGIN ? [{ name: 'recipient-89-coins', q: process.env.PAYBLAME_RECORD_LOGIN, scrub: { names: 'placeholder', description: 'drop' } }] : []),
  { name: 'coin-declared-mismatch', q: 'J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpump', scrub: { names: 'placeholder' } }, // names an X handle, pays one GitHub account
  { name: 'coin-two-github', q: 'CjS48SdQ35rzHjARBP737a64fkEM6xgjpRHzuHA8pump', scrub: { names: 'placeholder', description: 'drop' } }, // two GitHub shareholders, 5000 bps each
  { name: 'coin-legacy', q: 'BbWaZxgo51Na37XYCn6SzSvVoZTCkCT23RLxxiJJpump', scrub: { names: 'placeholder', description: 'drop' } },
  { name: 'coin-new', q: await newestPumpMint(), scrub: { names: 'placeholder', description: 'drop' } },
  { name: 'wallet-empty', q: encodeBase58(randomBytes(32)) },
  { name: 'not-pump-usdc', q: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
];

async function run(q, opts) {
  try { return { result: await lookup(q, opts), error: null }; } catch (e) {
    if (!(e instanceof PayblameError)) throw e;
    return { result: null, error: { code: e.code, status: e.status, message: e.message } };
  }
}

// 1. record every scenario raw, in memory only
const raw = [];
for (const s of scenarios) {
  clearRentCache();
  const transcript = {};
  const cacheSeed = {};
  await run(s.q, { rpcUrl, fetch: recordingFetch(transcript), cache: loggingCache(fileCache, cacheSeed), limit: s.limit, githubToken: process.env.GITHUB_TOKEN });
  raw.push({ s, fx: { name: s.name, q: s.q, limit: s.limit, recordedAt: new Date().toISOString(), cacheSeed, transcript } });
}

// 2. the ledger: one getProgramAccounts over every SocialFeePda, stored compactly
clearRentCache();
const rpc = createRpc({ rpcUrl });
const [rawAccounts, rent179] = await Promise.all([fetchSocialFeePdas(rpc), rentExempt(rpc, 179)]);
// text user_ids (handles, names, URLs) -> same-length placeholders at the placeholder's PDA
const { accounts: textScrubbed, replaced: textIds } = scrubSocialFeePdas(rawAccounts, { pda: socialFeePda });
// numeric user_ids (GitHub/X account ids) -> synthetic ids in random order, each account at its new PDA;
// the scenarios reuse the same map, so one account has one synthetic id (and address) in every fixture
const remap = new IdRemapper();
const accounts = remap.ledger(textScrubbed);
const scenariosOut = raw.map(({ s, fx }) => ({ s, fx: remap.fixture(fx) }));

// 3. one scrubber for everything: ledger ids get sample-login-NN in synthetic-id order, then the scenarios
const scrubber = new Scrubber();
const ids = Object.keys(store).filter((k) => k.startsWith('gh/id/')).map((k) => k.slice(6))
  .map((id) => [id, remap.id(id, 2)]).sort((a, b) => Number(a[1]) - Number(b[1]));
for (const [id, synth] of ids) if (store[`gh/id/${id}`]?.value?.login) scrubber.login(store[`gh/id/${id}`].value.login, synth);
for (const { fx } of scenariosOut) scrubber.collect(fx);

// 4. scrub, re-derive expect by replay, write
for (const { s, fx } of scenariosOut) {
  const clean = scrubber.apply(fx, s.scrub ?? {});
  clearRentCache();
  const { result, error } = await run(clean.q, { rpcUrl: 'http://replay.invalid', fetch: replayFetch(clean.transcript), cache: seededCache(clean.cacheSeed), limit: clean.limit });
  clean.expect = result ? { kind: result.kind, blame: result.blame, totals: result.totals, diff: result.diff } : { error };
  writeGz(path.join(out, `${s.name}.json.gz`), clean);
  console.log(`${s.name.padEnd(26)} ${String(clean.q).slice(0, 44).padEnd(44)} ${error ? error.code : result.kind} ${Object.keys(clean.transcript).length} requests`);
}

const logins = {};
for (const [id, synth] of ids) {
  const v = store[`gh/id/${id}`].value;
  logins[synth] = { ...v, id: synth, login: v.login ? scrubber.login(v.login, synth) : null };
}
writeGz(path.join(out, 'ledger-socialfeepda.json.gz'), {
  recordedAt: new Date().toISOString(),
  call: 'getProgramAccounts pump_fees memcmp(0, SocialFeePda) dataSlice {0, 59}',
  rentExemptLamports: rent179,
  accounts: accounts.map((a) => [a.pubkey, a.lamports, Buffer.from(a.data).toString('base64')]),
  logins,
  loginsNote: LEDGER_NOTE,
  textUserIds: textIds,
  syntheticIds: remap.ids.size,
});
console.log(`ledger-socialfeepda        ${accounts.length} accounts, ${textIds} text user_ids replaced, ${remap.ids.size} numeric ids made synthetic`);
if (cacheFile) writeFileSync(cacheFile, JSON.stringify(store));
