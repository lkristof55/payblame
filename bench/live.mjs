// Live end-to-end benchmark (network-bound). Usage:
//   PAYBLAME_RPC_URL=https://mainnet.helius-rpc.com/?api-key=... node bench/live.mjs <login> [runs] [--show-login]
// The printed table writes the login as <login> unless --show-login is passed, so results can be pasted
// into a README without naming whose account was measured.
import os from 'node:os';
import { lookup, createRpc, probeSharingConfigs, socialFeePda, buildLedger, memoryCache } from '../src/index.js';

const rpcUrl = process.env.PAYBLAME_RPC_URL;
if (!rpcUrl) { console.error('set PAYBLAME_RPC_URL'); process.exit(2); }
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const login = args[0];
if (!login) { console.error('usage: node bench/live.mjs <github-login | ghid:<id> | wallet> [runs] [--show-login]'); process.exit(2); }
const runs = Number(args[1] || 5);
const shown = process.argv.includes('--show-login') ? login : '<login>';
const host = new URL(rpcUrl).host;
const cache = memoryCache();
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const walls = [];
const stats = [];
let last;
for (let i = 0; i < runs; i++) {
  const rpc = createRpc({ rpcUrl });
  const t = performance.now();
  last = await lookup(login, { rpc, cache, githubToken: process.env.GITHUB_TOKEN });
  walls.push(performance.now() - t);
  stats.push({ ...rpc.stats });
}

// per-slot probe latency (10 probes, sequential so each is timed alone)
const rpc = createRpc({ rpcUrl });
const addr = last.recipient.address;
const slotMs = [];
for (let i = 0; i < 10; i++) {
  const t = performance.now();
  await rpc.getProgramAccounts('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', { dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 0, bytes: 'dBH23jPD3C6' } }, { memcmp: { offset: 80 + 34 * i, bytes: addr } }] });
  slotMs.push(Math.round(performance.now() - t));
}
const tp = performance.now();
await probeSharingConfigs(createRpc({ rpcUrl }), addr);
const parallelMs = Math.round(performance.now() - tp);

const lt = [];
let ledger;
for (let i = 0; i < 3; i++) { const t = performance.now(); ledger = await buildLedger({ rpcUrl, cache, maxLookups: 0 }); lt.push(performance.now() - t); }

console.log(`machine: ${os.cpus()[0]?.model}, Node ${process.version}, RPC host ${host}, ${new Date().toISOString()}`);
console.log(`command: node bench/live.mjs ${shown} ${runs}\n`);
console.log('| measurement | result |');
console.log('|---|---|');
console.log(`| \`payblame ${shown}\` end to end (${last.totals.coins} coins), median of ${runs} | ${Math.round(med(walls))} ms (runs: ${walls.map((w) => Math.round(w)).join(', ')}) |`);
console.log(`| result | ${last.totals.coins} coins; RPC calls: ${stats[0].calls} cold, ${stats[stats.length - 1].calls} warm (rent cached) |`);
console.log(`| Helius credits per lookup (gPA and DAS 10, other calls 1) | ${stats[0].credits} cold, ${stats[stats.length - 1].credits} warm |`);
console.log(`| phase timing of the last run | ${JSON.stringify(last.meta.timingMs)} |`);
console.log(`| one reverse probe, per slot 0..9 | ${slotMs.join(', ')} ms |`);
console.log(`| all 10 probes in parallel | ${parallelMs} ms |`);
console.log(`| buildLedger (1 getProgramAccounts over ${ledger.accounts.total} SocialFeePdas), median of 3 | ${Math.round(med(lt))} ms |`);
