// Key-value JSON store with three backends:
//   - Cloudflare D1, when worker.mjs registers the DB binding with useD1(env.DB) (table kv, migrations/0001_kv.sql);
//   - a folder of JSON files locally: scripts/dev.mjs sets PAYBLAME_STORE_DIR=app/.data; tests can call useStoreDir(tmp);
//   - Netlify Blobs otherwise (production on Netlify).
//   const s = await getStore('scans'); await s.setJSON('k', v); await s.get('k'); await s.list({ prefix: 'a/' })
// get(k) -> parsed JSON or null; setJSON(k, v); delete(k); list({ prefix }) -> { blobs: [{ key }] }, prefix taken literally.
const stores = new Map();
let baseDir = process.env.PAYBLAME_STORE_DIR || null;
let d1 = null;

export function useStoreDir(dir) { baseDir = dir; stores.clear(); }
/** Use a Cloudflare D1 database (the `DB` binding). Takes precedence over the file and Blobs backends. */
export function useD1(db) { if (db !== d1) { d1 = db; stores.clear(); } }

function fileStore(dir) {
  const ready = (async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.mkdir(dir, { recursive: true });
    return { fs, path };
  })();
  const file = async (k) => { const { path } = await ready; return path.join(dir, encodeURIComponent(k) + '.json'); };
  return {
    async get(k) { const { fs } = await ready; try { return JSON.parse(await fs.readFile(await file(k), 'utf8')); } catch { return null; } },
    async setJSON(k, v) { const { fs } = await ready; const f = await file(k); await fs.writeFile(f + '.tmp', JSON.stringify(v)); await fs.rename(f + '.tmp', f); },
    async delete(k) { const { fs } = await ready; await fs.rm(await file(k), { force: true }); },
    async list({ prefix = '' } = {}) {
      const { fs } = await ready;
      const names = await fs.readdir(dir);
      return { blobs: names.filter((n) => n.endsWith('.json')).map((n) => ({ key: decodeURIComponent(n.slice(0, -5)) })).filter((b) => b.key.startsWith(prefix)) };
    },
  };
}

/** D1 stores values as TEXT; a row (and so a value) is capped at 2 MB. */
export const D1_MAX_VALUE_BYTES = 2_000_000;

/**
 * The smallest string greater than every string that starts with `prefix`, in the byte order SQLite
 * compares TEXT in (UTF-8 bytes = code point order): the last code point + 1, skipping the surrogate
 * range; a trailing U+10FFFF is dropped and the one before it is bumped. null = no upper bound.
 */
export function prefixEnd(prefix) {
  const cps = [...prefix].map((c) => c.codePointAt(0));
  while (cps.length) {
    let cp = cps.pop() + 1;
    if (cp === 0xd800) cp = 0xe000;
    if (cp <= 0x10ffff) return String.fromCodePoint(...cps, cp);
  }
  return null;
}

const bytes = (s) => new TextEncoder().encode(s).length;

function d1Store(db, name) {
  return {
    async get(k) {
      const row = await db.prepare('SELECT value FROM kv WHERE store = ?1 AND key = ?2').bind(name, k).first();
      return row ? JSON.parse(row.value) : null;
    },
    /** Several keys in one query (at most 99 per call; D1 binds up to 100 parameters). Missing keys are absent. */
    async getMany(keys) {
      const out = new Map();
      for (let i = 0; i < keys.length; i += 99) {
        const part = keys.slice(i, i + 99);
        const marks = part.map((_, j) => `?${j + 2}`).join(', ');
        const { results } = await db.prepare(`SELECT key, value FROM kv WHERE store = ?1 AND key IN (${marks})`).bind(name, ...part).all();
        for (const r of results) out.set(r.key, JSON.parse(r.value));
      }
      return out;
    },
    async setJSON(k, v) {
      const value = JSON.stringify(v);
      if (value === undefined) throw new TypeError(`store ${name}: cannot store ${typeof v} at ${k}`);
      if (value.length > D1_MAX_VALUE_BYTES / 3 && bytes(value) > D1_MAX_VALUE_BYTES) throw new RangeError(`store ${name}: ${k} is ${bytes(value)} bytes, over D1's 2 MB row limit`);
      await db.prepare('INSERT INTO kv (store, key, value, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (store, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .bind(name, k, value, Date.now()).run();
    },
    async delete(k) {
      await db.prepare('DELETE FROM kv WHERE store = ?1 AND key = ?2').bind(name, k).run();
    },
    // A key range on the primary key, not LIKE: LIKE treats % and _ as wildcards and ignores ASCII case.
    async list({ prefix = '' } = {}) {
      const end = prefixEnd(prefix);
      const stmt = end === null
        ? db.prepare('SELECT key FROM kv WHERE store = ?1 AND key >= ?2 ORDER BY key').bind(name, prefix)
        : db.prepare('SELECT key FROM kv WHERE store = ?1 AND key >= ?2 AND key < ?3 ORDER BY key').bind(name, prefix, end);
      const { results } = await stmt.all();
      return { blobs: results.map((r) => ({ key: r.key })) };
    },
  };
}

/** getMany for the backends without a batch read: one get per key. */
function withGetMany(s) {
  if (!s.getMany) {
    s.getMany = async (keys) => {
      const out = new Map();
      const vals = await Promise.all(keys.map((k) => s.get(k)));
      keys.forEach((k, i) => { if (vals[i] != null) out.set(k, vals[i]); });
      return out;
    };
  }
  return s;
}

export async function getStore(name) {
  if (stores.has(name)) return stores.get(name);
  let s;
  if (d1) {
    s = d1Store(d1, name);
  } else if (baseDir) {
    const path = await import('node:path');
    s = fileStore(path.join(baseDir, name));
  } else {
    const { getStore: blobs } = await import('@netlify/blobs');
    const b = blobs({ name, consistency: 'strong' });
    s = { get: (k) => b.get(k, { type: 'json' }), setJSON: (k, v) => b.setJSON(k, v), delete: (k) => b.delete(k), list: (o) => b.list(o) };
  }
  s = withGetMany(s);
  stores.set(name, s);
  return s;
}
