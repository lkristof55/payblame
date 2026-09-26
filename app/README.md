# payblame app: the site and its backend

This folder is the code behind **https://payblame.netlify.app**: a static site (three.js, gsap, lenis) and three Netlify Functions plus one scheduled function. The functions import the `payblame` library from the repo root (`../src`), so the live demo runs the same code as the CLI and the npm package. Type a GitHub login, a mint or a wallet and it prints every pump.fun coin that routes creator fees to it and what is still unclaimed, read straight from chain state (ten `memcmp` probes, no indexer, no pump.fun API).

> listed != involved: recipients did not necessarily launch, endorse or know about these coins.

## Run locally

Node 22 or newer.

```sh
cd app
npm ci
cp .env.example .env          # then fill in HELIUS_API_KEY (the only required value)
npm test                      # offline: 18 tests on recorded, scrubbed mainnet fixtures
npm run build                 # site/src -> site/dist
npm run dev                   # site + every /api/* function on http://localhost:8888
npm run smoke                 # in a second shell: real mainnet requests against the dev server
```

- `npm run dev -- --port 8102` picks another port; `--cron` also runs `ledger-cron` at start and once a minute; `npm run watch` rebuilds the site and reloads functions on change.
- Locally, `lib/store.mjs` keeps what production keeps in Netlify Blobs as JSON files in `app/.data/` (git-ignored).
- `npm run record` re-records the fixtures (needs `HELIUS_API_KEY`). The library's fixtures at the repo root go through its scrubber; `test/fixtures/ledger-snapshot.json` is written masked, with row ids under a random secret that is thrown away.

The scripts in `scripts/` are small and have no dependencies beyond esbuild: `build.mjs` bundles `site/src/main.js` into `site/dist/app.js` (with code-split chunks) and copies `site/*.html` and `site/public/**`; `dev.mjs` serves `site/dist` and runs each `netlify/functions/*.mjs` as a Netlify v2 function (`export default async (req, context) => Response`, routed by `config.path`).

## Endpoints

| method and path | what | cache |
|---|---|---|
| `GET /api/lookup?q=<query>&limit=<1-250>&mask=1` | recipient blame (every coin that pays `q`) or coin blame (who a mint pays, declared vs on-chain) | coin 60 s, recipient 300 s |
| `GET /api/ledger` | network-wide SocialFeePda snapshot for the hero: totals, top 25 unclaimed, top 10 claimed, 15 recent claims, all masked | 900 s; Blobs `ledger/latest` |
| `GET /api/health` | `{ ok, keys: { helius, birdeye, github }, tokenMint }`: key names only, never values | none |
| `ledger-cron` (scheduled, `*/15 * * * *`) | one `getProgramAccounts` over every SocialFeePda, stored masked in Blobs | n/a |

`q` is a GitHub login (`<login>`, `@<login>`, `github:<login>`), `ghid:<id>`, `x:<id>`, a wallet, a SocialFeePda, a SharingConfig or a mint.

```sh
curl 'http://localhost:8888/api/lookup?q=J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpump'          # a coin: its fee split and the declared-vs-on-chain diff
curl 'http://localhost:8888/api/lookup?q=J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpump&mask=1'   # the same coin, logins/handles/ids masked
curl 'http://localhost:8888/api/lookup?q=<your-github-login>&limit=24'                          # every coin that pays that account
curl -s 'http://localhost:8888/api/ledger' | jq -r '.blame[]' | head -4
curl 'http://localhost:8888/api/health'
```

Errors are JSON `{ error, code, retryAfterSeconds? }`: 400 `BAD_INPUT` (q outside the grammar, bad `limit` or `mask`), 404 `GITHUB_NOT_FOUND` / `NOT_PUMP`, 429 `GITHUB_RATE_LIMIT` (with `Retry-After`), 502 `UPSTREAM` (the RPC failed or timed out; every upstream call has an 8 s timeout, 20 s for the cron's scan). No stack traces or upstream URLs are returned.

### Who gets named

- **`/api/ledger` never names anyone.** Every row has `login: "####"`, `githubId: null`, `socialFeePda: null` (the PDA decodes to the GitHub id), `masked: true` and a `rowId` = `row:` + 8 hex of HMAC-SHA256(`LEDGER_MASK_SECRET`, socialFeePda). There is no parameter that unmasks it. Masking runs on every response, so an older stored snapshot is still served masked. The numbers are public chain data; the masking stops this site from publishing a ranked list of people by default.
- **`/api/lookup?mask=1`** masks logins, declared handles, social user ids and SocialFeePda addresses (the site's automatic demo uses it). Without `mask`, a lookup answers for exactly the account or coin the caller typed.
- The site never pre-fills a person's account: its examples are a mint and `--ledger`.

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
  netlify/functions/   lookup.mjs (/api/lookup), ledger.mjs (/api/ledger), health.mjs (/api/health), ledger-cron.mjs (*/15)
  lib/                 api.mjs (validation, caching, error mapping; pure, tested offline), sources.mjs (env -> RPC URL,
                       GitHub token, Blobs-backed GitHub cache, mask secret), store.mjs (Blobs or app/.data), ttl.mjs
  site/                index.html, 404.html, src/ (main.js, scene/, sections/, function/), public/ (fonts, textures, og.png)
  scripts/             build.mjs, dev.mjs
  test/                api.test.mjs (service layer on replayed mainnet traffic), shipped.test.mjs (no recipient, handle
                       or key in anything app/ ships), smoke.mjs, record.mjs, fixtures/ledger-snapshot.json
```

## Licenses

Code: MIT, see [`../LICENSE`](../LICENSE). Site assets (fonts OFL-1.1, textures and HDRI CC0, Draco decoder Apache-2.0) are listed with sources and authors in [`site/public/CREDITS.md`](site/public/CREDITS.md).
