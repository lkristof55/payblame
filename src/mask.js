// Masking a lookup result for output nobody asked for (an auto-run demo, a feed, a screenshot).
// A masked result carries no GitHub login, no declared @handle, no social user id and no
// SocialFeePda address (the PDA's account data holds the user id). Numbers, bps, mints, the
// SharingConfig, vaults, claim records and the structure stay, so the output still explains the coin.
// Pure: returns a copy; masking a masked result is a no-op.
import { MASK, LOGIN_MASK, formatBlame, formatCoin, shareholderLabel, ticker } from './format.js';

/** One fixed-width mask for everything (MASK = '####'): the length of a login or handle is a clue too. */
export const HANDLE_MASK = MASK;
export const ADDRESS_MASK = MASK;
export const MASK_NOTE = 'Logins, handles, social user ids and SocialFeePda addresses are masked (mask=1). Look up a specific login, id, wallet or mint without mask to see who it is.';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word, case-insensitive replacer for a set of words -> their masks. */
function replacer(pairs) {
  const list = [...pairs].filter(([w]) => w && w.length).sort((a, b) => b[0].length - a[0].length)
    .map(([w, m]) => [new RegExp(`(?<![A-Za-z0-9_-])${esc(w)}(?![A-Za-z0-9_-])`, 'gi'), m]);
  return (s) => {
    if (typeof s !== 'string') return s;
    let out = s;
    for (const [re, m] of list) out = out.replace(re, m);
    return out;
  };
}

const isSocial = (s) => s && s.kind !== 'wallet';
const maskedHolder = (s) => ({ ...s, address: ADDRESS_MASK, userId: null, login: s.kind === 'github' ? LOGIN_MASK : null, masked: true });

function maskCoin(c) {
  const holders = c.config?.shareholders ?? [];
  const words = new Map();
  for (const d of c.declared ?? []) if (d.handle) words.set(d.handle, HANDLE_MASK);
  for (const s of holders) if (s.login) words.set(s.login, LOGIN_MASK);
  const text = replacer(words);

  const shareholders = holders.map((s) => (isSocial(s) ? maskedHolder(s) : { ...s }));
  const out = {
    ...c,
    name: text(c.name),
    symbol: text(ticker(c.symbol)),
    description: text(c.description),
    config: c.config ? { ...c.config, shareholders } : null,
    declared: (c.declared ?? []).map((d) => ({ ...d, handle: HANDLE_MASK })),
  };
  // diff lines are built from exact labels, so swap the exact strings
  const labelSwap = new Map(holders.map((s, i) => [`+ ${shareholderLabel(s)} ${s.bps}bps`, `+ ${shareholderLabel(shareholders[i])} ${s.bps}bps`]));
  const handleSwap = replacer((c.declared ?? []).map((d) => [d.handle, HANDLE_MASK]));
  out.diff = (c.diff ?? []).map((l) => labelSwap.get(l) ?? (/^[-~ ] /.test(l) ? handleSwap(l) : l));
  // blame: rebuilt from the masked result; the vault line (index 1) has no identity and needs rent0, so keep it
  const regen = formatCoin(out, { rent0: 0 });
  out.blame = out.config ? regen.map((l, i) => (i === 1 ? c.blame[1] : l)) : regen;
  return out;
}

function maskRecipient(r) {
  const rec = r.recipient;
  if (rec.type === 'wallet') {
    // a wallet is not a login; still mask co-recipients (they can be SocialFeePdas)
    const out = { ...r, coins: r.coins.map((c) => ({ ...c, coRecipients: c.coRecipients.map((x) => ({ ...x, address: ADDRESS_MASK })) })) };
    out.blame = formatBlame(out);
    return out;
  }
  const text = replacer(rec.login ? [[rec.login, LOGIN_MASK]] : []);
  const recipient = { ...rec, address: ADDRESS_MASK, userId: null, login: rec.type === 'github' ? LOGIN_MASK : null, masked: true };
  const coins = r.coins.map((c) => ({ ...c, name: text(c.name), symbol: text(ticker(c.symbol)), coRecipients: c.coRecipients.map((x) => ({ ...x, address: ADDRESS_MASK })) }));
  const label = rec.type === 'github' ? 'github' : rec.type === 'x' ? 'x' : `social:${rec.platform}`;
  const out = { ...r, query: `${label}:${LOGIN_MASK}`, recipient, coins };
  const lines = formatBlame(out);
  lines[0] = `# payblame ${label}:${LOGIN_MASK} type=${rec.accountType ?? 'unknown'} logins=masked`;
  out.blame = lines;
  return out;
}

/**
 * Mask a lookup() result (coin or recipient). Adds masked: true, logins: 'masked' and loginsNote.
 * @template T
 * @param {T} result
 * @returns {T}
 */
export function maskLookup(result) {
  if (!result || typeof result !== 'object' || result.masked) return result && { ...result };
  const out = result.kind === 'coin' ? maskCoin(result) : result.kind === 'recipient' ? maskRecipient(result) : { ...result };
  return { ...out, masked: true, logins: 'masked', loginsNote: MASK_NOTE };
}
