# payblame app: the site and its backend

This folder is the code behind **https://payblame.anyfee.workers.dev**: a static site (three.js, gsap, lenis) and three HTTP functions plus one scheduled function, written as Netlify Functions. It runs on Cloudflare Workers (`worker.mjs` routes to the same files; see [Deploy to Cloudflare Workers](#deploy-to-cloudflare-workers)). The Netlify copy at payblame.netlify.app is paused; the Netlify setup below still works unchanged. The functions import the `payblame` library from the repo root (`../src`), so the live demo runs the same code as the CLI and the npm package. Type a GitHub login, a mint or a wallet and it prints every pump.fun coin that routes creator fees to it and what is still unclaimed, read straight from chain state (ten `memcmp` probes, no indexer, no pump.fun API).

> listed != involved: recipients did not necessarily launch, endorse or know about these coins.

## Run locally

Node 22 or newer.

```sh
cd app
npm ci
cp .env.example .env          # then fill in HELIUS_API_KEY (the only required value)
npm test                      # offline: 41 tests on recorded, scrubbed mainnet fixtures
npm run build                 # site/src -> site/dist
npm run dev                   # site + every /api/* function on http://localhost:8888
npm run smoke                 # in a second shell: real mainnet requests against the dev server
```

- `npm run dev -- --port 8102` picks another port; `--cron` also runs `ledger-cron` at start and once a minute; `npm run watch` rebuilds the site and reloads functions on change.
- Locally, `lib/store.mjs` keeps what production keeps in Netlify Blobs (or D1 on Cloudflare) as JSON files in `app/.data/` (git-ignored).
- To run the Cloudflare version locally instead, see [Deploy to Cloudflare Workers](#deploy-to-cloudflare-workers) (`wrangler dev`).
- `npm run record` re-records the fixtures (needs `HELIUS_API_KEY`). The library's fixtures at the repo root go through its scrubber; `test/fixtures/ledger-snapshot.json` is written masked, with row ids under a random secret that is thrown away.

The scripts in `scripts/` are small and have no dependencies beyond esbuild: `build.mjs` bundles `site/src/main.js` into `site/dist/app.js` (with code-split chunks) and copies `site/*.html` and `site/public/**`; `dev.mjs` serves `site/dist` and runs each `netlify/functions/*.mjs` as a Netlify v2 function (`export default async (req, context) => Response`, routed by `config.path`).

## Endpoints

| method and path | what | cache |
|---|---|---|
| `GET /api/lookup?q=<query>&limit=<1-250>&mask=1` | recipient blame (every coin that pays `q`) or coin blame (who a mint pays, declared vs on-chain) | coin 60 s, recipient 300 s |
| `GET /api/ledger` | network-wide SocialFeePda snapshot for the hero: totals, top 25 unclaimed, top 10 claimed, 15 recent claims, all masked; `ageSeconds` = seconds since `snapshotAt` | 900 s; store key `ledger/latest` |
| `GET /api/health` | `{ ok, keys: { helius, birdeye, github }, tokenMint }`: key names only, never values | none |
| `ledger-cron` (scheduled, `*/15 * * * *`) | one `getProgramAccounts` over every SocialFeePda, stored masked (Netlify, Workers Paid); on the Workers Free plan one page of it per run (see below) | n/a |

`q` is a GitHub login (`<login>`, `@<login>`, `github:<login>`), `ghid:<id>`, `x:<id>`, a wallet, a SocialFeePda, a SharingConfig or a mint.

```sh
curl 'http://localhost:8888/api/lookup?q=J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpump'          # a coin: its fee split and the declared-vs-on-chain diff
curl 'http://localhost:8888/api/lookup?q=J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpump&mask=1'   # the same coin, logins/handles/ids masked
curl 'http://localhost:8888/api/lookup?q=<your-github-login>&limit=24'                          # every coin that pays that account
curl -s 'http://localhost:8888/api/ledger' | jq -r '.blame[]' | head -4
curl 'http://localhost:8888/api/health'
```

On Cloudflare, `/api/ledger` never scans in the request: it serves the stored snapshot whatever its age (`snapshotAt`, `ageSeconds`), and before the first snapshot exists it answers `200` with `warmingUp: true`, `progress` (`{ pages, accountsScanned, startedAt }` or null), `github: null` and empty row lists (not cached); the site prints "WARMING UP" instead of the ledger. A snapshot built from pages also carries `scan: { method, pages, pageSize, startedAt, completedAt }`; `snapshotAt` is when its first page was read. On the Workers Free plan a recipient lookup lists at most `LOOKUP_MAX_LIMIT` coins (default 20): `totals.coins` stays exact, `totals.truncated` is true when the list is cut, and `meta.limitCap` says the requested `limit` was lowered.

Errors are JSON `{ error, code, retryAfterSeconds? }`: 400 `BAD_INPUT` (q outside the grammar, bad `limit` or `mask`), 404 `GITHUB_NOT_FOUND` / `NOT_PUMP`, 429 `GITHUB_RATE_LIMIT` (with `Retry-After`), 502 `UPSTREAM` (the RPC failed or timed out; every upstream call has an 8 s timeout, 20 s for the cron's scan). No stack traces or upstream URLs are returned.

### Who gets named

- **`/api/ledger` never names anyone.** Every row has `login: "####"`, `githubId: null`, `socialFeePda: null` (the PDA decodes to the GitHub id), `masked: true` and a `rowId` = `row:` + 8 hex of HMAC-SHA256(`LEDGER_MASK_SECRET`, socialFeePda). There is no parameter that unmasks it. Masking runs on every response, so an older stored snapshot is still served masked. The numbers are public chain data; the masking stops this site from publishing a ranked list of people by default.
- **`/api/lookup?mask=1`** masks logins, declared handles, social user ids and SocialFeePda addresses (the site's automatic demo uses it). Without `mask`, a lookup answers for exactly the account or coin the caller typed.
- The site never pre-fills a person's account: its examples are a mint and `--ledger`.
- On Cloudflare the paged scan also keeps `ledger/sweep` (the scan in progress) and `ledger/raw` (the last complete aggregate) in D1: GitHub ids and SocialFeePda addresses, no logins, so later runs can add account types. No endpoint reads them.

## Environment variables

All are read server-side only; the browser never sees a key. `.env.example` lists them with one line each.

| var | required | what |
|---|---|---|
| `HELIUS_API_KEY` | yes (or `PAYBLAME_RPC_URL`) | Helius mainnet RPC + DAS: `https://mainnet.helius-rpc.com/?api-key=...` |
| `PAYBLAME_RPC_URL` | no | any mainnet RPC that allows `getProgramAccounts` with `memcmp`; overrides the Helius URL |
| `GITHUB_TOKEN` | no, recommended | a token with no scopes. Without it GitHub REST allows **60 requests/h per IP** (shared across Netlify's function IPs); login->id then falls back to the `github.com/<login>.png` redirect and ids print as `github:#<id>`. With it: 5,000/h. id<->login pairs are cached 7 days in Blobs either way. |
| `LEDGER_MASK_SECRET` | set it in production | HMAC secret for the ledger's `rowId`s. Any long random string (`openssl rand -hex 32`). If unset, a random one is generated once and kept in Blobs (`payblame` / `mask/secret`), so ids stay stable. Never served, never commit it. |
| `TOKEN_MINT` | no | the project's own mint, empty until launch (see below) |
| `BIRDEYE_API_KEY` | no | only reported by `/api/health` (as a boolean); no endpoint calls Birdeye |
| `CF_FREE_PLAN` | Cloudflare only | `"1"` (set in `wrangler.jsonc`): Workers Free budgets, below. `"0"` on Workers Paid: the jobs run in full, as on Netlify. Ignored on Netlify. |
| `LEDGER_PAGE_SIZE` | no, Cloudflare only | SocialFeePdas per cron run on the free plan (default 3000; `0` = one `getProgramAccounts` per run, which needs Workers Paid) |
| `LOOKUP_MAX_LIMIT` | no, Cloudflare only | most coin lines a recipient lookup lists on the free plan (default 20, max 250) |

## Deploy to Cloudflare Workers

`wrangler.jsonc` deploys this folder as the Worker `payblame`: `worker.mjs` answers `/api/*` with the functions in `netlify/functions/` (matched by their `config.path`) and serves `site/dist` for everything else (`404.html` for unknown paths); its `scheduled()` runs `ledger-cron` on the one cron trigger (`*/15 * * * *`). A D1 database (`DB`, table `kv` from `migrations/0001_kv.sql`) takes the place of Netlify Blobs in `lib/store.mjs`. `nodejs_compat` provides `node:crypto` and `Buffer` and fills `process.env` from vars and secrets, so the functions read their keys exactly as on Netlify. Netlify needs no `_headers` equivalent: `netlify.toml` sets no headers.

```sh
cd app
npm ci && npm test && npm run build          # the Worker serves site/dist, so build first
npx wrangler@4 login
npx wrangler@4 d1 create payblame-store      # put the printed database_id into wrangler.jsonc
npx wrangler@4 d1 migrations apply payblame-store --remote
npx wrangler@4 secret put HELIUS_API_KEY     # required (or PAYBLAME_RPC_URL, see below)
npx wrangler@4 secret put GITHUB_TOKEN       # recommended, a token with no scopes
npx wrangler@4 secret put LEDGER_MASK_SECRET # e.g. the output of: openssl rand -hex 32
npx wrangler@4 secret put BIRDEYE_API_KEY    # optional, only reported by /api/health
npx wrangler@4 deploy
```

`TOKEN_MINT` is public: add it to `vars` in `wrangler.jsonc` (or `secret put` it) for `/api/health`, and set it in the shell when you run `npm run build` so the site shows the CA. `PAYBLAME_RPC_URL`, `LEDGER_PAGE_SIZE` and `LOOKUP_MAX_LIMIT` are optional (`secret put` or `vars`).

Locally, with no Cloudflare account: put the keys in `app/.dev.vars` (git-ignored, `KEY=value` lines), then

```sh
npx wrangler@4 d1 migrations apply payblame-store --local
npx wrangler@4 dev --local --port 8802 --test-scheduled
curl 'http://localhost:8802/cdn-cgi/handler/scheduled?cron=*%2F15+*+*+*+*'   # one cron run (one ledger page on the free plan)
npm run smoke -- http://localhost:8802
```

(`/__scheduled` is answered by the static assets here, since `run_worker_first` covers only `/api/*`; `/cdn-cgi/handler/scheduled` reaches `scheduled()`.)

### Workers Free plan: budgets and what degrades

The free plan allows 10 ms of CPU and 50 external subrequests per invocation (HTTP request or cron run, retries and `waitUntil` work included), 100,000 requests a day per account and 5 cron triggers per account. With `CF_FREE_PLAN=1` (the default in `wrangler.jsonc`) the functions budget for that:

- **Subrequests.** Every invocation gets its own fetch counter with a hard cap of 45 (`lib/platform.mjs`): the 46th fetch fails at once instead of going out, and the library treats it like a timeout (the RPC answers `UPSTREAM`, a GitHub or DexScreener lookup gives up). RPC calls still retry 429/503 up to 3 times inside that cap. A coin lookup needs 6 RPC calls, 1 DexScreener call and at most 10 GitHub calls; a recipient lookup 16 RPC calls and at most 2 GitHub calls; a cron run 1 or 2 RPC calls and at most 10 GitHub calls.
- **`/api/ledger` never runs the scan.** It reads one D1 row. Until the first snapshot exists it answers `warmingUp` (above).
- **The ledger is scanned in pages.** One `getProgramAccounts` over all ~12,300 SocialFeePdas is a ~3.8 MB answer, more than 10 ms of CPU to parse and rank. The cron instead reads one page of `LEDGER_PAGE_SIZE` (3000) accounts per run with Helius' `getProgramAccountsV2` (same filter, a cursor between runs), folds it into a running aggregate in D1 (`lib/sweep.mjs`), and the run that reads the last page publishes the snapshot. The result is the same ledger (a test compares it with one `getProgramAccounts` over the recorded snapshot), but a full scan takes 5 runs: **a new snapshot every ~75 minutes instead of every 15**, and after a fresh deploy `/api/ledger` answers `warmingUp` for the first ~75 minutes. `snapshotAt` is when the scan started. `getProgramAccountsV2` is a Helius method: with another RPC in `PAYBLAME_RPC_URL`, set `LEDGER_PAGE_SIZE=0` (one full scan per run, Workers Paid).
- **GitHub account types fill in over several runs.** Each run asks GitHub for at most 10 of the ledger rows' ids it has not cached yet (the 7-day cache keeps the rest), so a new row can show its User/Org type as `?` for a few runs. Logins are masked either way.
- **A recipient lookup lists at most 20 coins** (`LOOKUP_MAX_LIMIT`), since each listed coin costs three PDA derivations. The count of coins stays exact and the site says the list is cut. A coin lookup is not affected.
- **Can't fit: recipients with tens of thousands of coins.** For those the ten probe answers alone are several MB of JSON (one fee-platform account with ~32,000 coins: ~7 MB), which takes more than 10 ms to parse whatever the limit. Cloudflare tolerates an occasional overrun per isolate; repeated ones end in error 1102, which the site shows as a failed lookup. The ledger and every other lookup keep working. On Workers Paid (`CF_FREE_PLAN=0`) these lookups work as on Netlify.
- **D1 use** stays small: a cron run writes 1 to 13 rows (sweep state, snapshot, new GitHub ids) and reads about 50; `/api/ledger` reads 1 row per request (then keeps the answer in memory for 5 minutes). The largest value stored is the ~15 KB snapshot, far below D1's 2 MB row limit, and `lib/store.mjs` refuses anything over it.
- **Requests.** Static files don't count against the 100,000 requests a day; each page view calls `/api/ledger` once and the demo-coin lookup once.

On Workers Paid, set `CF_FREE_PLAN=0` in `wrangler.jsonc`: one `getProgramAccounts` per cron run, 50 GitHub lookups, recipient lookups up to `limit=250`, a cap of 1,000 fetches. `/api/ledger` still never scans in the request.

## Deploy to Netlify

1. Create a site from this GitHub repo. The root `netlify.toml` sets `base = "app"`, `command = "npm run build"`, `publish = "site/dist"`, `functions = "netlify/functions"`, `node_bundler = "esbuild"` and Node 22. Nothing to change in the UI.
2. Set `HELIUS_API_KEY`, `GITHUB_TOKEN` and `LEDGER_MASK_SECRET` under Site configuration > Environment variables. Netlify Blobs needs no setup.
3. Deploy. `@netlify/blobs` is the only runtime dependency; esbuild bundles the library from `../src` into each function.
4. Scheduled function: `ledger-cron` runs every 15 minutes (declared in `netlify.toml` and inline in the function), on published deploys only. Until its first run, `/api/ledger` builds the snapshot on demand. The function log prints `[ledger-cron] 12274 accounts ...`.
5. Webhooks: none are needed. A Helius webhook on `create_fee_sharing_config` (a "a new coin now pays you" watch mode) is PLANNED, not built.
6. Netlify's synchronous function limit is 10 s. Measured lookups take 0.2-2.5 s; the largest recipient found (18,883 coins, `limit=250`) took about 2.5 s.

### Pre-launch -> live (`TOKEN_MINT`)

Nothing depends on the project's own coin. While `TOKEN_MINT` is empty, `/api/health` returns `tokenMint: null` and the site hides the CA row. To go live, set `TOKEN_MINT=<mint>` on Netlify and trigger a deploy: `/api/health` reads it at runtime and `npm run build` inlines it into the site (`scripts/build.mjs`, `__TOKEN_MINT__`), which shows the CA and a "blame this coin" button that runs `/api/lookup?q=<TOKEN_MINT>` like any other mint. A value that isn't a base58 address fails the build.

## Data sources and limits

| source | used for | limit / cost |
|---|---|---|
| Helius RPC `getProgramAccounts` on pump_fees | 10 memcmp probes per recipient (pubkeys only, `dataSlice` length 0); one SocialFeePda scan per ledger | 10 credits each |
| Helius RPC `getProgramAccountsV2` on pump_fees | Workers Free plan only: the same SocialFeePda scan, one page of 3000 per cron run | billed by Helius like `getProgramAccounts` calls, one per run |
| Helius RPC `getMultipleAccounts` / `getAccountInfo` / `getMinimumBalanceForRentExemption` | configs (420-byte slice), vaults (8-byte slice), curves, SocialFeePdas; rent cached 1 h | 1 credit each, 100 keys per call |
| Helius DAS `getAssetBatch` / `getAsset` | coin name, symbol, description | 10 credits; nulls if it fails |
| GitHub REST `GET /users/{login}`, `GET /user/{id}` | login <-> numeric id | 60/h without `GITHUB_TOKEN`, 5,000/h with it; cached 7 days |
| DexScreener `GET /tokens/v1/solana/{mint}` | market cap, dex, pair URL | free, ~300 req/min; optional (null on failure) |

RPC calls retry 429/503 with backoff.

## Cost (Helius credits)

Measured with `bench/live.mjs` and the smoke test on 2026-09-25:

| action | credits | how often |
|---|---|---|
| page view, first load: `/api/ledger` | **0** (served from Blobs) | every view |
| the site's automatic demo-coin lookup (beat 2) | ~13 (15 cold), cached 60 s | at most once a minute per function instance / CDN edge |
| a coin lookup someone types | ~13 | cached 60 s per query |
| a recipient lookup someone types | ~114 (116 cold; up to ~121 at `limit=250`) | cached 300 s per query, never on page load |
| `ledger-cron` | 11 (1 gPA + 1 rent call) | every 15 min: ~1,060/day, ~32k/month |

A typical page view costs at most ~13 credits, 0 while caches are warm.

## Layout

```
app/
  worker.mjs           Cloudflare Workers entry: /api/* -> netlify/functions by config.path, the rest -> site/dist; scheduled() -> ledger-cron
  wrangler.jsonc       the Worker: assets, D1 binding, the cron, CF_FREE_PLAN
  migrations/          0001_kv.sql, the D1 table behind lib/store.mjs
  netlify/functions/   lookup.mjs (/api/lookup), ledger.mjs (/api/ledger), health.mjs (/api/health), ledger-cron.mjs (*/15)
  lib/                 api.mjs (validation, caching, error mapping; pure, tested offline), sources.mjs (env -> RPC URL,
                       GitHub token, store-backed GitHub cache, mask secret), store.mjs (D1, Blobs or app/.data), ttl.mjs,
                       platform.mjs (Netlify or Cloudflare, per-invocation budgets), sweep.mjs (the paged ledger scan)
  site/                index.html, 404.html, src/ (main.js, scene/, sections/, function/), public/ (fonts, textures, og.png)
  scripts/             build.mjs, dev.mjs
  test/                api.test.mjs (service layer on replayed mainnet traffic), shipped.test.mjs (no recipient, handle
                       or key in anything app/ ships), store-d1.test.mjs (D1 backend on a fake and on node:sqlite),
                       sweep.test.mjs (paged scan = one scan), worker.test.mjs (routing, assets, scheduled),
                       helpers/fake-d1.mjs, smoke.mjs, record.mjs, fixtures/ledger-snapshot.json
```

## Licenses

Code: MIT, see [`../LICENSE`](../LICENSE). Site assets (fonts OFL-1.1, textures and HDRI CC0, Draco decoder Apache-2.0) are listed with sources and authors in [`site/public/CREDITS.md`](site/public/CREDITS.md).
