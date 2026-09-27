// A small in-memory stand-in for a Cloudflare D1 binding: prepare(sql).bind(...).first() / all() / run(),
// for exactly the statements lib/store.mjs issues on table kv (anything else throws, so a changed query
// can't pass silently). TEXT compares in code point order, as SQLite compares UTF-8 bytes. It counts
// queries, rows read and rows written the way D1 bills them, for the budget tests.
const cmp = (a, b) => {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d < 0 ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
};
const norm = (sql) => sql.replace(/\s+/g, ' ').trim();

export function fakeD1() {
  const rows = new Map(); // `${store}\u0000${key}` -> { store, key, value, updated_at }
  const stats = { queries: 0, rowsRead: 0, rowsWritten: 0 };
  const id = (s, k) => `${s}\u0000${k}`;
  const inStore = (s) => [...rows.values()].filter((r) => r.store === s).sort((a, b) => cmp(a.key, b.key));

  function exec(sql, args) {
    stats.queries++;
    let m;
    if (sql === 'SELECT value FROM kv WHERE store = ?1 AND key = ?2') {
      const r = rows.get(id(args[0], args[1]));
      if (r) stats.rowsRead++;
      return r ? [{ value: r.value }] : [];
    }
    if ((m = /^SELECT key, value FROM kv WHERE store = \?1 AND key IN \(((?:\?\d+, )*\?\d+)\)$/.exec(sql))) {
      const want = new Set(args.slice(1));
      const out = inStore(args[0]).filter((r) => want.has(r.key)).map((r) => ({ key: r.key, value: r.value }));
      stats.rowsRead += out.length;
      return out;
    }
    if (sql === 'INSERT INTO kv (store, key, value, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (store, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at') {
      const [store, key, value, updated_at] = args;
      if (typeof value !== 'string') throw new Error('D1_TYPE_ERROR: value must be TEXT');
      rows.set(id(store, key), { store, key, value, updated_at });
      stats.rowsWritten++;
      return [];
    }
    if (sql === 'DELETE FROM kv WHERE store = ?1 AND key = ?2') {
      if (rows.delete(id(args[0], args[1]))) stats.rowsWritten++;
      return [];
    }
    if (sql === 'SELECT key FROM kv WHERE store = ?1 AND key >= ?2 ORDER BY key' || sql === 'SELECT key FROM kv WHERE store = ?1 AND key >= ?2 AND key < ?3 ORDER BY key') {
      const out = inStore(args[0]).filter((r) => cmp(r.key, args[1]) >= 0 && (args.length < 3 || cmp(r.key, args[2]) < 0)).map((r) => ({ key: r.key }));
      stats.rowsRead += out.length;
      return out;
    }
    throw new Error(`fake D1: unsupported SQL: ${sql}`);
  }

  function statement(sql, args = []) {
    return {
      bind: (...a) => statement(sql, a),
      first: async (col) => { const r = exec(sql, args)[0] ?? null; return col && r ? r[col] : r; },
      all: async () => ({ results: exec(sql, args), success: true, meta: {} }),
      run: async () => { exec(sql, args); return { success: true, meta: {} }; },
    };
  }
  return { prepare: (sql) => statement(norm(sql)), rows, stats };
}
