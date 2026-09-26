// Local server: the built site plus every Netlify function, the way production runs them.
//
//   npm run dev                              (= node scripts/dev.mjs --port 8888)
//   npm run dev -- --port 8102 --cron        (another port; also run scheduled functions once a minute)
//   npm run watch                            (rebuild the site and reload functions on change)
//
// - Static files come from site/dist (run `npm run build` first; --watch rebuilds on change).
// - Each netlify/functions/*.mjs (or <name>/index.mjs) is a Netlify v2 function:
//     export default async (req, context) => Response
//     export const config = { path: '/api/thing/:id' }     (string or array; default /.netlify/functions/<name>)
//   context has { params, ip, geo, site, waitUntil, cookies }.
// - Env: app/.env (see .env.example); variables already set in the shell win.
// - PAYBLAME_STORE_DIR defaults to app/.data, so lib/store.mjs keeps its "Blobs" in JSON files there.
// - --cron runs functions that export config.schedule once at start and then once a minute.
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, APP_DIR } from './build.mjs';

const argv = process.argv.slice(2);
const portAt = argv.lastIndexOf('--port');
const port = Number((portAt >= 0 && argv[portAt + 1]) || process.env.PORT || 8888);
const host = process.env.HOST || '127.0.0.1';
const watch = argv.includes('--watch');
const cron = argv.includes('--cron');
const dir = APP_DIR;

/** Load KEY=VALUE lines into process.env without overriding what is already set. */
export async function loadEnv(file) {
  try {
    for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env: fine */ }
}

/** Netlify-style path pattern ('/api/x/:id', '/api/*') -> { pathname, exec(p) -> params | null }. */
export function compilePath(pattern) {
  const keys = [];
  const src = pattern.split('/').map((seg) => {
    if (seg === '*') return '.*';
    if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  const re = new RegExp(`^${src}$`);
  return { pathname: pattern, exec: (p) => { const m = re.exec(p); return m ? Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) : null; } };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.hdr': 'application/octet-stream', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

/** site/dist file for a URL path, or null. No ../ escapes; '/x' also tries x.html and x/index.html. */
async function resolveFile(root, pathname) {
  const base = path.resolve(root);
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  const f = path.resolve(base, '.' + path.sep + rel);
  if (f !== base && !f.startsWith(base + path.sep)) return null;
  const candidates = [f];
  if (pathname.endsWith('/')) candidates.unshift(path.join(f, 'index.html'));
  else if (!path.extname(f)) candidates.push(f + '.html', path.join(f, 'index.html'));
  for (const c of candidates) {
    try { if ((await fs.stat(c)).isFile()) return c; } catch { /* next */ }
  }
  return null;
}

async function loadFunctions() {
  const fdir = path.join(dir, 'netlify', 'functions');
  const out = [];
  let names = [];
  try { names = await fs.readdir(fdir); } catch { return out; }
  for (const n of names) {
    let file = path.join(fdir, n);
    const st = await fs.stat(file);
    if (st.isDirectory()) file = path.join(file, 'index.mjs');
    else if (!/\.(mjs|js)$/.test(n)) continue;
    const name = path.basename(n).replace(/\.(mjs|js)$/, '');
    try {
      const mod = await import(pathToFileURL(file).href + `?t=${Date.now()}`);
      const cfg = mod.config || {};
      const paths = cfg.path ? [].concat(cfg.path) : [`/.netlify/functions/${name}`];
      out.push({ name, handler: mod.default, schedule: cfg.schedule, patterns: paths.map(compilePath) });
    } catch (e) {
      console.error(`function ${name} failed to load: ${e.stack || e.message}`);
    }
  }
  return out;
}

async function readBody(req) {
  if (['GET', 'HEAD'].includes(req.method)) return undefined;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

await loadEnv(path.join(dir, '.env'));
process.env.PAYBLAME_STORE_DIR ||= path.join(dir, '.data');
process.env.URL ||= `http://localhost:${port}`;

let fns = await loadFunctions();
if (watch) {
  await build(dir, { watch: true, log: (m) => console.log(`[build] ${m}`) });
  let t;
  fs.watch(path.join(dir, 'netlify', 'functions'), { recursive: true }, () => { clearTimeout(t); t = setTimeout(async () => { fns = await loadFunctions(); console.log('[functions] reloaded'); }, 200); });
}

const dist = path.join(dir, 'site', 'dist');
try { await fs.access(path.join(dist, 'index.html')); } catch { console.warn('site/dist/index.html is missing: run `npm run build` first (the API still works)'); }

async function handleFunction(req, res, url) {
  for (const f of fns) {
    for (const p of f.patterns) {
      const params = p.exec(url.pathname);
      if (!params) continue;
      const started = Date.now();
      const request = new Request(url, { method: req.method, headers: req.headers, body: await readBody(req), duplex: 'half' });
      const waits = [];
      const context = {
        params, ip: req.socket.remoteAddress, geo: {}, site: { url: process.env.URL },
        waitUntil: (w) => waits.push(w), cookies: { get: () => undefined, set() {}, delete() {} },
      };
      let r;
      try {
        r = await f.handler(request, context);
        if (!(r instanceof Response)) r = Response.json(r ?? null);
      } catch (e) {
        console.error(`[${f.name}] ${e.stack || e.message}`);
        r = Response.json({ error: 'function crashed' }, { status: 500 });
      }
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      Promise.allSettled(waits);
      console.log(`${req.method} ${url.pathname}${url.search} -> ${r.status} ${Date.now() - started}ms [${f.name}]`);
      return true;
    }
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (await handleFunction(req, res, url)) return;
    const f = await resolveFile(dist, url.pathname);
    if (!f) {
      const fallback = await resolveFile(dist, '/404.html');
      res.writeHead(404, { 'content-type': fallback ? TYPES['.html'] : 'text/plain' });
      return res.end(fallback ? await fs.readFile(fallback) : `not found: ${url.pathname}`);
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await fs.readFile(f));
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('server error');
    console.error(e.stack || e.message);
  }
});

await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });

if (cron) {
  const tick = async () => {
    for (const f of fns.filter((x) => x.schedule)) {
      try {
        const r = await f.handler(new Request(`${process.env.URL}/.netlify/functions/${f.name}`, { method: 'POST', body: JSON.stringify({ next_run: null }) }), {});
        console.log(`[cron] ${f.name} ${r?.status ?? 'ok'}`);
      } catch (e) { console.error(`[cron] ${f.name}: ${e.message}`); }
    }
  };
  tick();
  setInterval(tick, 60_000);
}

const routes = fns.flatMap((f) => [...f.patterns.map((p) => `${p.pathname} [${f.name}]`), ...(f.schedule ? [`schedule ${f.schedule} [${f.name}]${cron ? '' : ' (off; --cron runs it)'}`] : [])]);
console.log(`payblame on http://localhost:${port}${routes.length ? '\n  ' + routes.join('\n  ') : ''}`);
