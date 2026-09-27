// lib/store.mjs on Cloudflare D1: the same get / setJSON / delete / list({ prefix }) semantics as the file store
// (and Netlify Blobs). Runs against the in-memory D1 fake, and against real SQLite through node:sqlite when this
// Node has it, so the SQL itself (upsert, key range, TEXT order) is checked too. No network, no new dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { getStore, useD1, useStoreDir, prefixEnd, D1_MAX_VALUE_BYTES } from '../lib/store.mjs';
import { fakeD1 } from './helpers/fake-d1.mjs';

const MIGRATION = readFileSync(new URL('../migrations/0001_kv.sql', import.meta.url), 'utf8');

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { sqlite = null; }
/** A D1-shaped wrapper over node:sqlite (D1 is SQLite; ?NNN parameters bind by position). */
function sqliteD1() {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(MIGRATION);
  return {
    prepare(sql) {
      const st = db.prepare(sql);
      const bound = (args) => ({
        bind: (...a) => bound(a),
        first: async () => st.get(...args) ?? null,
        all: async () => ({ results: st.all(...args) }),
        run: async () => { st.run(...args); return { success: true }; },
      });
      return bound([]);
    },
  };
}

const KEYS = { 'a/1': { x: 1 }, 'a/2': [1, 2], 'a%b': 'percent', 'a_b': 'underscore', 'A/3': 3, 'ab': 'ab', 'é/1': 'unicode', 'a/😀': 'emoji', 'gh/id/9000000001': { at: 1, value: { id: '9000000001', login: 'sample-dev' } } };

/** The scenario every backend must pass the same way; returns what it observed. */
async function scenario() {
  const s = await getStore('payblame');
  const other = await getStore('other');
  for (const [k, v] of Object.entries(KEYS)) await s.setJSON(k, v);
  await s.setJSON('a/1', { x: 2 }); // overwrite
  await other.setJSON('a/1', 'other store');
  const keys = async (prefix) => (await s.list({ prefix })).blobs.map((b) => b.key).sort();
  const out = {
    get: await s.get('a/1'),
    missing: await s.get('nope'),
    otherStore: await other.get('a/1'),
    all: await keys(''),
    slash: await keys('a/'),
    percent: await keys('a%'),
    underscore: await keys('a_'),
    upper: await keys('A'),
    unicode: await keys('é'),
    none: await keys('zzz'),
    many: [...(await s.getMany(['a/1', 'nope', 'a%b']))].sort(),
  };
  await s.delete('a/2');
  await s.delete('never-there');
  out.afterDelete = { get: await s.get('a/2'), slash: await keys('a/') };
  return out;
}

const EXPECTED = {
  get: { x: 2 },
  missing: null,
  otherStore: 'other store',
  all: Object.keys(KEYS).sort(),
  slash: ['a/1', 'a/2', 'a/😀'],
  percent: ['a%b'], // % is not a wildcard
  underscore: ['a_b'], // _ is not a wildcard
  upper: ['A/3'], // case-sensitive
  unicode: ['é/1'],
  none: [],
  many: [['a%b', 'percent'], ['a/1', { x: 2 }]],
  afterDelete: { get: null, slash: ['a/1', 'a/😀'] },
};

test('D1 backend (in-memory fake): get / setJSON / delete / list({ prefix }) as specified', async () => {
  const db = fakeD1();
  useD1(db);
  assert.deepEqual(await scenario(), EXPECTED);
  assert.ok(db.stats.queries > 0 && db.stats.rowsWritten >= 11);
  useD1(null);
});

test('D1 backend on real SQLite (node:sqlite): same results, so the SQL and the key range are right', { skip: !sqlite && 'node:sqlite is not available in this Node' }, async () => {
  useD1(sqliteD1());
  assert.deepEqual(await scenario(), EXPECTED);
  useD1(null);
});

test('the file store (local dev) gives the same answers: the D1 backend changes no semantics', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'payblame-store-'));
  try {
    useD1(null);
    useStoreDir(dir);
    assert.deepEqual(await scenario(), EXPECTED);
  } finally {
    useStoreDir(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D1 rows stay under the 2 MB limit: a larger value is refused before it reaches D1', async () => {
  const db = fakeD1();
  useD1(db);
  const s = await getStore('payblame');
  await assert.rejects(() => s.setJSON('big', 'x'.repeat(D1_MAX_VALUE_BYTES)), RangeError);
  await assert.rejects(() => s.setJSON('multibyte', 'é'.repeat(D1_MAX_VALUE_BYTES / 2)), RangeError); // 2 bytes each in UTF-8
  await s.setJSON('fits', 'x'.repeat(D1_MAX_VALUE_BYTES - 10));
  assert.equal((await s.get('fits')).length, D1_MAX_VALUE_BYTES - 10);
  assert.equal(await s.get('big'), null);
  // what payblame stores: the ledger snapshot is the largest value, about 15 KB
  const snap = readFileSync(new URL('./fixtures/ledger-snapshot.json', import.meta.url), 'utf8');
  assert.ok(Buffer.byteLength(JSON.stringify(JSON.parse(snap))) < 50_000);
  useD1(null);
});

test('prefixEnd: the first string after every key that starts with the prefix, in UTF-8 byte order', () => {
  assert.equal(prefixEnd(''), null);
  assert.equal(prefixEnd('a/'), 'a0');
  assert.equal(prefixEnd('gh/id/'), 'gh/id0');
  assert.equal(prefixEnd('a%'), 'a&');
  assert.equal(prefixEnd('퟿'), ''); // skips the surrogate range
  assert.equal(prefixEnd('x😀'), 'x😁');
  assert.equal(prefixEnd('a\u{10FFFF}'), 'b');
  assert.equal(prefixEnd('\u{10FFFF}'), null);
});
