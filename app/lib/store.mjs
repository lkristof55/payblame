// Key-value JSON store: Netlify Blobs in production, a folder of JSON files locally.
// scripts/dev.mjs sets PAYBLAME_STORE_DIR=app/.data; tests can call useStoreDir(tmp). Unset (Netlify) = Blobs.
//   const s = await getStore('scans'); await s.setJSON('k', v); await s.get('k'); await s.list({ prefix: 'a/' })
const stores = new Map();
let baseDir = process.env.PAYBLAME_STORE_DIR || null;

export function useStoreDir(dir) { baseDir = dir; stores.clear(); }

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

export async function getStore(name) {
  if (stores.has(name)) return stores.get(name);
  let s;
  if (baseDir) {
    const path = await import('node:path');
    s = fileStore(path.join(baseDir, name));
  } else {
    const { getStore: blobs } = await import('@netlify/blobs');
    const b = blobs({ name, consistency: 'strong' });
    s = { get: (k) => b.get(k, { type: 'json' }), setJSON: (k, v) => b.setJSON(k, v), delete: (k) => b.delete(k), list: (o) => b.list(o) };
  }
  stores.set(name, s);
  return s;
}
