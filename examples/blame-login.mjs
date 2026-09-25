// Every pump.fun coin whose creator fees route to a GitHub account (mainnet, read-only).
//   PAYBLAME_RPC_URL=https://mainnet.helius-rpc.com/?api-key=... node examples/blame-login.mjs <github-login>
// Try your own login, or pick any row from `payblame --ledger --reveal`.
import { lookup } from '../src/index.js';

const q = process.argv[2];
if (!q) { console.error('usage: node examples/blame-login.mjs <github-login | ghid:<id> | wallet>'); process.exit(2); }
const r = await lookup(q, { rpcUrl: process.env.PAYBLAME_RPC_URL, limit: 20 });
console.log(r.blame.join('\n'));
console.log(`\n${r.totals.coins} coins; probe hits per slot: ${r.probeHits.join(' ')}; ${r.meta.rpcCalls} RPC calls in ${r.meta.timingMs.total} ms`);
