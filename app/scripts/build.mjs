// Build the site into site/dist.
//
//   npm run build                    (= node scripts/build.mjs)
//   node scripts/dev.mjs --watch     (rebuilds on change through build({ watch: true }))
//
// Convention:
//   site/*.html         pages, copied as-is (they load /app.js as a module)
//   site/src/main.js    entry, bundled with every import to site/dist/app.js (code-split chunks in dist/chunks/)
//   site/public/**      static files (textures, fonts, images), copied to dist/ verbatim
//
// TOKEN_MINT (env, optional): the project's own mint. It is inlined into the bundle at build time
// (site/src/sections/content.js reads __TOKEN_MINT__), so setting it on Netlify and redeploying turns
// on the CA row. Empty = pre-launch.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function tokenMint(env = process.env) {
  const v = (env.TOKEN_MINT || '').trim();
  if (v && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) throw new Error('TOKEN_MINT must be a base58 mint address (32-44 chars) or empty');
  return v;
}

export async function build(appDir = APP_DIR, { watch = false, log = console.log } = {}) {
  const site = path.join(appDir, 'site');
  const dist = path.join(site, 'dist');
  const entry = path.join(site, 'src', 'main.js');

  async function copyStatic() {
    await fs.mkdir(dist, { recursive: true });
    for (const f of await fs.readdir(site)) if (f.endsWith('.html')) await fs.copyFile(path.join(site, f), path.join(dist, f));
    await fs.cp(path.join(site, 'public'), dist, { recursive: true, force: true }).catch((e) => { if (e.code !== 'ENOENT') throw e; });
  }

  const options = {
    entryPoints: { app: entry },
    outdir: dist,
    entryNames: '[name]',
    chunkNames: 'chunks/[name]-[hash]',
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: !watch,
    sourcemap: watch ? 'inline' : 'linked',
    define: {
      'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
      global: 'globalThis',
      __TOKEN_MINT__: JSON.stringify(tokenMint()),
    },
    loader: { '.glsl': 'text', '.vert': 'text', '.frag': 'text', '.wgsl': 'text', '.svg': 'text', '.md': 'text' },
    logLevel: 'warning',
    metafile: true,
  };

  await fs.rm(path.join(dist, 'chunks'), { recursive: true, force: true });
  await copyStatic();
  if (watch) {
    const ctx = await esbuild.context({
      ...options,
      plugins: [{ name: 'static', setup(b) { b.onEnd(async (r) => { await copyStatic(); log(`rebuilt${r.errors.length ? ' with errors' : ''}`); }); } }],
    });
    await ctx.watch();
    return ctx;
  }
  const r = await esbuild.build(options);
  let js = 0, gz = 0;
  for (const [f, o] of Object.entries(r.metafile.outputs)) {
    if (!f.endsWith('.js')) continue;
    js += o.bytes;
    gz += zlib.gzipSync(await fs.readFile(f)).length;
  }
  log(`built ${path.relative(process.cwd(), dist) || dist}: JS ${(js / 1024).toFixed(0)} KB (${(gz / 1024).toFixed(0)} KB gzip)${options.define.__TOKEN_MINT__ !== '""' ? ', TOKEN_MINT set' : ''}`);
  return { js, gz };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await build(APP_DIR, { watch: process.argv.includes('--watch') }); } catch (e) { console.error(e.message); process.exit(1); }
}
