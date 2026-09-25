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
//
// Other chain data (account bytes, PDAs, numeric ids, lamports) is left exactly as recorded, so the
// replay still exercises the real decode path. The real -> placeholder map lives in memory only.
import { extractDeclared } from '../../src/declared.js';
import { parseQuery } from '../../src/query.js';

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
    if (taken.has(pubkey)) throw new Error(`placeholder PDA collides with a recorded account: ${p}`);
    taken.add(pubkey);
    return { ...a, pubkey, data };
  });
  return { accounts: out, replaced: n };
}

export const LEDGER_NOTE = 'GitHub logins (resolved from numeric ids) are replaced by sample-login-NN. Numeric user_ids, types and lamports are as recorded. The accounts whose on-chain user_id is text (a handle, a name or a URL, not a numeric id) carry a same-length placeholder (sample_x_0007, ~07) and the PDA of that placeholder, so the fixture names no account; their lamports, platform and claim fields are as recorded.';

export const SCRUB_NOTE ='GitHub logins -> sample-login-NN (keyed by numeric id, same in every fixture); declared handles -> sample_handle; GitHub/DAS/DexScreener bodies trimmed to the fields payblame reads. Chain data, ids and lamports are as recorded.';

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
