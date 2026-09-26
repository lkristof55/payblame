// Guard for everything app/ ships (site source, public assets, fixtures, functions, docs): no real recipient,
// no key. Fails on a GitHub SocialFeePda or other off-curve address that isn't on the short allowlist below,
// a non-placeholder github:/x:@ handle, anything shaped like an API key, a GLB with a baked texture, or real keys
// in the site's hex dump.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBase58, encodeBase58, isOnCurve, socialFeePda } from '../../src/index.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', '.data', '.netlify']);
const TEXT = /\.(m?js|json|html|css|md|svg|toml|ya?ml|example)$/;

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n) || n === 'package-lock.json' || n === '.env') continue;
    const f = path.join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out); else out.push(f);
  }
  return out;
}
const files = walk(APP);
// Vendored third-party code (the Draco decoder, minified with embedded wasm) is not ours to scan for addresses.
const VENDORED = /^site\/public\/draco\//;
const texts = files.filter((f) => TEXT.test(f) && !VENDORED.test(path.relative(APP, f))).map((f) => ({ f: path.relative(APP, f), s: readFileSync(f, 'utf8') }));

// Off-curve addresses (PDAs) that may appear, each with the reason it is not a person.
const ALLOWED_PDAS = new Map([
  ['4MQJzmfJ8D4s4EFPgXCxgM8VzJDtikjHqfGaLTECab2P', 'a coin\'s SharingConfig (derived from its mint); the hex dump shows it with SAMPLE recipient keys'],
]);

test('shipped files hold no recipient PDA (every off-curve address is allowlisted)', () => {
  const seen = [];
  for (const { f, s } of texts) {
    for (const m of s.matchAll(/(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g)) {
      let bytes;
      try { bytes = decodeBase58(m[0]); } catch { continue; }
      if (bytes.length !== 32 || isOnCurve(bytes)) continue;
      if (!ALLOWED_PDAS.has(m[0])) seen.push(`${f}: ${m[0]}`);
    }
  }
  assert.deepEqual(seen, []);
});

test('shipped files name no GitHub login or X handle (placeholders only)', () => {
  const PLACEHOLDER = /^(#+|#<id>|login|<login>|sample-[\w-]+|legacy-[\w-]+|built-[\w-]+)$/;
  const bad = [];
  for (const { f, s } of texts) {
    for (const m of s.matchAll(/\bgithub:(?!\$\{)([A-Za-z0-9#<][\w#<>-]*)/g)) if (!PLACEHOLDER.test(m[1])) bad.push(`${f}: github:${m[1]}`);
    for (const m of s.matchAll(/\bx:@(?!\$\{)([\w#]+)/g)) if (!/^#+$/.test(m[1])) bad.push(`${f}: x:@${m[1]}`);
    for (const m of s.matchAll(/(?:github\.com|x\.com|twitter\.com)\/([A-Za-z0-9_-]+)/g)) if (!['lkristof55'].includes(m[1])) bad.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(bad, []);
});

test('shipped files hold nothing shaped like a key or token', () => {
  const bad = [];
  for (const { f, s } of texts) {
    for (const re of [/api-key=(?!\*|\.\.\.|\$\{|<|SECRET\d+\b)[\w-]{8,}/g, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, /\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, /^(HELIUS_API_KEY|GITHUB_TOKEN|LEDGER_MASK_SECRET|BIRDEYE_API_KEY)=\S+/gm]) {
      for (const m of s.matchAll(re)) bad.push(`${f}: ${m[0].slice(0, 16)}...`);
    }
  }
  assert.deepEqual(bad, []);
});

test('GLB models carry geometry only (no baked texture that could print a ledger)', () => {
  for (const f of files.filter((x) => x.endsWith('.glb'))) {
    const b = readFileSync(f);
    const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
    assert.equal((json.images || []).length, 0, path.relative(APP, f));
  }
});

test('the site hex dump carries SAMPLE keys where the recorded account had its admin and recipients', () => {
  const src = readFileSync(path.join(APP, 'site/src/sections/content.js'), 'utf8');
  const raw = Buffer.from(/const RAW = '([^']+)'/.exec(src)[1], 'base64');
  const key = (o) => encodeBase58(raw.subarray(o, o + 32));
  let n = 0, wallet;
  do { wallet = createHash('sha256').update(`payblame sample wallet ${n++}`).digest(); } while (!isOnCurve(wallet));
  assert.equal(key(43), encodeBase58(wallet), 'admin');
  assert.equal(key(80), encodeBase58(wallet), 'shareholder 0');
  assert.equal(key(114), socialFeePda('sample_gh_0000', 2), 'shareholder 1');
  assert.equal(raw.readUInt16LE(112), 9900);
  assert.equal(raw.readUInt16LE(146), 100);
  assert.match(readFileSync(path.join(APP, 'site/index.html'), 'utf8'), /SAMPLE keys of the same length/);
});
