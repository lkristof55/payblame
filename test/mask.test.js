// maskLookup on replayed mainnet results, ticker(), the one mask width, the fixture scrubber, and a
// guard that decodes every fixture and fails on any identifier that is not a placeholder. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lookup, clearRentCache, maskLookup, ticker, formatCoin, MASK, LOGIN_MASK, HANDLE_MASK, ADDRESS_MASK, decodeSocialFeePda, decodeSharingConfig, accountData, extractDeclared, socialFeePda, isNumericId } from '../src/index.js';
import { readGz, replayFetch, seededCache } from './helpers/transcript.js';
import { Scrubber, PLACEHOLDER_USER_ID, placeholderUserId, scrubSocialFeePdas } from './helpers/scrub.js';
import { encodeSocialFeePda, fakeKey, b64 } from './helpers/synth.js';

const dir = new URL('./fixtures/', import.meta.url);
const load = (name) => readGz(new URL(`${name}.json.gz`, dir));
async function replay(name) {
  const fx = load(name);
  clearRentCache();
  return lookup(fx.q, { rpcUrl: 'http://replay.invalid', fetch: replayFetch(fx.transcript), cache: seededCache(fx.cacheSeed), limit: fx.limit });
}

test('ticker strips the $ sigil once printed: "$RapCat" never prints as "$$RapCat"', () => {
  assert.equal(ticker('$RapCat'), 'RapCat');
  assert.equal(ticker('$$RapCat'), 'RapCat');
  assert.equal(ticker(' RapCat '), 'RapCat');
  assert.equal(ticker('$'), null);
  assert.equal(ticker(null), null);
  const c = { mint: 'J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpump', symbol: '$RapCat', config: null, curve: { creator: null } };
  assert.match(formatCoin(c)[0], / \$RapCat no SharingConfig/);
  assert.ok(!formatCoin(c)[0].includes('$$'));
});

test('maskLookup(coin): no login, handle, user id or SocialFeePda leaves; numbers and structure stay', async () => {
  const c = await replay('coin-declared-mismatch');
  const [s] = c.config.shareholders;
  const m = maskLookup(c);
  const wire = JSON.stringify(m);
  for (const secret of [s.login, s.userId, s.address, ...c.declared.map((d) => d.handle)]) assert.ok(!wire.includes(secret), `leaked ${secret}`);
  assert.equal(m.masked, true);
  assert.equal(m.logins, 'masked');
  assert.equal(m.config.shareholders[0].login, LOGIN_MASK);
  assert.equal(m.config.shareholders[0].address, ADDRESS_MASK);
  assert.equal(m.config.shareholders[0].userId, null);
  assert.equal(m.config.shareholders[0].totalClaimedLamports, s.totalClaimedLamports);
  assert.equal(m.config.shareholders[0].bps, 10000);
  assert.deepEqual(m.diff, ['--- declared (name/symbol/description)', '+++ on-chain (SharingConfig)', `- x:@${HANDLE_MASK}`, `+ github:${LOGIN_MASK} 10000bps`]);
  assert.equal(m.blame.length, c.blame.length);
  assert.equal(m.blame[1], c.blame[1]);
  assert.ok(m.blame[2].startsWith(`${ADDRESS_MASK.padEnd(8)} (github:${LOGIN_MASK} `));
  assert.ok(m.blame[2].endsWith(c.blame[2].slice(c.blame[2].indexOf(') ') )));
  assert.match(m.description, new RegExp(`@${HANDLE_MASK}`));
  assert.equal(m.mint, c.mint);
  assert.equal(m.mismatch, true);
  assert.deepEqual(maskLookup(m), m); // idempotent
  assert.equal(c.config.shareholders[0].login, s.login); // input untouched
});

test('maskLookup(coin with two GitHub shareholders) masks both', async () => {
  const c = await replay('coin-two-github');
  const m = maskLookup(c);
  const wire = JSON.stringify(m);
  for (const s of c.config.shareholders) for (const secret of [s.login, s.userId, s.address]) assert.ok(!wire.includes(secret), `leaked ${secret}`);
  assert.equal(m.blame.filter((l) => l.includes(`github:${LOGIN_MASK}`)).length, 2);
});

test('maskLookup(legacy coin): wallet creator stays, only the header is rebuilt', async () => {
  const c = await replay('coin-legacy');
  const m = maskLookup(c);
  assert.deepEqual(m.blame, c.blame);
  assert.equal(m.curve.creator, c.curve.creator);
});

test('maskLookup(recipient): header, ids and PDAs masked; totals and coin lines keep their numbers', async () => {
  const r = await replay('recipient-89-coins');
  const m = maskLookup(r);
  const wire = JSON.stringify(m);
  for (const secret of [r.recipient.login, r.recipient.userId, r.recipient.address]) assert.ok(!wire.includes(secret), `leaked ${secret}`);
  assert.equal(m.blame[0], `# payblame github:${LOGIN_MASK} type=User logins=masked`);
  assert.equal(m.blame[1], r.blame[1]);
  assert.deepEqual(m.blame.slice(2), r.blame.slice(2));
  assert.deepEqual(m.totals, r.totals);
  assert.equal(m.query, `github:${LOGIN_MASK}`);
  assert.ok(m.coins.every((c) => c.coRecipients.every((x) => x.address === ADDRESS_MASK)));
});

// ---- fixture guard ------------------------------------------------------------------------------
// Decodes EVERY fixture: gunzip, JSON bodies inside transcripts, every base64 account blob (by its
// discriminator: SocialFeePda user_ids, SharingConfig/BondingCurve fields, and a Borsh-string scan of
// anything else), then checks every identifier-shaped value. It fails on any login, handle, text
// user_id or coin name that is not a placeholder. The real values are never listed here: the test
// knows what a placeholder looks like, not who the real accounts are.
const PLACEHOLDER_LOGIN = /^sample-login-\d{2}$/;
const PLACEHOLDER_HANDLE = /^sample_handle(?:_\d+)?$/;
const PLACEHOLDER_COIN = /^(?:Sample coin \d{2}|SMPL\d{2})$/;
const KNOWN_ASSETS = new Set(['USD Coin', 'USDC', 'USDT', 'Wrapped SOL', 'SOL']); // asset names in the not-pump fixture, not accounts
const DESCRIPTION_GLUE = new Set(['Fees', 'to', 'via']);
const MASKED = /^#+\d*$/; // a mask, or github:#<numeric id>
const isPlaceholder = (w) => PLACEHOLDER_LOGIN.test(w) || PLACEHOLDER_HANDLE.test(w) || PLACEHOLDER_USER_ID.test(w) || MASKED.test(w);
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOCIAL_URL = /(?<![\w.-])(?:www\.)?(?:x|twitter|github|t|tiktok|instagram|youtube|discord|warpcast)\.(?:com|me|gg)\/@?([A-Za-z0-9_.-]+)/gi;
const GH_API_LOGIN = /api\.github\.com\/users\/([^/?#\s"]+)/g;
const LABEL = /(?:github|x):@?([^\s)]+)/g;

function borshStrings(b) {
  const out = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i + 4 <= b.length; i++) {
    const n = dv.getUint32(i, true);
    if (n < 3 || n > 200 || i + 4 + n > b.length) continue;
    const s = b.subarray(i + 4, i + 4 + n);
    if (s.every((c) => c >= 0x20 && c < 0x7f) && /[A-Za-z]/.test(Buffer.from(s).toString('latin1'))) out.push(Buffer.from(s).toString('latin1'));
  }
  return out;
}

/** Walk one fixture; returns { problems, stats }. */
function auditFixture(name, root) {
  const problems = [];
  const stats = { accounts: 0, socialFeePdas: 0, textUserIds: 0, strings: 0 };
  const bad = (what, v) => problems.push(`${name}: ${what}: ${String(v).slice(0, 80)}`);
  const checkWord = (what, w) => { if (!isPlaceholder(w)) bad(what, w); };

  function account(bytes, pubkey) {
    stats.accounts++;
    if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([139, 96, 53, 17, 42, 169, 206, 150]))) {
      stats.socialFeePdas++;
      const d = decodeSocialFeePda(bytes);
      if (!isNumericId(d.userId)) {
        stats.textUserIds++;
        if (!PLACEHOLDER_USER_ID.test(d.userId)) bad('text user_id', d.userId);
        else if (pubkey && pubkey !== socialFeePda(d.userId, d.platform)) bad('placeholder user_id not at its PDA', pubkey);
      }
      return;
    }
    if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([216, 74, 9, 0, 56, 140, 93, 75]))) { decodeSharingConfig(bytes); return; } // pubkeys + numbers only
    if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]))) return; // BondingCurve: numbers + creator pubkey
    for (const str of borshStrings(bytes)) bad('Borsh string in account data', str);
  }

  function text(s, key) {
    stats.strings++;
    for (const m of s.matchAll(SOCIAL_URL)) checkWord('social URL', m[1]);
    for (const m of s.matchAll(GH_API_LOGIN)) checkWord('GitHub API login', decodeURIComponent(m[1]));
    for (const m of s.matchAll(LABEL)) checkWord('label', m[1]);
    for (const d of extractDeclared({ description: s.replace(/https?:\/\/api\.github\.com\/\S*/g, '') })) checkWord('declared handle', d.handle);
    if (key === 'login' || key === 'q' && !B58.test(s) && !/^(?:ghid|x):\d+$/.test(s)) checkWord(key, s);
    if (key === 'name' || key === 'symbol') { if (!PLACEHOLDER_COIN.test(s) && !KNOWN_ASSETS.has(s) && s !== name.replace(/\.json(\.gz)?$/, '')) bad(`coin ${key}`, s); }
    if (key === 'description') for (const w of s.split(/\s+/)) { const t = w.replace(/^@/, '').replace(/[.,;:!?]+$/, ''); if (t && !DESCRIPTION_GLUE.has(t)) checkWord('description word', t); }
    if (key === 'blame') {
      for (const m of s.matchAll(/\$(\S+)/g)) if (!PLACEHOLDER_COIN.test(m[1]) && !KNOWN_ASSETS.has(m[1])) bad('blame symbol', m[1]);
      for (const m of s.matchAll(/"([^"]*)"/g)) if (!PLACEHOLDER_COIN.test(m[1])) bad('blame name', m[1]);
      const row = /^[1-9A-HJ-NP-Za-km-z]{8} \((\S+)\s+\d+bps \d+\/\d+ (?:locked|MUTABLE)/.exec(s); // Format A coin row
      if (row && !PLACEHOLDER_COIN.test(row[1])) bad('blame row symbol', row[1]);
    }
  }

  function walk(v, key, parentKey) {
    if (typeof v === 'string') {
      if (/^[[{]/.test(v)) { try { return walk(JSON.parse(v), key, parentKey); } catch { /* plain text */ } }
      if (/^dataBase64/.test(key ?? '')) return account(Buffer.from(v, 'base64'));
      if (B58.test(v) || /^-?\d+(\.\d+)?$/.test(v)) return;
      return text(v, key);
    }
    if (Array.isArray(v)) {
      if (v.length === 2 && v[1] === 'base64' && typeof v[0] === 'string') return account(accountData(v));
      if (parentKey === 'accounts' && v.length === 3 && typeof v[0] === 'string' && typeof v[2] === 'string') return account(accountData(v[2]), v[0]);
      for (const x of v) walk(x, key === 'accounts' ? undefined : key, key);
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (!B58.test(k)) text(k, undefined);
        if (k.startsWith('gh/login/')) checkWord('cache key', k.slice(9));
        walk(x, k, key);
      }
    }
  }
  walk(root, undefined, undefined);
  return { problems, stats };
}

const allFixtures = () => readdirSync(dir).filter((f) => /\.json(\.gz)?$/.test(f)).map((f) => [f, f.endsWith('.gz') ? readGz(new URL(f, dir)) : JSON.parse(readFileSync(new URL(f, dir), 'utf8'))]);

test('fixture guard: every account in every fixture decodes to placeholders only (logins, handles, text user_ids, coin names)', () => {
  const problems = [];
  const total = { accounts: 0, socialFeePdas: 0, textUserIds: 0, strings: 0 };
  const files = allFixtures();
  assert.ok(files.length >= 9);
  for (const [f, fx] of files) {
    const r = auditFixture(f, fx);
    problems.push(...r.problems);
    for (const k of Object.keys(total)) total[k] += r.stats[k];
    if (f.endsWith('.gz') && !fx.accounts) assert.ok(fx.scrubbed, `${f} was written without the scrubber`);
  }
  assert.deepEqual(problems, []);
  // the ledger fixture alone has 12,274 SocialFeePdas; 90 of them hold text user_ids on mainnet
  assert.ok(total.socialFeePdas > 12000, `decoded ${total.socialFeePdas} SocialFeePdas`);
  assert.equal(total.textUserIds, 90);
  assert.ok(total.accounts > total.socialFeePdas);
});

test('fixture guard catches what it is meant to catch', () => {
  const sfp = (userId, platform = 1) => b64(encodeSocialFeePda({ userId, platform }));
  const cases = [
    [{ transcript: { k: { body: JSON.stringify({ result: { value: { data: sfp('some_real_handle') } } }) } } }, /text user_id/],
    [{ accounts: [[fakeKey(1), 1, sfp('a handle')[0]]] }, /text user_id/],
    [{ accounts: [[fakeKey(1), 1, sfp('sample_x_0001')[0]]] }, /not at its PDA/],
    [{ transcript: { k: { body: JSON.stringify({ result: { content: { metadata: { name: 'Real Person Coin', symbol: 'SMPL01' } } } }) } } }, /coin name/],
    [{ transcript: { k: { body: JSON.stringify({ description: 'fees to @someone_real' }) } } }, /description word|declared handle/],
    [{ expect: { blame: ['# payblame github:real-login id=1'] } }, /label/],
    [{ cacheSeed: { 'gh/login/real-login': { value: { login: 'real-login' } } } }, /cache key/],
    [{ transcript: { 'GET https://api.github.com/users/real-login': { body: '{}' } } }, /GitHub API login/],
    [{ note: 'see https://x.com/real_handle' }, /social URL/],
    [{ data: [Buffer.concat([Buffer.alloc(8), Buffer.from([9, 0, 0, 0]), Buffer.from('real name')]).toString('base64'), 'base64'] }, /Borsh string/],
  ];
  for (const [fx, re] of cases) {
    const { problems } = auditFixture('synthetic', fx);
    assert.ok(problems.some((p) => re.test(p)), `${JSON.stringify(fx).slice(0, 80)} -> ${JSON.stringify(problems)}`);
  }
  const okId = placeholderUserId(7, 13, 1);
  assert.equal(okId, 'sample_x_0007');
  assert.deepEqual(auditFixture('synthetic', { accounts: [[socialFeePda(okId, 1), 1, sfp(okId)[0]]] }).problems, []);
});

test('scrubSocialFeePdas: same byte length, same lamports and fields, placeholder at its own PDA', () => {
  const real = [
    { userId: '127238744', platform: 2 }, { userId: 'someone_real', platform: 1 }, { userId: 'abc', platform: 0 },
    { userId: 'x.com/a_name_here_20', platform: 1 }, { userId: 'a name', platform: 2 },
  ].map((a, i) => ({ pubkey: socialFeePda(a.userId, a.platform), lamports: 1559560 + i, data: encodeSocialFeePda({ ...a, totalClaimed: 5 + i, lastClaimed: 1700000000 + i }) }));
  const { accounts, replaced } = scrubSocialFeePdas(real, { pda: socialFeePda });
  assert.equal(replaced, 4);
  assert.deepEqual(accounts[0], real[0]); // numeric id untouched
  accounts.forEach((a, i) => {
    const before = decodeSocialFeePda(real[i].data);
    const after = decodeSocialFeePda(a.data);
    assert.equal(a.data.length, real[i].data.length);
    assert.equal(Buffer.byteLength(after.userId), Buffer.byteLength(before.userId));
    assert.equal(a.lamports, real[i].lamports);
    for (const k of ['platform', 'totalClaimed', 'lastClaimed', 'bump', 'version']) assert.equal(after[k], before[k], k);
    if (i > 0) { assert.match(after.userId, PLACEHOLDER_USER_ID); assert.equal(a.pubkey, socialFeePda(after.userId, after.platform)); }
  });
  assert.deepEqual(accounts.slice(1).map((a) => decodeSocialFeePda(a.data).userId), ['sample_x_001', '~02', 'sample_x_00000000003', '~00004']);
  assert.deepEqual(scrubSocialFeePdas(accounts, { pda: socialFeePda }).replaced, 0); // idempotent
  assert.throws(() => placeholderUserId(100, 3, 1), /no 3-byte placeholder/);
});

test('Scrubber: a synthetic recording keeps no trace of its login or handle', () => {
  const fx = {
    q: 'Real-Dev-Login',
    cacheSeed: { 'gh/login/real-dev-login': { at: 1, value: { id: '4242', login: 'Real-Dev-Login', type: 'User' } } },
    transcript: {
      'GET https://api.github.com/user/99': { status: 200, headers: {}, body: JSON.stringify({ login: 'OtherRealOrg', id: 99, type: 'Organization', html_url: 'https://github.com/OtherRealOrg', bio: 'hi' }) },
      'rpc getAsset {"id":"M"}': { status: 200, headers: {}, body: JSON.stringify({ result: { id: 'M', content: { metadata: { name: 'RealDevHandle coin', symbol: '$RDH', description: 'fees to @RealDevHandle, code at github.com/Real-Dev-Login' }, links: { twitter: 'x.com/RealDevHandle' } } } }) },
      'GET https://api.dexscreener.com/tokens/v1/solana/M': { status: 200, headers: {}, body: JSON.stringify([{ baseToken: { address: 'M', name: 'RealDevHandle coin', symbol: 'RDH' }, info: { socials: [{ url: 'https://x.com/RealDevHandle' }] } }]) },
    },
    expect: { blame: ['# payblame github:Real-Dev-Login id=4242'] },
  };
  const s = new Scrubber({ idToLogin: { 4242: 'sample-login-07' } });
  s.collect(fx);
  const out = JSON.stringify(s.apply(fx));
  for (const real of ['real-dev-login', 'otherrealorg', 'realdevhandle']) assert.ok(!out.toLowerCase().includes(real), real);
  assert.ok(out.includes('sample-login-07'));
  assert.ok(out.includes('sample_handle'));
  assert.ok(!out.includes('bio') && !out.includes('html_url') && !out.includes('links'));
});
