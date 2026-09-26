// The contract (concept.json api[]): GET /api/lookup?q=&limit=, GET /api/ledger.
// Every call has a timeout; errors come back as { error, code, retryAfterSeconds? }.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58len(s) {
  let bytes = [0];
  for (const ch of s) {
    const v = B58.indexOf(ch); if (v < 0) return -1;
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 255; carry >>= 8; }
    while (carry) { bytes.push(carry & 255); carry >>= 8; }
  }
  let zeros = 0; for (const ch of s) { if (ch === '1') zeros++; else break; }
  let n = bytes.length; while (n > 1 && bytes[n - 1] === 0) n--;
  return zeros + (bytes.length === 1 && bytes[0] === 0 ? 0 : n);
}

// Client-side mirror of the server grammar. Returns { q, kind, label } or null.
export function parseQuery(raw) {
  const q = String(raw || '').trim();
  if (!q || q.length > 64) return null;
  let m;
  if ((m = /^github:([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})$/.exec(q))) return { q, kind: 'github', label: `github:${m[1]}` };
  if ((m = /^ghid:(\d{1,20})$/.exec(q))) return { q, kind: 'ghid', label: `github:#${m[1]}` };
  if ((m = /^x:(\d{1,20})$/.exec(q))) return { q, kind: 'x', label: `x:#${m[1]}` };
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q) && b58len(q) === 32) return { q, kind: 'address', label: `${q.slice(0, 8)}..${q.slice(-4)}` };
  const s = q.startsWith('@') ? q.slice(1) : q;
  if (/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(s)) return { q: s, kind: 'login', label: `github:${s}` };
  return null;
}

async function getJSON(url, ms) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { accept: 'application/json' } });
  } catch (e) {
    return { ok: false, status: 0, body: { error: 'network', code: 'UPSTREAM' } };
  }
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok || !body) return { ok: false, status: res.status, body: body && body.code ? body : { error: `HTTP ${res.status}`, code: 'UPSTREAM' } };
  return { ok: true, status: res.status, body };
}

// mask: an auto-run job (nobody typed q). The server masks logins and declared handles when it knows ?mask=1;
// the client masks them again either way (lookup.js autoRedactor).
export const lookup = (q, limit = 100, { mask = false } = {}) => getJSON(`/api/lookup?q=${encodeURIComponent(q)}&limit=${limit}${mask ? '&mask=1' : ''}`, 30000);
export const ledger = () => getJSON('/api/ledger', 30000);

export const sol = (l) => (Number(l || 0) / 1e9).toFixed(3);
export const solComma = (l) => {
  const [a, b] = sol(l).split('.');
  return `${a.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${b}`;
};
export const intComma = (n) => String(n ?? 0).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
