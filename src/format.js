// git-blame-style text output (ASCII only). The CLI prints these lines and the API returns them
// in `blame`, so the site and the terminal show the same bytes.

export const fmtSol = (lamports) => (Number(lamports) / 1e9).toFixed(3);
export const fmtDate = (iso) => (iso ? iso.slice(0, 10) : 'never');
/** Replace anything outside printable ASCII (emoji, CJK, control chars) with '?'. */
export const ascii = (s) => String(s ?? '').replace(/[^\x20-\x7e]/gu, '?');
const short = (a) => `${a.slice(0, 8)}..${a.slice(-6)}`;
/** A ticker without its '$' sigil (some pump.fun symbols are stored as "$RapCat"), so '$' + ticker never prints "$$". */
export const ticker = (s) => {
  if (s == null) return null;
  const t = String(s).trim().replace(/^\$+/, '').trim();
  return t || null;
};

export function recipientHeaderLabel(r) {
  if (r.masked) return `${r.type === 'social' ? `social:${r.platform}` : r.type}:${LOGIN_MASK}`;
  if (r.type === 'github') return r.login ? `github:${r.login}` : `github:#${r.userId}`;
  if (r.type === 'x') return `x:#${r.userId}`;
  if (r.type === 'social') return `social:${r.platform}:#${r.userId}`;
  return `wallet:${r.address.slice(0, 4)}..${r.address.slice(-4)}`;
}

/** Format A: recipient blame. */
export function formatBlame(b) {
  const r = b.recipient;
  const a = b.account;
  const lines = [];
  if (r.type === 'wallet') lines.push(`# payblame wallet:${r.address.slice(0, 4)}..${r.address.slice(-4)} address=${r.address}`);
  else lines.push(`# payblame ${ascii(recipientHeaderLabel(r))} id=${r.userId} type=${r.accountType ?? 'unknown'} pda=${short(r.address)}`);
  const social = r.type !== 'wallet';
  const t = b.totals;
  lines.push(
    `# coins=${t.coins} listed=${t.listed}${t.truncated ? ' (truncated)' : ''}` +
    ` unclaimed=${social ? fmtSol(a.unclaimedLamports ?? 0) : 'n/a'}` +
    ` claimed=${social ? fmtSol(a.totalClaimedLamports ?? 0) : 'n/a'}` +
    ` last-claim=${social ? fmtDate(a.lastClaimedAt) : 'n/a'}` +
    ` pending=${fmtSol(t.pendingForRecipientLamports)} SOL`,
  );
  for (const c of b.coins) {
    lines.push(
      `${c.mint.slice(0, 8)} (${ascii(ticker(c.symbol) ?? '?').slice(0, 10).padEnd(10)} ${String(c.bps).padStart(5)}bps ` +
      `${c.slot + 1}/${c.shareholderCount} ${c.adminRevoked ? 'locked ' : 'MUTABLE'}) ${fmtSol(c.pendingForRecipientLamports).padStart(10)} SOL pending`,
    );
  }
  return lines;
}

/** Format B: coin blame (without the diff, which lives in CoinBlame.diff). */
export function formatCoin(c, { rent0 = 0 } = {}) {
  const mint = `${c.mint.slice(0, 8)}..${c.mint.slice(-4)}`;
  const sym = ascii(ticker(c.symbol) ?? '?');
  if (!c.config) {
    const cr = c.curve.creator;
    const lines = [`# payblame ${mint} $${sym} no SharingConfig: legacy creator`];
    if (cr) lines.push(`${cr.slice(0, 8)} (${`wallet:${cr.slice(0, 4)}..${cr.slice(-4)}`.padEnd(24)} ${'10000'.padStart(5)}bps) paid directly on collect`);
    return lines;
  }
  const cfg = c.config;
  const lines = [
    `# payblame ${mint} $${sym} "${ascii(c.name ?? '?')}" config=${c.sharingConfig.slice(0, 8)} v${cfg.version} ${cfg.status} ${cfg.adminRevoked ? 'locked' : 'MUTABLE'}`,
    `# vault pending=${fmtSol(c.vaults.pendingLamports)} SOL (pump ${fmtSol(Math.max(0, c.vaults.pumpVaultLamports - rent0))} + pumpswap ${fmtSol(c.vaults.ammVaultLamports)})`,
  ];
  for (const s of cfg.shareholders) {
    const label = ascii(shareholderLabel(s));
    const tail = s.kind === 'wallet'
      ? 'paid directly on distribute'
      : `claimed=${fmtSol(s.totalClaimedLamports ?? 0)} unclaimed=${fmtSol(s.unclaimedLamports ?? 0)} last=${fmtDate(s.lastClaimedAt)}`;
    lines.push(`${s.address.slice(0, 8).padEnd(8)} (${label.slice(0, 24).padEnd(24)} ${String(s.bps).padStart(5)}bps) ${tail}`);
  }
  return lines;
}

export function shareholderLabel(s) {
  if (s.masked) return `${s.kind === 'social' ? `social:${s.platform}` : s.kind}:${LOGIN_MASK}`;
  if (s.kind === 'github') return s.login ? `github:${s.login}` : `github:#${s.userId}`;
  if (s.kind === 'x') return `x:#${s.userId}`;
  if (s.kind === 'social') return `social:${s.platform}:#${s.userId}`;
  return `wallet:${s.address.slice(0, 4)}..${s.address.slice(-4)}`;
}

/**
 * The one mask payblame prints for anything that identifies an account (a login, a declared handle,
 * a social user id, a SocialFeePda address, a word of a coin name that spells one of those):
 * 4 '#', whatever the real length, because the length of a login is a clue too.
 */
export const MASK = '####';
/** The login mask used when a ledger is masked (the default). Same as MASK. */
export const LOGIN_MASK = MASK;

/**
 * Format L: the network ledger header plus the top-unclaimed rows. Numbers are key=value
 * (`unclaimed=1869.443`), never a label before a number, so no crop can pair a login with
 * the wrong amount. A masked ledger (the default) says so in line 1 and prints row ids.
 */
export function formatLedger(l) {
  const lines = [
    `# payblame --ledger ${l.snapshotAt.slice(0, 16)}Z github-recipients=${l.github.accounts}${l.logins === 'masked' ? ' logins=masked' : ''}`,
    `# unclaimed=${fmtSol(l.github.unclaimedLamports)} claimed=${fmtSol(l.github.totalClaimedLamports)} never-claimed=${l.github.neverClaimed} (SOL)`,
  ];
  for (const r of l.topUnclaimed) lines.push(ledgerRow(r));
  return lines;
}

export function ledgerRow(r) {
  const id = r.masked ? r.rowId : r.socialFeePda.slice(0, 8);
  const who = ascii(`github:${r.masked ? LOGIN_MASK : r.login ?? '#' + r.githubId}`).slice(0, 28).padEnd(28);
  const type = r.accountType === 'Organization' ? 'org ' : r.accountType === 'User' ? 'user' : '?   ';
  return `${id} (${who} ${type}) ${`unclaimed=${fmtSol(r.unclaimedLamports)}`.padEnd(19)} ${`claimed=${fmtSol(r.totalClaimedLamports)}`.padEnd(17)} last=${fmtDate(r.lastClaimedAt)}`;
}
