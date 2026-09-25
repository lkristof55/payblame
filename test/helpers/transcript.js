// Record and replay HTTP traffic, so the tests run the real code paths offline.
// RPC requests are keyed by method + params (never by URL, so API keys stay out of fixtures).
import { gunzipSync, gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

const KEEP_HEADERS = ['location', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'content-type'];
const NO_BODY = new Set([101, 204, 205, 304]);

export function keyOf(url, init = {}) {
  if ((init.method || 'GET').toUpperCase() === 'POST') {
    const b = JSON.parse(init.body);
    return `rpc ${b.method} ${JSON.stringify(b.params)}`;
  }
  return `GET ${String(url)}`;
}

export function recordingFetch(transcript, f = globalThis.fetch) {
  return async (url, init = {}) => {
    const res = await f(url, init);
    const body = NO_BODY.has(res.status) ? null : await res.text();
    const headers = {};
    for (const h of KEEP_HEADERS) { const v = res.headers.get(h); if (v) headers[h] = v; }
    transcript[keyOf(url, init)] = { status: res.status, headers, body };
    return new Response(body, { status: res.status, headers });
  };
}

export function replayFetch(transcript) {
  const used = new Set();
  const f = async (url, init = {}) => {
    const k = keyOf(url, init);
    const e = transcript[k];
    if (!e) throw new Error(`unrecorded request: ${k.slice(0, 200)}`);
    used.add(k);
    return new Response(e.body, { status: e.status, headers: e.headers });
  };
  f.used = used;
  return f;
}

/** A cache that logs every hit, so a recording can ship the cache state it depended on. */
export function loggingCache(inner, seedLog) {
  return {
    async get(k) { const v = await inner.get(k); if (v && seedLog && !(k in seedLog)) seedLog[k] = v; return v; },
    set: (k, v) => inner.set(k, v),
  };
}

/** Memory cache seeded from a fixture; timestamps are refreshed so the 7-day TTL never expires in tests. */
export function seededCache(seed = {}) {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, { ...v, at: Date.now() }]));
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); } };
}

export const readGz = (file) => JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
export const writeGz = (file, obj) => writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(obj)), { level: 9 }));
