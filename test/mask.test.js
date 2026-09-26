// maskLookup on replayed mainnet results, ticker(), the one mask width, the fixture scrubber, and a
// guard that decodes every fixture and fails on any identifier that is not a placeholder. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { lookup, clearRentCache, maskLookup, ticker, formatCoin, MASK, LOGIN_MASK, HANDLE_MASK, ADDRESS_MASK, decodeSocialFeePda, decodeSharingConfig, accountData, extractDeclared, socialFeePda, isNumericId, isOnCurve, decodeBase58 } from '../src/index.js';
import { readGz, replayFetch, seededCache } from './helpers/transcript.js';
import { Scrubber, PLACEHOLDER_USER_ID, placeholderUserId, scrubSocialFeePdas, IdRemapper, SYNTHETIC_USER_ID, isSyntheticId, socialFeePdaBump, withUserId } from './helpers/scrub.js';
import { encodeSocialFeePda, encodeSharingConfig, fakeKey, b64 } from './helpers/synth.js';

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
// user_id or coin name that is not a placeholder, on any numeric GitHub/X id outside the synthetic
// range 9000000001-9000999999 (in account bytes, GitHub routes and bodies, cache keys, id maps,
// queries and expected output), and on any SocialFeePda that doesn't derive from a synthetic or
// placeholder id (its own key and bump, and every place its address appears: SharingConfig
// shareholder slots and memcmp probes). The real values are never listed here: the test knows what a
// placeholder looks like, not who the real accounts are.
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

const MAX_ID_DIGITS = 19; // a GitHub id or an X snowflake fits in 19 digits; longer digit runs are not account ids
const isIdShaped = (s) => /^\d+$/.test(String(s)) && String(s).length <= MAX_ID_DIGITS;
const idChecks = [ // [what, regex whose group 1 is an account id] over every string in a fixture
  ['GitHub REST route id', /api\.github\.com\/user\/(\d+)/g],
  ['avatar redirect id', /\/u\/(\d+)/g],
  ['cache key id', /\bgh\/id\/(\d+)/g],
  ['query id', /^(?:ghid|x):(\d+)$/g],
  ['blame id', /\bid=(\d+)/g],
  ['blame numeric recipient', /\b(?:github|x):#(\d+)/g],
];

/**
 * Walk one fixture; returns { problems, stats, refs }. `refs` lists the SocialFeePdas it proves (a
 * decoded account, verified against its synthetic or placeholder id) and the addresses it only
 * mentions (shareholder slots, probes), for crossCheck() to match across every fixture.
 */
function auditFixture(name, root) {
  const problems = [];
  const stats = { accounts: 0, socialFeePdas: 0, textUserIds: 0, numericUserIds: 0, strings: 0 };
  const refs = { proven: new Set(), shareholders: [], probes: [], absent: new Set() };
  const bad = (what, v) => problems.push(`${name}: ${what}: ${String(v).slice(0, 80)}`);
  const checkWord = (what, w) => { if (!isPlaceholder(w)) bad(what, w); };
  const checkId = (what, id) => { if (isIdShaped(id) && !isSyntheticId(id)) bad(`${what} outside the synthetic range`, id); };

  function account(bytes, pubkey) {
    stats.accounts++;
    if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([139, 96, 53, 17, 42, 169, 206, 150]))) {
      stats.socialFeePdas++;
      socialAccount(bytes, pubkey);
      return;
    }
    if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([216, 74, 9, 0, 56, 140, 93, 75]))) { // pubkeys + numbers only
      for (const s of decodeSharingConfig(bytes).shareholders) refs.shareholders.push([name, s.address]);
      return;
    }
    if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]))) return; // BondingCurve: numbers + creator pubkey
    for (const str of borshStrings(bytes)) bad('Borsh string in account data', str);
  }

  /** A SocialFeePda: its id is synthetic (numeric) or a placeholder (text); the data proves the address, and the key and bump must match it. */
  function socialAccount(bytes, pubkey) {
    const d = decodeSocialFeePda(bytes);
    if (isNumericId(d.userId)) {
      stats.numericUserIds++;
      if (!isSyntheticId(d.userId)) { bad('numeric user_id outside the synthetic range', d.userId); return; }
    } else {
      stats.textUserIds++;
      if (!PLACEHOLDER_USER_ID.test(d.userId)) { bad('text user_id', d.userId); return; }
    }
    const pda = socialFeePda(d.userId, d.platform);
    if (pubkey && pubkey !== pda) bad(isNumericId(d.userId) ? 'SocialFeePda not at the PDA of its synthetic id' : 'placeholder user_id not at its PDA', pubkey);
    else if (d.bump !== socialFeePdaBump(d.userId, d.platform)) bad('SocialFeePda bump is not its PDA bump', `${pda} ${d.bump}`);
    else refs.proven.add(pda);
  }

  /** A recorded RPC exchange: tie each returned account to the key it was asked for. */
  function rpcPairs(k, body) {
    const m = /^rpc (getAccountInfo|getMultipleAccounts|getProgramAccounts) (.*)$/.exec(k);
    if (!m) return;
    let params, res;
    try { params = JSON.parse(m[2]); res = JSON.parse(body)?.result; } catch { return; }
    if (m[1] === 'getProgramAccounts') {
      for (const f of params[1]?.filters ?? []) if (f.memcmp && f.memcmp.offset >= 80) refs.probes.push([name, f.memcmp.bytes]);
      for (const a of Array.isArray(res) ? res : []) if (a?.account?.data) pairAccount(a.pubkey, a.account.data);
    } else if (m[1] === 'getAccountInfo') {
      if (res && res.value === null) refs.absent.add(params[0]);
      else if (res?.value?.data) pairAccount(params[0], res.value.data);
    } else {
      (res?.value ?? []).forEach((a, i) => { if (a === null) refs.absent.add(params[0][i]); else if (a?.data) pairAccount(params[0][i], a.data); });
    }
  }
  function pairAccount(pubkey, data) {
    const b = accountData(data);
    if (b.length >= 8 && Buffer.from(b.subarray(0, 8)).equals(Buffer.from([139, 96, 53, 17, 42, 169, 206, 150]))) {
      const d = decodeSocialFeePda(b);
      if ((isNumericId(d.userId) ? isSyntheticId(d.userId) : PLACEHOLDER_USER_ID.test(d.userId)) && pubkey !== socialFeePda(d.userId, d.platform)) bad('SocialFeePda not at the PDA of its id', pubkey);
    }
  }

  function text(s, key) {
    stats.strings++;
    for (const [what, re] of idChecks) for (const m of s.matchAll(re)) checkId(what, m[1]);
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
    if (typeof v === 'number') { if (ID_KEYS.has(key)) checkId(`${key} field`, String(v)); return; }
    if (typeof v === 'string') {
      if (/^[[{]/.test(v)) { try { return walk(JSON.parse(v), key, parentKey); } catch { /* plain text */ } }
      if (/^dataBase64/.test(key ?? '')) return account(Buffer.from(v, 'base64'));
      if (ID_KEYS.has(key)) checkId(`${key} field`, v);
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
      if (v.socialFeePda?.dataBase64 && v.socialFeePda.pubkey) socialAccount(accountData(v.socialFeePda.dataBase64), v.socialFeePda.pubkey); // raw-accounts.json
      const envelope = 'jsonrpc' in v; // a JSON-RPC envelope's numeric "id" is the request number
      for (const [k, x] of Object.entries(v)) {
        if (envelope && k === 'id' && typeof x === 'number') continue;
        if (!B58.test(k)) text(k, undefined);
        if (k.startsWith('gh/login/')) checkWord('cache key', k.slice(9));
        if (/^\d+$/.test(k)) checkId('id map key', k); // the ledger's id -> login map
        if (key === 'transcript' && typeof x?.body === 'string') rpcPairs(k, x.body);
        walk(x, k, key);
      }
    }
  }
  walk(root, undefined, undefined);
  return { problems, stats, refs };
}
const ID_KEYS = new Set(['id', 'githubId', 'userId', 'user_id']);

/**
 * Across all fixtures: every address in a SharingConfig shareholder slot or a memcmp probe is a wallet
 * (on the ed25519 curve), a SocialFeePda some fixture proves (decoded, synthetic or placeholder id, at
 * its own PDA), or, for a probe, an address the recording shows has no account.
 */
function crossCheck(results) {
  const proven = new Set(results.flatMap((r) => [...r.refs.proven]));
  const absent = new Set(results.flatMap((r) => [...r.refs.absent]));
  const problems = [];
  const wallet = (a) => { try { const b = decodeBase58(a); return b.length === 32 && isOnCurve(b); } catch { return false; } };
  for (const r of results) {
    for (const [f, a] of r.refs.shareholders) if (!wallet(a) && !proven.has(a)) problems.push(`${f}: shareholder is neither a wallet nor a SocialFeePda of a synthetic id: ${a}`);
    for (const [f, a] of r.refs.probes) if (!wallet(a) && !proven.has(a) && !absent.has(a)) problems.push(`${f}: probed address is neither a wallet nor a SocialFeePda of a synthetic id: ${a}`);
  }
  return problems;
}

const allFixtures = () => readdirSync(dir).filter((f) => /\.json(\.gz)?$/.test(f)).map((f) => [f, f.endsWith('.gz') ? readGz(new URL(f, dir)) : JSON.parse(readFileSync(new URL(f, dir), 'utf8'))]);

test('fixture guard: every account in every fixture decodes to placeholders only (logins, handles, user_ids, SocialFeePdas, coin names)', () => {
  const problems = [];
  const total = { accounts: 0, socialFeePdas: 0, textUserIds: 0, numericUserIds: 0, strings: 0 };
  const files = allFixtures();
  assert.ok(files.length >= 9);
  const results = [];
  for (const [f, fx] of files) {
    const r = auditFixture(f, fx);
    results.push(r);
    problems.push(...r.problems);
    for (const k of Object.keys(total)) total[k] += r.stats[k];
    if (f.endsWith('.gz') && !fx.accounts) assert.ok(fx.scrubbed, `${f} was written without the scrubber`);
  }
  problems.push(...crossCheck(results));
  assert.deepEqual(problems, []);
  // the ledger fixture alone has 12,274 SocialFeePdas: 12,184 numeric ids (all synthetic now) and 90 text ids
  assert.ok(total.socialFeePdas > 12000, `decoded ${total.socialFeePdas} SocialFeePdas`);
  assert.equal(total.textUserIds, 90);
  assert.ok(total.numericUserIds >= 12184, `decoded ${total.numericUserIds} numeric user_ids`);
  assert.ok(total.accounts > total.socialFeePdas);
  const shareholders = results.flatMap((r) => r.refs.shareholders);
  assert.ok(shareholders.some(([, a]) => results.some((r) => r.refs.proven.has(a))), 'at least one shareholder slot is a proven SocialFeePda');
});

test('fixture guard catches what it is meant to catch', () => {
  const sfp = (userId, platform = 1) => b64(encodeSocialFeePda({ userId, platform }));
  const cases = [
    [{ transcript: { k: { body: JSON.stringify({ result: { value: { data: sfp('some_real_handle') } } }) } } }, /text user_id/],
    [{ accounts: [[fakeKey(1), 1, sfp('a handle')[0]]] }, /text user_id/],
    [{ accounts: [[fakeKey(1), 1, sfp('sample_x_0001')[0]]] }, /not at its PDA/],
    [{ transcript: { k: { body: JSON.stringify({ result: { content: { metadata: { name: 'Real Person Coin', symbol: 'SMPL01' } } } }) } } }, /coin name/],
    [{ transcript: { k: { body: JSON.stringify({ description: 'fees to @someone_real' }) } } }, /description word|declared handle/],
    [{ expect: { blame: ['# payblame github:real-login id=9000000001'] } }, /label/],
    [{ cacheSeed: { 'gh/login/real-login': { value: { login: 'real-login' } } } }, /cache key/],
    [{ transcript: { 'GET https://api.github.com/users/real-login': { body: '{}' } } }, /GitHub API login/],
    [{ note: 'see https://x.com/real_handle' }, /social URL/],
    [{ data: [Buffer.concat([Buffer.alloc(8), Buffer.from([9, 0, 0, 0]), Buffer.from('real name')]).toString('base64'), 'base64'] }, /Borsh string/],
    // numeric ids: a real-looking id anywhere, or a synthetic one at the wrong address
    [{ accounts: [[socialFeePda('9100000067', 2), 1, sfp('9100000067', 2)[0]]] }, /numeric user_id outside the synthetic range/],
    [{ accounts: [[fakeKey(2), 1, sfp('9000000007', 2)[0]]] }, /not at the PDA of its synthetic id/],
    [{ accounts: [[socialFeePda('9000000007', 2), 1, Buffer.from(withUserId(encodeSocialFeePda({ userId: '9000000007' }), '9000000007', 7)).toString('base64')]] }, /bump/],
    [{ transcript: { 'GET https://api.github.com/user/9100000067': { body: '{}' } } }, /GitHub REST route id/],
    [{ transcript: { k: { body: JSON.stringify({ login: 'sample-login-01', id: 9100000067, type: 'User' }) } } }, /id field/],
    [{ cacheSeed: { 'gh/id/9100000067': { value: { id: '9100000067', login: 'sample-login-01' } } } }, /cache key id/],
    [{ logins: { 9100000067: { id: '9000000001', login: 'sample-login-01' } } }, /id map key/],
    [{ q: 'ghid:9100000067' }, /query id/],
    [{ q: 'x:9100000067' }, /query id/],
    [{ expect: { blame: ['# payblame github:sample-login-01 id=9100000067 type=User'] } }, /blame id/],
    [{ expect: { blame: ['AAAAAAAA (x:#9100000067 5000bps) claimed=0.000'] } }, /blame numeric recipient/],
    [{ transcript: { 'GET https://github.com/sample-login-01.png': { headers: { location: 'https://avatars.githubusercontent.com/u/9100000067?v=4' } } } }, /avatar redirect id/],
  ];
  for (const [fx, re] of cases) {
    const { problems } = auditFixture('synthetic', fx);
    assert.ok(problems.some((p) => re.test(p)), `${JSON.stringify(fx).slice(0, 80)} -> ${JSON.stringify(problems)}`);
  }
  // cross-fixture: a shareholder slot or a probe that names an unproven PDA
  const unproven = socialFeePda('9100000067', 2);
  const config = b64(encodeSharingConfig({ mint: fakeKey('m'), admin: fakeKey('a'), shareholders: [[unproven, 10000]] }));
  const probeKey = `rpc getProgramAccounts ${JSON.stringify(['pfee', { filters: [{ memcmp: { offset: 0, bytes: 'dBH23jPD3C6' } }, { memcmp: { offset: 80, bytes: unproven } }] }])}`;
  const cross = crossCheck([auditFixture('synthetic', { transcript: { k: { body: JSON.stringify({ result: { value: { data: config } } }) }, [probeKey]: { body: '{"result":[]}' } } })]);
  assert.ok(cross.some((p) => /shareholder is neither/.test(p)) && cross.some((p) => /probed address is neither/.test(p)), JSON.stringify(cross));
  const provenId = '9000000007';
  const ok = [auditFixture('a', { accounts: [[socialFeePda(provenId, 2), 1, b64(withUserId(encodeSocialFeePda({ userId: provenId }), provenId, socialFeePdaBump(provenId, 2)))[0]]] }),
    auditFixture('b', { transcript: { k: { body: JSON.stringify({ result: { value: { data: b64(encodeSharingConfig({ mint: fakeKey('m'), admin: fakeKey('a'), shareholders: [[socialFeePda(provenId, 2), 10000]] })) } } }) } } })];
  assert.deepEqual([...ok.flatMap((r) => r.problems), ...crossCheck(ok)], []);
  const okId = placeholderUserId(7, 13, 1);
  assert.equal(okId, 'sample_x_0007');
  const okBytes = encodeSocialFeePda({ userId: okId, platform: 1 });
  okBytes[8] = socialFeePdaBump(okId, 1);
  assert.deepEqual(auditFixture('synthetic', { accounts: [[socialFeePda(okId, 1), 1, b64(okBytes)[0]]] }).problems, []);
});

test('scrubSocialFeePdas: same byte length, same lamports and fields, placeholder at its own PDA', () => {
  const real = [
    { userId: '9000900001', platform: 2 }, { userId: 'someone_real', platform: 1 }, { userId: 'abc', platform: 0 },
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
    for (const k of ['platform', 'totalClaimed', 'lastClaimed', 'version']) assert.equal(after[k], before[k], k);
    if (i > 0) {
      assert.match(after.userId, PLACEHOLDER_USER_ID);
      assert.equal(a.pubkey, socialFeePda(after.userId, after.platform));
      assert.equal(after.bump, socialFeePdaBump(after.userId, after.platform)); // the account stores its own bump
    }
  });
  assert.deepEqual(accounts.slice(1).map((a) => decodeSocialFeePda(a.data).userId), ['sample_x_001', '~02', 'sample_x_00000000003', '~00004']);
  assert.deepEqual(scrubSocialFeePdas(accounts, { pda: socialFeePda }).replaced, 0); // idempotent
  assert.throws(() => placeholderUserId(100, 3, 1), /no 3-byte placeholder/);
});

test('IdRemapper: numeric ids -> synthetic ids, every derived address moves with them, numbers stay', () => {
  const real = { gh: '9100004242', co: '9100005151', x: '9100000000000000017' }; // stand-ins for recorded ids (not synthetic, and above any real GitHub/X id)
  const recipient = socialFeePda(real.gh, 2);
  const coRecipient = socialFeePda(real.co, 2);
  const wallet = fakeKey('wallet-not-a-pda');
  const ledger = [
    { pubkey: recipient, lamports: 1559560 + 7e9, data: encodeSocialFeePda({ userId: real.gh, platform: 2, totalClaimed: 3, lastClaimed: 1700000001 }) },
    { pubkey: coRecipient, lamports: 1559560 + 5, data: encodeSocialFeePda({ userId: real.co, platform: 2 }) },
    { pubkey: socialFeePda(real.x, 1), lamports: 1559560, data: encodeSocialFeePda({ userId: real.x, platform: 1, totalClaimed: 9 }).subarray(0, 59) },
  ];
  const r = new IdRemapper();
  const moved = r.ledger(ledger);
  assert.equal(moved.length, 3);
  for (const a of moved) {
    const d = decodeSocialFeePda(a.data);
    assert.match(d.userId, SYNTHETIC_USER_ID);
    assert.equal(a.pubkey, socialFeePda(d.userId, d.platform));
    assert.equal(d.bump, socialFeePdaBump(d.userId, d.platform));
    const src = ledger.find((x) => x.pubkey === [...r.addr].find(([, to]) => to === a.pubkey)[0]);
    const s = decodeSocialFeePda(src.data);
    assert.equal(a.data.length, src.data.length);
    assert.equal(a.lamports, src.lamports);
    for (const k of ['platform', 'totalClaimed', 'lastClaimed', 'version']) assert.equal(d[k], s[k], k);
  }
  assert.deepEqual(moved.map((a) => a.pubkey), [...moved.map((a) => a.pubkey)].sort());
  assert.deepEqual(new Set([...r.ids.values()]), new Set(['9000000001', '9000000002', '9000000003']));
  assert.equal(r.id(real.gh, 2), r.id(real.gh, 2)); // one account, one synthetic id
  assert.notEqual(r.id(real.gh, 2), r.id(real.gh, 1)); // same digits on another platform is another account
  // a recorded lookup: probe bytes, account keys, shareholder slots, GitHub route/body, cache and query all move
  const cfg = encodeSharingConfig({ mint: fakeKey('mint'), admin: wallet, shareholders: [[recipient, 7000], [coRecipient, 2000], [wallet, 1000]] });
  const fx = {
    q: `ghid:${real.gh}`,
    cacheSeed: { [`gh/id/${real.gh}`]: { at: 1, value: { id: real.gh, login: 'sample-login-01', type: 'User' } } },
    transcript: {
      [`rpc getProgramAccounts ${JSON.stringify(['pfee', { filters: [{ memcmp: { offset: 80, bytes: recipient } }] }])}`]: { status: 200, headers: {}, body: JSON.stringify({ result: [{ pubkey: fakeKey('cfg'), account: { lamports: 1, data: ['', 'base64'] } }] }) },
      [`rpc getMultipleAccounts ${JSON.stringify([[fakeKey('cfg'), coRecipient], { dataSlice: { offset: 0, length: 72 } }])}`]: { status: 200, headers: {}, body: JSON.stringify({ result: { value: [{ lamports: 8017920, data: b64(cfg.subarray(0, 420)) }, { lamports: 1559565, data: b64(encodeSocialFeePda({ userId: real.co }).subarray(0, 72)) }] } }) },
      [`GET https://api.github.com/user/${real.co}`]: { status: 200, headers: {}, body: JSON.stringify({ login: 'sample-login-02', id: Number(real.co), type: 'User', site_admin: false }) },
      [`GET https://github.com/sample-login-01.png`]: { status: 302, headers: { location: `https://avatars.githubusercontent.com/u/${real.gh}?v=4` }, body: null },
    },
  };
  const out = r.fixture(fx);
  const wire = JSON.stringify(out);
  for (const secret of [real.gh, real.co, recipient, coRecipient]) assert.ok(!wire.includes(secret), `left ${secret}`);
  const gh = r.id(real.gh, 2), co = r.id(real.co, 2);
  assert.equal(out.q, `ghid:${gh}`);
  assert.deepEqual(Object.keys(out.cacheSeed), [`gh/id/${gh}`]);
  assert.equal(out.cacheSeed[`gh/id/${gh}`].value.id, gh);
  assert.ok(wire.includes(`api.github.com/user/${co}`) && wire.includes(`"id\\":${co}`) && wire.includes(`/u/${gh}?v=4`));
  const [, body] = Object.entries(out.transcript).find(([k]) => k.startsWith('rpc getMultipleAccounts'));
  const [c, sfp] = JSON.parse(body.body).result.value;
  assert.deepEqual(decodeSharingConfig(accountData(c.data)).shareholders.map((s) => [s.address, s.bps]), [[socialFeePda(gh, 2), 7000], [socialFeePda(co, 2), 2000], [wallet, 1000]]);
  assert.equal(decodeSocialFeePda(accountData(sfp.data)).userId, co);
  assert.equal(sfp.lamports, 1559565);
  assert.ok(Object.keys(out.transcript).some((k) => k.includes(`"bytes":"${socialFeePda(gh, 2)}"`)));
  assert.deepEqual(r.fixture(out), out); // idempotent
  assert.throws(() => withUserId(Uint8Array.from([...encodeSocialFeePda({ userId: '1' }).subarray(0, 40), 1]), '9000000001'), /does not fit/);
});

test('Scrubber: a synthetic recording keeps no trace of its login or handle', () => {
  const fx = {
    q: 'Real-Dev-Login',
    cacheSeed: { 'gh/login/real-dev-login': { at: 1, value: { id: '9100004242', login: 'Real-Dev-Login', type: 'User' } } },
    transcript: {
      'GET https://api.github.com/user/9100000099': { status: 200, headers: {}, body: JSON.stringify({ login: 'OtherRealOrg', id: 9100000099, type: 'Organization', html_url: 'https://github.com/OtherRealOrg', bio: 'hi' }) },
      'rpc getAsset {"id":"M"}': { status: 200, headers: {}, body: JSON.stringify({ result: { id: 'M', content: { metadata: { name: 'RealDevHandle coin', symbol: '$RDH', description: 'fees to @RealDevHandle, code at github.com/Real-Dev-Login' }, links: { twitter: 'x.com/RealDevHandle' } } } }) },
      'GET https://api.dexscreener.com/tokens/v1/solana/M': { status: 200, headers: {}, body: JSON.stringify([{ baseToken: { address: 'M', name: 'RealDevHandle coin', symbol: 'RDH' }, info: { socials: [{ url: 'https://x.com/RealDevHandle' }] } }]) },
    },
    expect: { blame: ['# payblame github:Real-Dev-Login id=9100004242'] },
  };
  const s = new Scrubber({ idToLogin: { 9100004242: 'sample-login-07' } });
  s.collect(fx);
  const out = JSON.stringify(s.apply(fx));
  for (const real of ['real-dev-login', 'otherrealorg', 'realdevhandle']) assert.ok(!out.toLowerCase().includes(real), real);
  assert.ok(out.includes('sample-login-07'));
  assert.ok(out.includes('sample_handle'));
  assert.ok(!out.includes('bio') && !out.includes('html_url') && !out.includes('links'));
});
