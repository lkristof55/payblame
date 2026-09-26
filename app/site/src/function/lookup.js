// The function UI: one input grammar, one printout. Loading, empty and error states print in the CLI's voice.
import { lookup, ledger as getLedger, parseQuery } from './api.js';

export const LISTED = 'listed != involved: recipients did not necessarily launch, endorse or know about these coins.';
export const NOT_PAID = 'not on-chain is not the same as not paid: an intermediary may forward fees off-chain.';

const head = (t) => (t.startsWith('#') ? 'head' : '');

// ---------------------------------------------------------------- one redaction style
// The API masks with runs of '#' (older builds: login 14, handle and symbol 10, SocialFeePda prefix 8, address 44;
// current: 4). On the site every mask prints as the same short `####`: github:####, x:####, x:@####, $####, @####,
// and a masked SocialFeePda column at the start of a blame row prints as `pda:####` (8 characters, so the columns
// stay aligned). When a mask is followed by column padding, the padding grows by what the mask lost.
export const MASK = '####';
const MASK_RUN = /(^|[^#\w])(github:@?|x:@|x:#|\$|@|)(#{4,})( *)/g;
export function squeeze(t) {
  if (t == null) return '';
  const s = String(t);
  if (!s.includes(MASK)) return s;
  return s.replace(MASK_RUN, (m, pre, tag, run, sp, at) => {
    const col = !tag && at === 0 && sp.length > 0 && run.length <= 8 && run.length + sp.length >= 8;
    const short = col ? `pda:${MASK}` : tag === 'x:#' ? `x:${MASK}` : `${tag}${MASK}`;
    const was = tag.length + run.length + sp.length;
    const pad = col || sp.length >= 2 ? ' '.repeat(Math.max(1, was - short.length)) : sp;
    return `${pre}${short}${pad}`;
  });
}
// a masked id or address from the API: null, '' or all '#'
export const isMasked = (v) => v == null || v === '' || /^#+$/.test(String(v).replace(/^@/, ''));

// blame[] verbatim (masks squeezed), with classes for the three inks
export function blameLines(blame = []) {
  return blame.map((t) => squeeze(t)).map((t) => ({ t, cls: head(t), mutable: t.includes('MUTABLE') }));
}
export function diffLines(diff = []) {
  return diff.map(squeeze).map((t) => {
    if (t.startsWith('---') || t.startsWith('+++')) return { t, cls: 'em' };
    if (t.startsWith('-')) return { t, cls: 'minus' };
    if (t.startsWith('+')) return { t, cls: 'plus' };
    if (t.startsWith('~')) return { t, cls: 'tilde' };
    return { t, cls: '' };
  });
}
export function metaLine(meta) {
  if (!meta || !meta.timingMs) return null;
  const m = meta.timingMs;
  return { t: `# done in ${m.total} ms / ${meta.rpcCalls} rpc calls / resolve ${m.resolve} probes ${m.probes} accounts ${m.accounts} metadata ${m.metadata}${meta.cached ? ' / cached' : ''}`, cls: 'faded' };
}
// ---------------------------------------------------------------- redaction
// A feed the visitor did not ask for never names a person. The ledger ranks accounts by unclaimed SOL, so
// every ledger row prints its login as a fixed-width mask (the length of a login is a clue too); the row id,
// the user/org type and the numbers stay. A real login or a declared @handle prints only as the answer to the
// visitor typing that login, id, wallet or mint.
export function redact(t) {
  return squeeze(t)
    .replace(/\bgithub:@?[#A-Za-z0-9](?:[#A-Za-z0-9]|-(?=[#A-Za-z0-9]))*( *)/g, (m, sp) => `github:${MASK}${sp.length >= 2 ? ' '.repeat(Math.max(1, m.length - 7 - MASK.length)) : sp}`)
    .replace(/\bx:@[#A-Za-z0-9_]+/g, `x:@${MASK}`)
    .replace(/\bx:#\d+/g, `x:${MASK}`);
}
export const redactLines = (lines) => lines.map((l) => (l.html ? l : { ...l, t: redact(l.t) }));

// An auto-run coin job (nobody typed the mint): on top of redact(), every login the split pays and every
// handle the coin declares is masked wherever it appears (the symbol can spell the handle too).
export function autoRedactor(r) {
  const words = new Set();
  for (const d of r?.declared || []) if (d?.handle) words.add(String(d.handle).replace(/^@/, ''));
  for (const s of r?.config?.shareholders || []) if (s?.login) words.add(String(s.login));
  const list = [...words].filter((w) => w.length >= 2 && /[A-Za-z0-9]/.test(w)).sort((a, b) => b.length - a.length);
  const rx = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = list.length ? new RegExp(`(^|[^A-Za-z0-9_#])(?:${list.map(rx).join('|')})(?![A-Za-z0-9_])`, 'gi') : null;
  const fn = (t) => { const s = redact(t); return re ? s.replace(re, (_, pre) => `${pre}${MASK}`) : s; };
  fn.lines = (lines) => lines.map((l) => (l.html ? l : { ...l, t: fn(l.t) }));
  return fn;
}

const lsol = (l) => (Number(l || 0) / 1e9).toFixed(3);
const day = (iso) => (iso ? String(iso).slice(0, 10) : 'never');
// Format L, built here from the structured rows (never from a server string that may carry logins):
//   row:6efe6fc2 (github:#### user) unclaimed=1869.443 claimed=0.000    last=never
// The server masks the ledger too (login '##############', rowId instead of the pda); this mask is a second lock.
// Rows carry cls 'lrow' so a row sets one line on the 760 px sheet at 1440 (style.css).
export function ledgerRowLine(r) {
  const type = r.accountType === 'Organization' ? 'org ' : r.accountType === 'User' ? 'user' : '?   ';
  const id = r.rowId || (r.socialFeePda && !isMasked(r.socialFeePda) ? String(r.socialFeePda).slice(0, 8) : `row:${MASK}`.padEnd(12));
  return `${id} (github:${MASK} ${type}) unclaimed=${lsol(r.unclaimedLamports).padEnd(8)} claimed=${lsol(r.totalClaimedLamports).padEnd(8)} last=${day(r.lastClaimedAt)}`;
}
export function ledgerHead(L) {
  const g = L.github || {};
  return [
    `# payblame --ledger ${String(L.snapshotAt).slice(0, 16)}Z github-recipients=${g.accounts ?? '?'} logins=masked`,
    `# unclaimed=${lsol(g.unclaimedLamports)} claimed=${lsol(g.totalClaimedLamports)} never-claimed=${g.neverClaimed ?? '?'} (SOL)`,
  ];
}
export function ledgerBlame(L, n = 25) {
  const rows = Array.isArray(L.topUnclaimed) && L.topUnclaimed.length
    ? L.topUnclaimed.slice(0, n).map(ledgerRowLine)
    : (L.blame || []).slice(2, 2 + n).map(redact);
  return [...ledgerHead(L), ...rows];
}
const isRow = (t) => /^row:|^[1-9A-HJ-NP-Za-km-z]{8} \(/.test(t);
export const REDACTED = `# logins withheld as github:${MASK}. type one to print it.`;
export function ledgerPrint(L) {
  const lines = blameLines(ledgerBlame(L)).map((l) => (isRow(l.t) ? { ...l, cls: `${l.cls} lrow`.trim() } : l));
  return [...lines, { t: REDACTED, cls: 'faded' }, { t: LISTED, cls: 'faded' }];
}

export function resultLines(r, { q } = {}) {
  const out = [];
  if (r.kind === 'recipient') {
    out.push(...blameLines(r.blame).map((l) => (l.cls === 'head' ? l : { ...l, row: true })));
    const t = r.totals || {};
    if (t.truncated) out.push({ t: `# listed ${t.listed} of ${t.coins} (first ${t.listed} by config address). the count is exact.`, cls: 'faded' });
    const who = r.recipient?.login ? `github:${isMasked(r.recipient.login) ? MASK : r.recipient.login}` : q;
    if (!t.coins) out.push({ t: squeeze(`nothing routes to ${who}. the chain has no line to blame.`), cls: '' });
    const ml = metaLine(r.meta); if (ml) out.push(ml);
    if (t.coins) out.push({ t: LISTED, cls: 'faded' });
  } else if (r.kind === 'coin') {
    out.push(...blameLines(r.blame));
    if (!r.config) out.push({ t: noShareSentence(r), cls: 'prose' });
    if (r.diff && r.diff.length) {
      out.push({ t: '' }, ...diffLines(r.diff));
      out.push({ t: NOT_PAID, cls: 'prose' });
    }
    const ml = metaLine(r.meta); if (ml) out.push(ml);
    out.push({ t: LISTED, cls: 'faded' });
  }
  return out;
}

// a mint with no SharingConfig: the one sentence a trader needs, built from the response
export function noShareSentence(r) {
  const w = r.curve?.creator;
  const who = w && !isMasked(w) ? `its creator wallet ${w.slice(0, 4)}..${w.slice(-4)}` : 'its creator wallet';
  const pend = r.vaults ? ` ${lsol(r.vaults.pendingLamports)} SOL is pending in its creator vaults right now.` : '';
  return `In plain words: ${r.symbol ? squeeze('$' + r.symbol) : 'this coin'} does not share its creator fees. No GitHub or X account is paid by it; ${who} collects every creator fee directly.${pend}`;
}

export function errorLine(res, q, parsed) {
  const b = res.body || {};
  switch (b.code) {
    case 'BAD_INPUT': return { t: `? '${q}' is not a login, mint or wallet. try your own github login, a pump mint, or ghid:<id>.`, cls: 'err' };
    case 'GITHUB_NOT_FOUND': return { t: `? github has no user ${parsed?.q || q}. check the spelling or try ghid:<id>.`, cls: 'err' };
    case 'NOT_PUMP': return { t: `? ${q.slice(0, 8)}..${q.slice(-4)} is not a pump.fun mint: no bonding curve, no SharingConfig.`, cls: 'err' };
    case 'GITHUB_RATE_LIMIT': return { t: `? github rate limit. retry in ${b.retryAfterSeconds ?? 60} s, or use ghid:<id>.`, cls: 'err' };
    default: return { t: 'PAPER OUT. the rpc did not answer in 8 s. press print again.', cls: 'err', out: true };
  }
}

// A login with 100 coins prints its first 20 rows inline; the rest wait behind a print-all key.
export const CAP = 20;
export function capRows(lines, cap = CAP) {
  const rows = lines.filter((l) => l.row);
  if (rows.length <= cap + 2) return lines;
  const held = rows.slice(cap);
  const at = lines.indexOf(held[0]);
  const rest = lines.slice(at).filter((l) => !l.row);
  return [...lines.slice(0, at), { t: `# ${held.length} more rows held back here. print all, or run the cli: it prints every row.`, cls: 'faded more', more: held }, ...rest];
}

// Wire an input strip + printout. hooks: busy(on), result(r), out(on)
export function wireLookup({ form, input, tries = [], printout, hooks = {}, getLedger: ledgerFn = getLedger }) {
  let running = 0;
  async function run(raw) {
    const q = String(raw ?? input.value).trim();
    input.value = q;
    const my = ++running;
    printout.clear(); printout.setQuery(q || 'ledger');
    if (q === '--ledger') {
      await printout.print([{ t: '$ payblame --ledger', cls: 'cmd' }]);
      const stop = printout.status('reading the snapshot of every SocialFeePda ...');
      hooks.busy?.(true);
      const res = await ledgerFn();
      if (my !== running) return; stop(); hooks.busy?.(false);
      if (!res.ok) { hooks.out?.(true); await printout.print([{ t: 'PAPER OUT. ledger snapshot unavailable. lookups still work.', cls: 'err' }]); return; }
      hooks.out?.(false);
      const lines = ledgerPrint(res.body);
      hooks.result?.({ kind: 'ledger', lines, body: res.body });
      await printout.print(lines);
      return;
    }
    const parsed = parseQuery(q);
    if (!parsed) {
      form.classList.remove('bad'); void form.offsetWidth; form.classList.add('bad');
      await printout.print([{ t: `$ payblame ${q}`, cls: 'cmd' }, { t: q ? `? '${q}' is not a login, mint or wallet. try your own github login, a pump mint, or ghid:<id>.` : '? payblame needs a login, a mint or a wallet. try your own github login.', cls: 'err' }]);
      return;
    }
    await printout.print([{ t: `$ payblame ${q}`, cls: 'cmd' }]);
    const stages = parsed.kind === 'address'
      ? [`reading ${parsed.label} (mint, wallet or fee account) ...`, 'probing 10 slots at +80 + 34i ...', 'decoding configs, reading vaults ...']
      : parsed.kind === 'x' ? [`deriving the social fee account for ${parsed.label} ...`, 'probing 10 slots at +80 + 34i ...', 'decoding configs, reading vaults ...']
        : [`resolving ${parsed.label} ...`, 'probing 10 slots at +80 + 34i ...', 'decoding configs, reading vaults ...'];
    const stops = [];
    let k = 0;
    const tick = () => { if (k < stages.length && my === running) stops.push(printout.status(stages[k++])); };
    tick(); const iv = setInterval(tick, 450);
    hooks.busy?.(true);
    const res = await lookup(q);
    clearInterval(iv);
    if (my !== running) return;
    stops.forEach((s) => s());
    hooks.busy?.(false);
    if (!res.ok) {
      const e = errorLine(res, q, parsed);
      hooks.out?.(!!e.out);
      await printout.print([e]);
      return;
    }
    hooks.out?.(false);
    const lines = capRows(resultLines(res.body, { q }));
    hooks.result?.({ kind: res.body.kind, lines, body: res.body });
    await printout.print(lines);
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  for (const b of tries) b.addEventListener('click', () => { input.value = b.dataset.q; run(b.dataset.q); });
  return { run };
}
