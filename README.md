# payblame

**git blame, but for money: every pump.fun coin that pays a GitHub account, reverse-indexed straight from chain state.**

```
$ payblame <login>
# payblame github:<login> id=#### type=User pda=####..####
# coins=89 listed=89 unclaimed=691.462 claimed=0.000 last-claim=never pending=26.091 SOL
####     (####        10000bps 1/1 locked )     10.546 SOL pending
####     (####        10000bps 1/1 locked )      3.267 SOL pending
####     (####        10000bps 1/1 MUTABLE)      2.114 SOL pending
...
```

SAMPLE output: a real lookup of one GitHub recipient on 2026-09-25, with the login, id, PDA, coin addresses and symbols masked as `####`. The numbers are as printed. This README doesn't name whose account it was. Run it on your own login.

Since February 2026, a pump.fun coin can send its creator fees to a GitHub account instead of a wallet. Anyone can launch a coin that names a dev, and the dev doesn't have to know it exists. The fees pile up in an on-chain escrow until the dev logs in to pump.fun and claims them. Payblame answers two questions from chain state alone, with no indexer, no pump.fun API and no database:

1. **Which coins pay this account?** Give it a GitHub login, a GitHub or X numeric id, or a wallet. It lists every coin whose fee split includes that recipient, with the bps, the fees pending in each coin's vaults, whether the split is locked or MUTABLE, and what the account has claimed and left unclaimed.
2. **Who does this coin pay?** Give it a mint. It prints the on-chain split, each recipient's claim record, and a diff between the handles the coin *names* in its metadata and the recipients the chain *actually pays*.

The trick is that pump.fun's `SharingConfig` account keeps its shareholders at fixed byte offsets. So "which of the 678,295 configs pay X?" becomes 10 `memcmp` filters that the RPC node runs for you.

> listed != involved: recipients did not necessarily launch, endorse or know about these coins.

## How it works

```
 login ──GitHub REST──> numeric id ──PDA('social-fee-pda', id, 2)──> recipient R (SocialFeePda)
                                                                        │
      ┌─────────────────────────────────────────────────────────────────┘
      │  10 x getProgramAccounts(pump_fees, dataSlice {0,0}):
      │     memcmp(0,   SharingConfig discriminator)  AND  memcmp(80 + 34*i, R)     i = 0..9
      v
  { config pubkey -> slot i }  ── exact coin count, pubkeys only (no account data comes back)
      │
      │  first `limit` configs by address  ──getMultipleAccounts(dataSlice {0,420})──> decode
      v
  per config C:  PDA('creator-vault', C, pump)             -> lamports - rentExempt(0)
                 ATA(PDA('creator_vault', C, pump_amm), WSOL) -> u64 amount @64
                 pending x bps / 10000                     -> what R gets on the next distribute
      │
      └──> SocialFeePda R (179 bytes): total_claimed, last_claimed, lamports - rentExempt(179) = unclaimed
```

### SharingConfig (program `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`, 1024 bytes)

| offset | size | field |
|---|---|---|
| 0 | 8 | discriminator `d84a0900388c5d4b` = sha256("account:SharingConfig")[0..8] |
| 8 | 1 | bump |
| 9 | 1 | version (1 and 2 are both live) |
| 10 | 1 | status (0 paused, 1 active) |
| 11 | 32 | mint |
| 43 | 32 | admin |
| 75 | 1 | admin_revoked (1 = split locked, 0 = **MUTABLE**: the admin can rewrite the shareholders) |
| 76 | 4 | shareholder count n, u32 LE (1..10) |
| 80 + 34k | 32 | shareholder k address |
| 112 + 34k | 2 | shareholder k share, u16 LE bps (they sum to 10000) |

Bytes after `80 + 34n` are zero. That is why the reverse index works: a recipient key at offset `80 + 34i` can only match a real slot `i`. The one exception is the all-zero key, which would match every empty slot, and the library refuses it.

### SocialFeePda (same program, 179 bytes, seeds `["social-fee-pda", utf8(user_id), [platform]]`)

| offset | field |
|---|---|
| 0 | discriminator `8b6035112aa9ce96` |
| 8, 9 | bump, version |
| 10 | user_id: u32 length + UTF-8, at most 20 bytes. Usually the numeric account id as text, but not always (see below) |
| 14+len | platform u8 (0 pump, 1 X, 2 GitHub) |
| 15+len | total_claimed u64 (lamports) |
| 23+len | last_claimed u64 (unix seconds, 0 = never) |
| 31+len | total_stable_claimed u64, then 120 reserved bytes |

Every field ends by byte 59, so the network-wide ledger fetches all SocialFeePdas with `dataSlice {0, 59}` in a single call.

**Some user_ids are text, not numbers.** The program stores whatever string the account was created with. In the snapshot of 2026-09-25 13:48Z, 90 of the 12,274 SocialFeePdas held free text instead of a numeric id: X handles, names with spaces, URLs such as `x.com/<handle>`. By platform: 59 X, 25 GitHub, 2 Pump, 4 unnamed (3 and 4). None of them had claimed anything, and together they held 81.256 SOL unclaimed. payblame treats them like this:

- `decodeSocialFeePda` returns the text as it is stored. `isNumericId(id)` tells the two kinds apart.
- The ledger counts a text-id account under its platform byte like any other, and ranks it by the same numbers. The 25 on the GitHub platform are part of `github-recipients` (11,455 in that snapshot).
- A text id is never sent to GitHub, because the REST route `/user/<id>` only takes numbers. `resolveIds` maps it to `null` and carries on with the numeric ids.
- A masked row (the default) prints `github:####`, like every other row. `--ledger --reveal` prints the text as stored, as `github:#<text>` (non-ASCII becomes `?`), because the account holds no GitHub login to resolve.
- The query grammar's `ghid:` and `x:` only take digits. To look up a text-id account, pass its SocialFeePda address, or a mint whose split pays it.
- The test fixture replaces every text id with a placeholder of the same byte length (`sample_x_0007`, `~07`) at that placeholder's PDA (see Tests).

### Where the money sits

- A fee-shared coin's bonding-curve `creator` (byte 49 of the curve) **is** its SharingConfig PDA. Fees accrue to the pump creator vault `PDA(["creator-vault", creator], pump)` as lamports. After graduation they also accrue to the WSOL token account of `PDA(["creator_vault", creator], pump_amm)`.
- `pending = max(0, pumpVault - rentExempt(0)) + ammVaultWsol`. A permissionless `distribute_creator_fees` splits it by bps. For a SocialFeePda shareholder, pump.fun's claim flow then pays the user and updates `total_claimed` / `last_claimed`.
- `unclaimed = lamports(SocialFeePda) - rentExempt(179)`. `received = total_claimed + unclaimed`.

### Cost

For a recipient with c coins and a limit L: 10 `getProgramAccounts` probes, plus 1 `getMultipleAccounts` per 100 configs, plus 1 per 50 configs for the vaults, plus 1 DAS `getAssetBatch`. That is O(1) probes and O(min(c, L)) decoding, whatever the size of the program. The PDA math (sha256 plus an ed25519 decompression check, in BigInt) runs locally with no dependencies.

## Install and use

```
npm i payblame        # PLANNED: not yet on npm. Until then: git clone, then npm link
```

```js
import { lookup, blameCoin, buildLedger } from 'payblame';

const rpcUrl = process.env.PAYBLAME_RPC_URL;            // any mainnet RPC with getProgramAccounts + memcmp
const r = await lookup('<github-login>', { rpcUrl, limit: 50 });
console.log(r.totals.coins, r.account.unclaimedLamports / 1e9, r.account.lastClaimedAt);
console.log(r.blame.join('\n'));                         // git-blame text, ASCII only

const c = await blameCoin('<mint>', { rpcUrl });
console.log(c.config.shareholders, c.mismatch, c.diff);  // declared vs on-chain
```

### CLI

```
payblame <github-login>            recipient blame (Format A)
payblame ghid:<numeric-id> | x:<numeric-id> | <wallet>
payblame <mint>                    coin blame + declared-vs-on-chain diff (Format B)
payblame --ledger                  every GitHub fee account on pump.fun (Format L), logins masked
payblame --ledger --reveal         the same, with real GitHub logins (opt-in)
payblame <q> --json [--limit n]    machine output (same shapes as the API)

env: PAYBLAME_RPC_URL (required), GITHUB_TOKEN (optional, 60 -> 5000 GitHub requests/h),
     PAYBLAME_MASK_SECRET (optional, keeps masked row ids stable across runs)
```

```
$ payblame <mint>
# payblame ####..pump $#### "####" config=#### v2 active locked
# vault pending=0.030 SOL (pump 0.000 + pumpswap 0.030)
####     (github:<login>           10000bps) claimed=20376.511 unclaimed=0.000 last=2026-09-25

--- declared (name/symbol/description)
+++ on-chain (SharingConfig)
- x:@<declared-handle>
+ github:<login> 10000bps
```

SAMPLE output: a real coin on 2026-09-25, with the mint, names and handles masked. Its description says its fees go to an X handle "via" a fee platform. On-chain, 100% of its fees go to one GitHub account, the platform's, which claims regularly. Any forwarding to the X account happens off-chain. "Not on-chain" is not the same as "not paid": an intermediary may forward fees. The diff only shows what the chain can prove. `node examples/coin-diff.mjs` runs this lookup on its default mint.

```
$ payblame --ledger          (2026-09-25T16:56Z)
# payblame --ledger 2026-09-25T16:56Z github-recipients=11458 logins=masked
# unclaimed=17504.168 claimed=86016.533 never-claimed=10286 (SOL)
row:aa5f6c33 (github:####                  user) unclaimed=1869.443  claimed=0.000     last=never
row:f8253337 (github:####                  org ) unclaimed=1292.372  claimed=0.000     last=never
row:c6b0b82d (github:####                  org ) unclaimed=998.159   claimed=0.000     last=never
```

**The ledger masks logins by default.** A ranked list of real people by unclaimed SOL reads as a target list for "claim your fees" phishing, so `--ledger`, `buildLedger()` and the `/api/ledger` endpoint built on it print `github:####` and a row id. A masked row keeps its numbers and its User/Org type. `login` becomes `####`, and `githubId` and `socialFeePda` become `null`, because the PDA decodes to the GitHub id. `rowId` is `row:` plus 8 hex of HMAC-SHA256(secret, socialFeePda): it is stable for one secret and can't be reversed without it. `--reveal` (or `buildLedger({ reveal: true })`) prints the real logins. A lookup of one login, id, wallet or mint always shows who it pays, because you asked for that account. The chain is public and this is a convenience default, not a privacy guarantee.

Numbers are always `key=value` (`unclaimed=1869.443 claimed=0.000 last=never`), never a label followed by a number, so a cropped screenshot can't pair a login with the wrong amount.

**Masking one lookup.** `maskLookup(result)` is for output nobody asked for, such as an auto-run demo or a feed. It returns a copy of a coin or recipient result with no GitHub login (`####`), no declared handle (`@####`), no social user id (`null`) and no SocialFeePda address (`####`, because the PDA's account data holds the user id). A word of the coin's name or symbol that spells one of those becomes `####` too. The masking covers the structure, the name/symbol/description text, the diff and the blame lines. Numbers, bps, mints, the SharingConfig and the vaults stay, so the output still explains the coin. The result adds `masked: true`, `logins: "masked"` and a `loginsNote`. Masking a masked result changes nothing.

**One mask, one width.** Everything payblame masks prints as the same four characters, `####` (exported as `MASK`; `LOGIN_MASK`, `HANDLE_MASK` and `ADDRESS_MASK` are the same string). The width never depends on the real value, because the length of a login is a clue too. Fixed-width columns pad the mask with spaces.

### API

`lookup(q, opts)`, `blameRecipient(input, opts)`, `blameCoin(mint, opts)`, `buildLedger(opts)` (masked unless `{ reveal: true }`; `maskSecret` for stable row ids), `maskLedger(ledger, { secret })`, `maskLookup(result)`, `MASK` (`'####'`), `isNumericId(userId)`, `ticker(symbol)` (strips a leading `$`, so `$RapCat` prints once as `$RapCat`), `parseQuery(q)`, `decodeSharingConfig(bytes)`, `decodeSocialFeePda(bytes)`, `socialFeePda(id, platform)`, `sharingConfigPda(mint)`, `creatorVaultPdas(creator)`, `formatBlame`, `formatCoin`, `formatLedger`, `extractDeclared`, `diffDeclared`, `aggregateLedger`.

Every network function takes `{ rpcUrl | rpc, githubToken?, fetch?, cache?, timeoutMs? }`. Injecting `fetch` is how the tests replay recorded mainnet traffic. Errors are `PayblameError` with `code` set to `BAD_INPUT`, `GITHUB_NOT_FOUND`, `NOT_PUMP`, `GITHUB_RATE_LIMIT` or `UPSTREAM`, and an HTTP-ready `status`. Types are in `src/index.d.ts`.

Runtime dependencies: **none**. It needs Node >= 22 (`node:crypto` for sha256 and global `fetch`). Base58, Borsh decoding and the PDA math are hand-written.

## Benchmarks (measured)

Offline, on recorded mainnet accounts (`node bench/decode.mjs`, Apple M5, 10 cores, Darwin 25.5.0, Node v26.8.1, 2026-09-25):

| benchmark | result |
|---|---|
| decodeSharingConfig (2 shareholders, recorded account) | 186,385 decodes/s |
| decodeSocialFeePda (179 bytes) | 6,303,415 decodes/s |
| aggregateLedger over the 12,274 recorded SocialFeePdas (decode + aggregate + rank) | 5 ms (median of 20) |
| socialFeePda(id, 2) derivation (sha256 + BigInt ed25519 off-curve check) | 5,729 /s |
| creatorVaultPdas(config), 3 PDAs including the WSOL ATA | 1,898 /s |

Live, network-bound (`PAYBLAME_RPC_URL=... node bench/live.mjs <login> 5`, same Mac, Helius mainnet RPC, 2026-09-25T13:55Z). The measured account was a GitHub recipient with 89 coins; this README doesn't name it. Pass any login to reproduce. The probe count is always 10, and the decode work grows with the number of coins:

| measurement | result |
|---|---|
| `payblame <login>` end to end (89 coins), median of 5 | 782 ms (runs: 782, 486, 472, 1595, 1585) |
| RPC calls per lookup | 17 cold, 15 warm (rent constants cached) |
| Helius credits per lookup (gPA and DAS at 10, other calls at 1) | 116 cold, 114 warm |
| one reverse probe, slots 0..9, run one at a time | 101, 83, 86, 84, 84, 91, 44, 45, 80, 1132 ms |
| buildLedger: 1 getProgramAccounts over 12,274 SocialFeePdas, median of 3 | 278 ms |

The live numbers depend on your RPC and its load. In our runs, the same probe sometimes took 1–2 s. For scale: a full `getProgramAccounts` over all SharingConfigs, even with no data, returned 678,295 accounts, 155 MB, in 21.2 s. The probes return only the matching pubkeys. The largest recipient we found, a GitHub account with 18,883 coins, is one 4.3 MB probe that took about 1.1 s.

## Tests

```
npm test        # offline: decoders, PDAs, grammar, diff, formats, GitHub fallbacks, RPC retry,
                # a synthetic 20,000-coin recipient, 7 end-to-end lookups replayed from recorded mainnet traffic,
                # and the fixture guard (decodes every account in every fixture; fails on any non-placeholder id)
npm run record  # re-record the fixtures (needs PAYBLAME_RPC_URL; PAYBLAME_RECORD_LOGIN for the recipient fixture)
```

The fixtures are recorded mainnet traffic, scrubbed before they are written (`test/helpers/scrub.js`, called by `npm run record`). GitHub logins become `sample-login-NN`, keyed by numeric id, so one account has the same placeholder in every fixture, including the ledger fixture. Handles a coin declares become `sample_handle`. GitHub REST bodies are cut down to `{ login, id, type }`. DAS and DexScreener bodies keep only the fields payblame reads. Every pump coin is renamed `Sample coin NN` / `SMPLNN` and loses its description (unless the test needs it, in which case its handles are placeholders), because a coin's name can spell a person too. In the ledger fixture, the 90 SocialFeePdas whose on-chain user_id is text carry a placeholder of the same byte length (`sample_x_0007`, or `~07` when the id is short) and the PDA of that placeholder. Their lamports, platform, claim fields and byte layout are as recorded. The rest of the chain data (account bytes, PDAs, numeric ids, lamports) is left as recorded, so the replays run the real decode path, and each fixture's `expect` is re-derived by replaying its scrubbed transcript.

`test/mask.test.js` is the guard. It gunzips every fixture, parses every JSON body inside it, and decodes every base64 account by its discriminator: SocialFeePda user_ids, SharingConfig and BondingCurve fields, and a Borsh-string scan of anything else. It fails on any login, handle, text user_id, coin name or description word that isn't a placeholder, and on a placeholder id that isn't at its own PDA. The guard knows what a placeholder looks like. It doesn't list the real accounts. Test inputs written by hand use placeholders too (`sample-dev`, `sample-org`, `x:1000000003`). The numeric GitHub ids in `test/pda.test.js` are there only because the PDA math has to match real mainnet accounts.

## Limits and PLANNED

- **PLANNED: per-coin lifetime distribution and a claim timeline.** Lifetime SOL per coin only exists in `DistributeCreatorFeesEvent` / `SocialFeePdaClaimed` self-CPI event data, so it needs `getSignaturesForAddress` plus `getTransaction` decoding. Today payblame reports per-recipient lifetime `total_claimed`, which is exact, and per-coin *pending* amounts.
- **PLANNED: resolving X numeric ids to handles.** Today X recipients show as `x:#<id>`.
- **PLANNED: a watch mode** (a webhook on `create_fee_sharing_config` that tells a GitHub user when a new coin starts paying them).
- **Pending is an upper bound.** The pump program has a minimum distributable amount, so tiny piles may not move yet.
- **The recipient path reads vaults by the SharingConfig address.** It assumes the curve creator is the config, which held on every mint we checked. The coin path reads the curve and follows its actual creator.
- **Truncation.** Only the first `limit` configs, by address, are decoded (max 250). `totals.coins` is always exact.
- **GitHub REST allows 60 requests/h without a token.** When limited, login-to-id falls back to the public avatar redirect (`github.com/<login>.png` redirects to `/u/<id>`), and id-to-login shows `github:#<id>`.
- Organizations show as `type=Organization`. Whether an org can claim through pump.fun is not verified here.
- Layout changes: decoders check discriminators and lengths and flag unknown `SharingConfig` versions (`versionRecognized: false`).

## Prior art

- [nirholas/pumpfun-creator-rewards](https://github.com/nirholas/pumpfun-creator-rewards) looks up earnings through pump.fun's private `swap-api` fee-sharing endpoints. payblame uses no pump.fun endpoint. It reads chain state, so it keeps working if that API changes.
- [nirholas/pumpfun-claims-bot](https://github.com/nirholas/pumpfun-claims-bot) and [pumpfun-github-claims](https://github.com/nirholas/pumpfun-github-claims) are Telegram feeds of claims. They have no lookup and no unclaimed balances.
- [@pump-fun/pump-sdk](https://www.npmjs.com/package/@pump-fun/pump-sdk) builds instructions and PDAs. The account layouts and seeds used here come from its 2.0.0 IDLs (`pump_fees.json`, `pump.json`, `pump_amm.json`, `src/pda.ts`).
- None of these reverse-index recipients with memcmp probes, print the whole-network ledger from one call, flag MUTABLE splits, or diff declared recipients against the on-chain split.

## The live app

[`app/`](app/) is the code behind **https://payblame.netlify.app**: the site (three.js, a procedural dot-matrix printer) and the Netlify Functions that run this library on mainnet (`/api/lookup`, `/api/ledger`, `/api/health`, and `ledger-cron` every 15 minutes). It imports the library from `src/`; the library never imports anything from `app/`, and `app/` is not part of the npm package.

```sh
cd app && npm ci && cp .env.example .env   # then add HELIUS_API_KEY
npm test && npm run build && npm run dev   # http://localhost:8888
```

To deploy your own copy, create a Netlify site from this repo. The root `netlify.toml` builds `app/` and bundles its functions. Set `HELIUS_API_KEY`, `GITHUB_TOKEN` (optional; without it GitHub allows 60 requests/h) and `LEDGER_MASK_SECRET`. [`app/README.md`](app/README.md) has the endpoints, env vars, schedules and credit costs.

## License

MIT. See [LICENSE](LICENSE).
