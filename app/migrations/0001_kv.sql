-- The key-value table behind lib/store.mjs on Cloudflare (D1), in place of Netlify Blobs.
-- One row per (store, key); value is the JSON text (D1 caps a row at 2 MB; payblame's largest value, the
-- ledger snapshot, is about 15 KB). list({ prefix }) is a range scan on the primary key.
CREATE TABLE IF NOT EXISTS kv (
  store      TEXT    NOT NULL,
  key        TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (store, key)
);
