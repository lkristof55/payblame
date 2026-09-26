// Static-but-real material for the beats: the SharingConfig layout (pump_fees IDL), the hex dump of a
// recorded mainnet account (recipient keys replaced by SAMPLE keys), and code copied verbatim from the library's src/.

export const REPO_URL = 'https://github.com/lkristof55/payblame'; // public on GitHub since 2026-09-26
// Empty until launch. `npm run build` inlines the TOKEN_MINT env var here (scripts/build.mjs defines __TOKEN_MINT__),
// so setting it on Netlify and redeploying goes live. When set, the repo block shows the CA and BLAME THIS COIN.
// eslint-disable-next-line no-undef
export const TOKEN_MINT = typeof __TOKEN_MINT__ === 'string' ? __TOKEN_MINT__ : '';
export const DEMO_MINT = 'J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpump';

export const LAYOUT = [
  { t: '# SharingConfig  1024 bytes  owner pump_fees', cls: 'head' },
  { t: 'offset    size  field', cls: 'faded' },
  { t: '0         8     discriminator  d8 4a 09 00 38 8c 5d 4b' },
  { t: '8         1     bump' },
  { t: '9         1     version' },
  { t: '10        1     status         0 paused / 1 active' },
  { t: '11        32    mint' },
  { t: '43        32    admin' },
  { t: '75        1     admin_revoked  1 = locked, 0 = MUTABLE', mutable: true },
  { t: '76        4     vec len (u32)' },
  { t: '80+34i    32    shareholder[i].address', cls: 'em band' },
  { t: '112+34i   2     shareholder[i].bps (u16 LE)', cls: 'em' },
  { t: '# 10 slots max, bps sum to 10000, the rest is zero padding', cls: 'faded' },
];

// SharingConfig 4MQJzmfJ8D4s4EFPgXCxgM8VzJDtikjHqfGaLTECab2P as recorded on mainnet, first 420 bytes (base64), with
// the admin key (+43), shareholder 0 (+80, the same wallet) and shareholder 1 (+114, a GitHub SocialFeePda) replaced
// by SAMPLE keys of the same length, so no real recipient ships here. Every other byte is as recorded.
const RAW = '2EoJADiMXUv/AgGtdtkxF786o3VkkeEbuYtuNhRiE2Gmy5yM9FuMegQSB9y5sEniR9bYutSIdpuK+8+bajMM0G54VKRlL7t2wtL1AQIAAADcubBJ4kfW2LrUiHabivvPm2ozDNBueFSkZS+7dsLS9awmkfZD4bBVQIV8RTCYwwdFXaBil7G2Fuw+AL7r+79cs8lkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
export const HEX_ACCOUNT = '4MQJzmfJ8D4s4EFPgXCxgM8VzJDtikjHqfGaLTECab2P';

// One html line per 16 bytes (8 on a phone) from 0x40 to 0x1af. Each 34-byte window (slot i at 80 + 34i) is
// wrapped in a span the ring beat can light as its pin strikes. Windows with data are emphasized, empty ones faded.
// On a phone the annotations print on their own faded line under the row, so nothing runs off the paper.
export function hexLines({ perRow = 16 } = {}) {
  const bin = Uint8Array.from(atob(RAW), (c) => c.charCodeAt(0));
  const slotOf = (b) => (b >= 80 && b < 420 ? Math.floor((b - 80) / 34) : -1);
  const used = (i) => { for (let b = 80 + 34 * i; b < 114 + 34 * i; b++) if (bin[b]) return true; return false; }; // bytes past 420 are zero padding (recorded tailAllZero)
  const narrow = perRow < 16;
  const out = [{ t: narrow ? `# ${HEX_ACCOUNT.slice(0, 6)}..${HEX_ACCOUNT.slice(-4)} v${bin[9]} 0x40-0x1af` : `# ${HEX_ACCOUNT.slice(0, 8)}..${HEX_ACCOUNT.slice(-6)}  SharingConfig v${bin[9]}  bytes 0x40-0x1af`, cls: 'head' }];
  for (let row = 0x40; row < 0x1b0; row += perRow) {
    let html = `<span class="br">${row.toString(16).padStart(4, '0')} </span>`; let text = `${row.toString(16).padStart(4, '0')} `;
    for (let b = row; b < row + perRow; b++) {
      const s = slotOf(b);
      const sep = b === 80 ? '[' : b === 420 ? ']' : (s >= 0 && (b - 80) % 34 === 0) ? '|' : ' ';
      const hx = (bin[b] ?? 0).toString(16).padStart(2, '0');
      html += `<span class="br">${sep}</span><span class="w ${s >= 0 && used(s) ? 'on' : 'off'}" data-slot="${s}">${hx}</span>`; text += sep + hx;
    }
    if (row + perRow === 0x1b0) { html += '<span class="br"> </span>'; }
    // annotations: where slots start, and the two bps values that are set
    const notes = [];
    for (let i = 0; i < 10; i++) { const o = 80 + 34 * i; if (o >= row && o < row + perRow) notes.push(`slot ${i} +${o}`); }
    const has = (o) => o >= row && o < row + perRow;
    if (has(75)) notes.push(narrow ? '+75 01 = locked / +76 len 2' : '+75 01 locked / +76 len 2');
    if (has(112)) notes.unshift(narrow ? 'ac 26 = 9900 bps' : '9900 bps');
    if (has(146)) notes.unshift(narrow ? '64 00 = 100 bps' : '100 bps');
    if (notes.length && !narrow) { html += `<span class="br">  ; ${notes.join(' / ')}</span>`; text += `  ; ${notes.join(' / ')}`; }
    out.push({ t: text, html });
    if (notes.length && narrow) out.push({ t: `     ; ${notes.join(' / ')}`, cls: 'faded note' });
  }
  return out;
}

// Verbatim from src/constants.js and src/blame.js at the repo root (payblame, MIT).
export const CODE = [
  ['// src/constants.js (excerpt)', 'cm'],
  ['  shareholders: 80, stride: 34, maxShareholders: 10,', ''],
  ['/** Offset of shareholder slot i: the memcmp position of the reverse-index probe. */', 'cm'],
  ['export const slotOffset = (i) => SHARING.shareholders + SHARING.stride * i;', 'band'],
  ['', ''],
  ['// src/blame.js', 'cm'],
  ['/** The reverse index: 10 memcmp probes, one per shareholder slot, pubkeys only. */', 'cm'],
  ['export async function probeSharingConfigs(rpc, recipient) {', ''],
  ['  const probes = await Promise.all(Array.from({ length: SHARING.maxShareholders }, (_, i) =>', ''],
  ['    rpc.getProgramAccounts(PUMP_FEES, {', ''],
  ['      dataSlice: { offset: 0, length: 0 },', ''],
  ['      filters: [{ memcmp: { offset: 0, bytes: DISC_B58.SharingConfig } }, { memcmp: { offset: slotOffset(i), bytes: recipient } }],', 'band'],
  ['    })));', ''],
  ['  const slotOf = new Map();', ''],
  ['  const hitsPerSlot = probes.map((list) => list.length);', ''],
  ['  probes.forEach((list, i) => { for (const { pubkey } of list) if (!slotOf.has(pubkey)) slotOf.set(pubkey, i); });', ''],
  ['  return { slotOf, hitsPerSlot };', ''],
  ['}', ''],
];

const KW = new Set(['export', 'async', 'function', 'const', 'await', 'return', 'for', 'of', 'if', 'new', 'probeSharingConfigs', 'slotOffset', 'getProgramAccounts']);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// ribbon syntax: emphasized (keywords, function names), normal, faded (comments, punctuation)
function ribbon(t) {
  const re = /(\/\/.*$|\/\*\*.*?\*\/)|([A-Za-z_$][\w$]*)|([{}()[\],;=>:.]+)|(\s+|.)/g;
  let h = ''; let m;
  while ((m = re.exec(t))) {
    if (m[1]) h += `<span class="cm">${esc(m[1])}</span>`;
    else if (m[2]) h += KW.has(m[2]) ? `<span class="kw">${m[2]}</span>` : m[2];
    else if (m[3]) h += `<span class="pu">${esc(m[3])}</span>`;
    else h += esc(m[4]);
  }
  return h;
}
export function codeLines() {
  return CODE.map(([t, k], i) => ({ t, html: t ? ribbon(t) : '&nbsp;', cls: k === 'band' ? 'band' : '', n: i + 1 }));
}
