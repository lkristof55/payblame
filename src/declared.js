// Who a coin *says* it pays (handles in its name, symbol and description) versus who its
// SharingConfig *does* pay. Pure functions.
import { LOGIN_RE } from './query.js';

const SOURCES = ['name', 'symbol', 'description'];
const GH_URL = /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?![A-Za-z0-9-])/gi;
const X_URL = /(?:^|[^A-Za-z0-9_.])(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/gi;
const AT = /(?:^|[^A-Za-z0-9_@./])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g;
const X_RESERVED = new Set(['i', 'home', 'intent', 'search', 'share', 'hashtag', 'explore', 'settings']);
const GH_RESERVED = new Set(['orgs', 'users', 'settings', 'topics', 'features', 'about', 'pricing', 'sponsors', 'marketplace', 'login']);

/**
 * Extract declared recipients from coin metadata.
 * github.com/<login> -> github; x.com/<h> or twitter.com/<h> -> x; a bare @<h> -> x.
 * @param {{ name?: string|null, symbol?: string|null, description?: string|null }} meta
 * @returns {{ platform: 'x'|'github', handle: string, source: 'name'|'symbol'|'description' }[]}
 */
export function extractDeclared(meta = {}) {
  const out = [];
  const seen = new Set();
  const add = (platform, handle, source) => {
    const k = `${platform}:${handle.toLowerCase()}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ platform, handle, source });
  };
  for (const source of SOURCES) {
    const text = typeof meta[source] === 'string' ? meta[source] : '';
    if (!text) continue;
    for (const m of text.matchAll(GH_URL)) if (!GH_RESERVED.has(m[1].toLowerCase()) && LOGIN_RE.test(m[1])) add('github', m[1], source);
    for (const m of text.matchAll(X_URL)) if (!X_RESERVED.has(m[1].toLowerCase())) add('x', m[1], source);
    for (const m of text.matchAll(AT)) add('x', m[1], source);
  }
  return out;
}

/** Display label of an on-chain recipient. */
export function recipientLabel(s) {
  if (s.kind === 'github') return s.login ? `github:${s.login}` : `github:#${s.userId}`;
  if (s.kind === 'x') return `x:#${s.userId}`;
  if (s.kind === 'social') return `social:${s.platform}:#${s.userId}`;
  return `wallet:${s.address.slice(0, 4)}..${s.address.slice(-4)}`;
}

/**
 * Compare declared handles to on-chain shareholders.
 * status: 'match' (a github handle equal, case-insensitive, to an on-chain GitHub login),
 * 'unverifiable' (an x handle while the config has an x shareholder: x ids are numeric on-chain),
 * 'absent' (otherwise). mismatch = some absent.
 * @param {ReturnType<typeof extractDeclared>} declared
 * @param {{ address: string, bps: number, kind: string, login?: string|null, userId?: string|null, platform?: number|null }[]} shareholders
 */
export function diffDeclared(declared, shareholders) {
  const ghLogins = new Map();
  for (const s of shareholders) if (s.kind === 'github' && s.login) ghLogins.set(s.login.toLowerCase(), s);
  const hasX = shareholders.some((s) => s.kind === 'x');
  const matched = new Set();
  const withStatus = declared.map((d) => {
    let status = 'absent';
    if (d.platform === 'github' && ghLogins.has(d.handle.toLowerCase())) {
      status = 'match';
      matched.add(ghLogins.get(d.handle.toLowerCase()).address);
    } else if (d.platform === 'x' && hasX) status = 'unverifiable';
    return { ...d, status };
  });
  const mismatch = withStatus.some((d) => d.status === 'absent');
  const diff = [];
  if (withStatus.length) {
    diff.push('--- declared (name/symbol/description)', '+++ on-chain (SharingConfig)');
    for (const d of withStatus) {
      if (d.status === 'absent') diff.push(`- ${d.platform}:@${d.handle}`);
      else if (d.status === 'match') diff.push(`  ${d.platform}:@${d.handle}`);
      else diff.push(`~ x:@${d.handle} (x ids are numeric on-chain)`);
    }
    for (const s of shareholders) if (!matched.has(s.address)) diff.push(`+ ${recipientLabel(s)} ${s.bps}bps`);
  }
  return { declared: withStatus, mismatch, diff };
}
