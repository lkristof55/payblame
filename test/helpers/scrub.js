// Scrubs recorded fixtures so the repo names no real account.
//
// - GitHub logins -> sample-login-NN. The placeholder is keyed by the numeric id, so the same
//   account gets the same placeholder in every fixture (and in the ledger fixture).
// - Handles a coin's metadata declares (x.com/<h>, @<h>, github.com/<login>) -> sample_handle[_N]
//   or a sample-login-NN.
// - GitHub REST bodies -> { login, id, type, site_admin } (no profile, no URLs).
// - DAS and DexScreener bodies -> only the fields the library reads (name, symbol, description,
//   pair numbers). { names: 'placeholder' } replaces every coin name/symbol with "Sample coin NN" /
//   "SMPLNN" (every pump coin fixture uses it: a coin name can spell a person or a handle);
//   { description: 'drop' } removes descriptions the scenario doesn't need.
// - SocialFeePda user_ids that are text (a handle, a name, a URL) -> a same-length placeholder at
//   the placeholder's PDA (scrubSocialFeePdas, below).
// - Numeric user_ids (GitHub and X account ids, which a public API turns back into a login) -> a
//   synthetic id from 9000000001 up, and every address derived from the real id -> the PDA of the
//   synthetic one (IdRemapper, below).
//
// Other chain data (account bytes, lamports, claim fields, coins) is left exactly as recorded, so the
// replay still exercises the real decode path. The real -> placeholder maps live in memory only.
import { randomInt } from 'node:crypto';
import { extractDeclared } from '../../src/declared.js';
import { parseQuery } from '../../src/query.js';
import { findProgramAddress } from '../../src/pda.js';
import { decodeBase58 } from '../../src/base58.js';
import { PUMP_FEES, DISC } from '../../src/constants.js';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (t) => new RegExp(`(?<![A-Za-z0-9_-])${esc(t)}(?![A-Za-z0-9_-])`, 'gi');
const pad2 = (n) => String(n).padStart(2, '0');
const GH_USERS = /^GET https:\/\/api\.github\.com\/users\/([^/?#]+)$/;
const GH_USER_ID = /^GET https:\/\/api\.github\.com\/user\/(\d+)$/;
const GH_AVATAR = /^GET https:\/\/github\.com\/([^/?#]+)\.png$/;
const isGithub = (k) => GH_USERS.test(k) || GH_USER_ID.test(k) || GH_AVATAR.test(k);
const isDas = (k) => /^rpc getAsset(Batch)? /.test(k);
const isDex = (k) => k.startsWith('GET https://api.dexscreener.com/');

function parse(body) { try { return JSON.parse(body); } catch { return undefined; } }

export class Scrubber {
  /** @param {{ idToLogin?: Record<string,string> }} [o] existing id -> placeholder (e.g. from the ledger fixture) */
  constructor({ idToLogin = {} } = {}) {
    this.byId = new Map(Object.entries(idToLogin).map(([id, p]) => [String(id), p]));
    this.tokens = new Map(); // lower-case real token -> placeholder
    const used = [...this.byId.values()].map((p) => Number(/(\d+)$/.exec(p)?.[1] ?? 0));
    this.nextLogin = Math.max(0, ...used) + 1;
    this.nextHandle = 1;
    this.re = null;
  }

  login(real, id) {
    const k = String(real).toLowerCase();
    if (this.tokens.has(k)) return this.tokens.get(k);
    let p = id != null ? this.byId.get(String(id)) : undefined;
    if (!p) {
      p = `sample-login-${pad2(this.nextLogin++)}`;
      if (id != null) this.byId.set(String(id), p);
    }
    this.tokens.set(k, p);
    this.re = null;
    return p;
  }

  handle(real) {
    const k = String(real).toLowerCase();
    if (this.tokens.has(k)) return this.tokens.get(k);
    const n = this.nextHandle++;
    const p = n === 1 ? 'sample_handle' : `sample_handle_${n}`;
    this.tokens.set(k, p);
    this.re = null;
    return p;
  }

  /** Replace every known real token in a string (whole word, any case). */
  text(s) {
    if (typeof s !== 'string' || !this.tokens.size) return s;
    if (!this.re) this.re = [...this.tokens].sort((a, b) => b[0].length - a[0].length).map(([t, p]) => [word(t), p]);
    let out = s;
    for (const [re, p] of this.re) out = out.replace(re, p);
    return out;
  }

  /** Pass 1: learn every login and declared handle a fixture contains. */
  collect(fx) {
    for (const [k, v] of Object.entries(fx.cacheSeed ?? {})) {
      const val = v?.value;
      if (k.startsWith('gh/login/')) this.login(val?.login ?? k.slice(9), val?.id);
      else if (val?.login) this.login(val.login, val.id);
    }
    for (const [k, e] of Object.entries(fx.transcript ?? {})) {
      if (isGithub(k)) {
        const u = parse(e.body);
        const m = GH_USERS.exec(k) ?? GH_AVATAR.exec(k);
        const idFromLocation = /\/u\/(\d+)/.exec(e.headers?.location ?? '')?.[1];
        if (u?.login) this.login(u.login, u.id);
        if (m) this.login(decodeURIComponent(m[1]), u?.id ?? idFromLocation);
      } else if (isDas(k) || isDex(k)) {
        for (const meta of metaTexts(k, parse(e.body))) {
          for (const d of extractDeclared(meta)) d.platform === 'github' ? this.login(d.handle) : this.handle(d.handle);
        }
      }
    }
    const q = typeof fx.q === 'string' ? parseQuery(fx.q) : null;
    if (q?.kind === 'github') this.login(q.login);
  }

  /** Pass 2: a scrubbed copy. `expect` is text-scrubbed; callers should re-derive it by replay. */
  apply(fx, { names = 'scrub', description = 'scrub' } = {}) {
    const coinNames = new Map(); // mint -> { name, symbol }
    const placeholderFor = (mint) => {
      if (!coinNames.has(mint)) { const n = pad2(coinNames.size + 1); coinNames.set(mint, { name: `Sample coin ${n}`, symbol: `SMPL${n}` }); }
      return coinNames.get(mint);
    };
    const meta = (mint, m) => ({
      ...(names === 'placeholder' ? placeholderFor(mint) : { name: this.text(m.name), symbol: this.text(m.symbol) }),
      description: description === 'drop' ? null : this.text(m.description),
    });

    const transcript = {};
    for (const [k, e] of Object.entries(fx.transcript ?? {})) {
      let body = e.body;
      const headers = { ...e.headers };
      if (isGithub(k)) {
        const u = parse(body);
        if (u && u.id != null) body = JSON.stringify({ login: this.login(u.login, u.id), id: u.id, type: u.type, site_admin: false });
        else if (u && typeof u === 'object') body = JSON.stringify({ message: this.text(u.message ?? 'Not Found') });
        if (headers.location) headers.location = this.text(headers.location);
      } else if (isDas(k)) {
        const j = parse(body);
        if (j && typeof j === 'object') {
          const trim = (a) => {
            if (!a || typeof a !== 'object') return a;
            const md = a.content?.metadata ?? {};
            const m = meta(a.id, { name: md.name ?? null, symbol: md.symbol ?? a.token_info?.symbol ?? null, description: md.description ?? null });
            const out = { interface: a.interface, id: a.id, content: { metadata: { name: m.name, symbol: m.symbol } } };
            if (m.description != null) out.content.metadata.description = m.description;
            if (a.token_info) out.token_info = { symbol: m.symbol, decimals: a.token_info.decimals, token_program: a.token_info.token_program };
            return out;
          };
          j.result = Array.isArray(j.result) ? j.result.map(trim) : trim(j.result);
          body = JSON.stringify(j);
        }
      } else if (isDex(k)) {
        const j = parse(body);
        if (Array.isArray(j)) {
          body = JSON.stringify(j.map((p) => {
            const tok = (t) => (t ? { address: t.address, ...(() => { const m = meta(t.address, { name: t.name ?? null, symbol: t.symbol ?? null, description: null }); return { name: m.name, symbol: m.symbol }; })() } : t);
            const wrapped = p.quoteToken?.address === 'So11111111111111111111111111111111111111112';
            return {
              chainId: p.chainId, dexId: p.dexId, url: p.url, pairAddress: p.pairAddress,
              baseToken: tok(p.baseToken), quoteToken: wrapped ? p.quoteToken : tok(p.quoteToken),
              liquidity: p.liquidity ? { usd: p.liquidity.usd } : p.liquidity, fdv: p.fdv, marketCap: p.marketCap,
            };
          }));
        }
      }
      transcript[this.text(k)] = { status: e.status, headers, body };
    }

    const cacheSeed = {};
    for (const [k, v] of Object.entries(fx.cacheSeed ?? {})) {
      const val = v?.value ? { ...v.value } : v?.value;
      if (val?.login) val.login = this.login(val.login, val.id);
      cacheSeed[this.text(k)] = { ...v, value: val };
    }

    const q = typeof fx.q === 'string' ? parseQuery(fx.q) : null;
    const scrubLines = (a) => (Array.isArray(a) ? a.map((l) => this.text(l)) : a);
    return {
      ...fx,
      q: q?.kind === 'github' ? this.login(q.login) : fx.q,
      scrubbed: SCRUB_NOTE,
      cacheSeed,
      transcript,
      expect: fx.expect ? { ...fx.expect, blame: scrubLines(fx.expect.blame), diff: scrubLines(fx.expect.diff) } : fx.expect,
    };
  }
}

// ---- SocialFeePda user_id text ------------------------------------------------------------------
// Most on-chain user_ids are numeric (a GitHub or X account id), but some accounts store free text:
// an X handle, a name, a URL. The ledger fixture replaces each of those with a placeholder of the
// SAME byte length, so the Borsh offsets, the 59-byte dataSlice, lamports and the platform byte stay
// exactly as recorded, and moves the account to the PDA of the placeholder, so the fixture stays
// self-consistent (pubkey = PDA('social-fee-pda', user_id, platform)) and names nobody.

const PLATFORM_TAG = { 0: 'pump', 1: 'x', 2: 'gh' };
/** Every placeholder user_id matches this; the fixture guard fails on any other non-numeric id. */
export const PLACEHOLDER_USER_ID = /^(?:sample_(?:pump|x|gh|p\d+)_\d{2,}|~\d{2,})$/;

/**
 * A placeholder user_id of exactly `len` bytes for the i-th (1-based) text id:
 * `sample_x_0007` when it fits with at least two digits, else `~007` ('~' is not valid in an X or GitHub
 * handle; a real 3-byte id like `s12` exists on mainnet, so the short form must not look like one).
 */
export function placeholderUserId(i, len, platform) {
  const long = `sample_${PLATFORM_TAG[platform] ?? `p${platform}`}_`;
  const digits = String(i);
  if (len - long.length >= Math.max(2, digits.length)) return long + digits.padStart(len - long.length, '0');
  if (len - 1 >= Math.max(2, digits.length)) return `~${digits.padStart(len - 1, '0')}`;
  throw new Error(`no ${len}-byte placeholder for text id #${i}`);
}

/**
 * Replace every non-numeric user_id in raw SocialFeePda account data with a same-length placeholder.
 * @param {{ pubkey: string, lamports: number, data: Uint8Array }[]} accounts (not mutated)
 * @param {{ pda: (userId: string, platform: number) => string }} deps socialFeePda from src/pda.js
 * @returns {{ accounts: typeof accounts, replaced: number }}
 */
export function scrubSocialFeePdas(accounts, { pda }) {
  let n = 0;
  const taken = new Set(accounts.map((a) => a.pubkey));
  const out = accounts.map((a) => {
    const b = a.data;
    if (b.length < 14) return a;
    const len = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(10, true);
    if (len === 0 || 14 + len > b.length) return a;
    const id = new TextDecoder().decode(b.subarray(14, 14 + len));
    if (/^\d+$/.test(id) || PLACEHOLDER_USER_ID.test(id)) return a;
    const platform = b[14 + len];
    const p = placeholderUserId(++n, len, platform);
    const data = Uint8Array.from(b);
    data.set(new TextEncoder().encode(p), 14);
    const pubkey = pda(p, platform);
    data[8] = socialFeePdaBump(p, platform); // the account stores its own bump
    if (taken.has(pubkey)) throw new Error(`placeholder PDA collides with a recorded account: ${p}`);
    taken.add(pubkey);
    return { ...a, pubkey, data };
  });
  return { accounts: out, replaced: n };
}

export const LEDGER_NOTE = 'No real account id: every numeric user_id (GitHub or X account id) is a synthetic id from 9000000001 up, one per account, assigned in random order, and each account sits at the PDA of its synthetic id. The accounts whose on-chain user_id is text (a handle, a name or a URL) carry a same-length placeholder (sample_x_0007, ~07) at the PDA of that placeholder. GitHub logins are sample-login-NN, keyed by id. Lamports, platform, claim fields and User/Org types are as recorded.';

export const SCRUB_NOTE ='GitHub logins -> sample-login-NN (keyed by id, same in every fixture); numeric GitHub/X ids -> synthetic 9000000001+ (same as the ledger fixture) and every SocialFeePda -> the PDA of its synthetic id, including SharingConfig shareholder slots and memcmp probes; declared handles -> sample_handle; GitHub/DAS/DexScreener bodies trimmed to the fields payblame reads. Lamports, bps, claim fields and coin accounts are as recorded.';

// ---- numeric user_ids ---------------------------------------------------------------------------
// A numeric user_id is a GitHub or X account id, and a public API turns it back into a login, so no
// fixture keeps one. IdRemapper gives every account (platform + id) a synthetic id from 9000000001 up,
// in random order, moves it to the PDA of that id (new address, new bump) and moves every reference to
// the old address with it: memcmp probe bytes, getAccountInfo/getMultipleAccounts keys, SharingConfig
// shareholder slots (raw bytes), GitHub REST /user/<id> routes and bodies, /u/<id> redirects, gh/id/
// cache keys and ghid:/x: queries. Lamports, platform, claim fields and every other byte stay as
// recorded. The real -> synthetic map lives in memory only.

export const SYNTHETIC_ID_FIRST = 9_000_000_001;
/** 9000000001-9000999999: ten digits, far above any GitHub id issued so far. The fixture guard allows no other numeric id. */
export const SYNTHETIC_USER_ID = /^9000(?!000000)\d{6}$/;
export const isSyntheticId = (s) => SYNTHETIC_USER_ID.test(String(s));

const SEED = 'social-fee-pda';
const findSocialFeePda = (userId, platform) => findProgramAddress([SEED, String(userId), Uint8Array.of(platform)], PUMP_FEES);
/** The bump byte (offset 8) a SocialFeePda for this id stores. */
export const socialFeePdaBump = (userId, platform) => findSocialFeePda(userId, platform)[1];

const B58_TOKEN = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const B64_ACCOUNT = /"([A-Za-z0-9+/]*={0,2})","base64"/g; // an account's data inside a raw JSON-RPC body
const SFP_DISC = Buffer.from(DISC.SocialFeePda).toString('latin1');
const latin1 = (b, i = 0, n = b.length) => Buffer.from(b.buffer, b.byteOffset + i, n).toString('latin1');

/**
 * Raw SocialFeePda bytes (a full account or a dataSlice) with another user_id: same length, the fields
 * after the id shift with it, the zero padding at the end absorbs the difference.
 * @param {Uint8Array} bytes @param {string} userId @param {number} [bump]
 */
export function withUserId(bytes, userId, bump) {
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(10, true);
  const id = new TextEncoder().encode(userId);
  const tail = bytes.subarray(14 + len);
  const room = bytes.length - 14 - id.length;
  if (room < 0 || tail.subarray(Math.max(0, room)).some((x) => x !== 0)) throw new Error(`user_id ${userId} does not fit in a ${bytes.length}-byte SocialFeePda`);
  const out = new Uint8Array(bytes.length);
  out.set(bytes.subarray(0, 10));
  new DataView(out.buffer).setUint32(10, id.length, true);
  out.set(id, 14);
  out.set(tail.subarray(0, room), 14 + id.length);
  if (bump != null) out[8] = bump;
  return out;
}

export class IdRemapper {
  constructor({ first = SYNTHETIC_ID_FIRST } = {}) {
    this.next = first;
    this.ids = new Map();   // "<platform>:<real id>" -> synthetic id
    this.addr = new Map();  // old SocialFeePda -> new
    this.bin = new Map();   // old SocialFeePda (32 bytes, latin1) -> new bytes
  }

  /** The synthetic id for one account (allocated on first sight). Already-synthetic ids pass through. */
  id(userId, platform) {
    const real = String(userId);
    if (isSyntheticId(real)) return real;
    const k = `${platform}:${real}`;
    let s = this.ids.get(k);
    if (!s) {
      s = String(this.next++);
      if (!isSyntheticId(s)) throw new Error('synthetic id range exhausted');
      this.ids.set(k, s);
      const [from] = findSocialFeePda(real, platform);
      const [to] = findSocialFeePda(s, platform);
      this.addr.set(from, to);
      this.bin.set(latin1(decodeBase58(from)), decodeBase58(to));
    }
    return s;
  }

  /** Allocate many at once in random order, so a synthetic id says nothing about the real one. */
  assign(list) {
    const a = list.map((x) => [String(x.userId), x.platform]);
    for (let i = a.length - 1; i > 0; i--) { const j = randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    for (const [id, p] of a) this.id(id, p);
  }

  address(a) { return this.addr.get(a) ?? a; }
  text(s) { return typeof s === 'string' ? s.replace(B58_TOKEN, (t) => this.addr.get(t) ?? t) : s; }

  /** One account's raw bytes: a numeric SocialFeePda id -> synthetic (+ bump); old SocialFeePdas inside (shareholder slots) -> new. */
  account(bytes) {
    let b = bytes;
    const user = socialUser(b);
    if (user && /^\d+$/.test(user.userId) && !isSyntheticId(user.userId) && user.platform != null) {
      const s = this.id(user.userId, user.platform);
      b = withUserId(b, s, socialFeePdaBump(s, user.platform));
    } else if (user && user.platform != null && b[8] !== socialFeePdaBump(user.userId, user.platform)) {
      b = Uint8Array.from(b);
      b[8] = socialFeePdaBump(user.userId, user.platform);
    }
    let out = null;
    for (let i = 0; i + 32 <= b.length; i++) {
      const to = this.bin.get(latin1(b, i, 32));
      if (to) { out ??= Uint8Array.from(b); out.set(to, i); i += 31; }
    }
    return out ?? b;
  }

  /** Register every id a recorded fixture holds (pass 1), so pass 2 can move each address everywhere. */
  collect(fx) {
    for (const [k, v] of Object.entries(fx.cacheSeed ?? {})) {
      const m = /^gh\/id\/(\d+)$/.exec(k);
      if (m) this.id(m[1], 2);
      if (v?.value?.id != null) this.id(v.value.id, 2);
    }
    for (const [k, e] of Object.entries(fx.transcript ?? {})) {
      const m = GH_USER_ID.exec(k);
      if (m) this.id(m[1], 2);
      if (isGithub(k)) {
        for (const x of String(e.body ?? '').matchAll(/"id":(\d+)/g)) this.id(x[1], 2);
        const u = /\/u\/(\d+)/.exec(e.headers?.location ?? '');
        if (u) this.id(u[1], 2);
      } else {
        for (const x of String(e.body ?? '').matchAll(B64_ACCOUNT)) {
          const user = socialUser(bytesOf(x[1]));
          if (user && /^\d+$/.test(user.userId) && user.platform != null) this.id(user.userId, user.platform);
        }
      }
    }
    const q = typeof fx.q === 'string' ? parseQuery(fx.q) : null;
    if (q?.kind === 'ghid' || q?.kind === 'x') this.id(q.id, q.kind === 'x' ? 1 : 2);
  }

  /** Pass 2: a remapped copy of a recorded lookup fixture. Re-derive `expect` by replay afterwards. */
  fixture(fx) {
    this.collect(fx);
    const gh = (s) => s.replace(/(api\.github\.com\/user\/|\/u\/)(\d+)/g, (_, pre, id) => pre + this.id(id, 2));
    const transcript = {};
    for (const [k, e] of Object.entries(fx.transcript ?? {})) {
      let body = e.body;
      if (typeof body === 'string') {
        body = isGithub(k)
          ? gh(body.replace(/"id":(\d+)/g, (_, id) => `"id":${this.id(id, 2)}`))
          : this.text(body.replace(B64_ACCOUNT, (_, b64) => `"${Buffer.from(this.account(bytesOf(b64))).toString('base64')}","base64"`));
      }
      const headers = { ...e.headers };
      if (headers.location) headers.location = gh(headers.location);
      transcript[gh(this.text(k))] = { ...e, headers, body };
    }
    const cacheSeed = {};
    for (const [k, v] of Object.entries(fx.cacheSeed ?? {})) {
      const val = v?.value && typeof v.value === 'object' ? { ...v.value } : v?.value;
      if (val?.id != null) val.id = this.id(val.id, 2);
      cacheSeed[k.replace(/^gh\/id\/(\d+)$/, (_, id) => `gh/id/${this.id(id, 2)}`)] = { ...v, value: val };
    }
    const q = typeof fx.q === 'string' ? parseQuery(fx.q) : null;
    const qOut = q?.kind === 'ghid' ? `ghid:${this.id(q.id, 2)}` : q?.kind === 'x' ? `x:${this.id(q.id, 1)}` : fx.q;
    return { ...fx, q: qOut, cacheSeed, transcript };
  }

  /**
   * The ledger: every numeric id gets a synthetic one (random order), every account moves to its PDA,
   * the list is re-sorted by address.
   * @param {{ pubkey: string, lamports: number, data: Uint8Array }[]} accounts
   */
  ledger(accounts) {
    this.assign(accounts.map((a) => socialUser(a.data)).filter((u) => u && /^\d+$/.test(u.userId) && u.platform != null));
    return accounts.map((a) => {
      const data = this.account(a.data);
      const u = socialUser(data);
      return u && u.platform != null ? { ...a, pubkey: findSocialFeePda(u.userId, u.platform)[0], data } : { ...a, pubkey: this.address(a.pubkey), data };
    }).sort((x, y) => (x.pubkey < y.pubkey ? -1 : x.pubkey > y.pubkey ? 1 : 0));
  }
}

const bytesOf = (b64) => { const buf = Buffer.from(b64, 'base64'); return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength); };
/** { userId, platform } of raw SocialFeePda bytes (platform null when the slice ends before it), else null. */
function socialUser(b) {
  if (b.length < 14 || latin1(b, 0, 8) !== SFP_DISC) return null;
  const len = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(10, true);
  if (len > 20 || 14 + len > b.length) return null;
  return { userId: new TextDecoder().decode(b.subarray(14, 14 + len)), platform: 14 + len < b.length ? b[14 + len] : null };
}

function* metaTexts(k, j) {
  if (isDas(k)) {
    const list = Array.isArray(j?.result) ? j.result : [j?.result];
    for (const a of list) {
      const md = a?.content?.metadata;
      if (md) yield { name: md.name, symbol: md.symbol, description: md.description };
    }
  } else if (Array.isArray(j)) {
    for (const p of j) {
      for (const t of [p.baseToken, p.quoteToken]) if (t) yield { name: t.name, symbol: t.symbol };
      for (const s of p.info?.socials ?? []) if (s?.url) yield { description: s.url };
      for (const w of p.info?.websites ?? []) if (w?.url) yield { description: w.url };
    }
  }
}
