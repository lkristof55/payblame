// Offline micro-benchmarks on recorded mainnet fixtures. Usage: node bench/decode.mjs
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { decodeSharingConfig, decodeSocialFeePda, aggregateLedger, socialFeePda, creatorVaultPdas, sharingConfigPda, accountData } from '../src/index.js';
import { readGz } from '../test/helpers/transcript.js';

const raw = JSON.parse(readFileSync(new URL('../test/fixtures/raw-accounts.json', import.meta.url)));
const ledgerFx = readGz(new URL('../test/fixtures/ledger-socialfeepda.json.gz', import.meta.url));
const cfgBytes = accountData(raw.sharingConfig.dataBase64First420);
const sfpBytes = accountData(raw.socialFeePda.dataBase64);
const accounts = ledgerFx.accounts.map(([pubkey, lamports, b64]) => ({ pubkey, lamports, data: accountData(b64) }));

function rate(name, n, fn) {
  for (let i = 0; i < Math.min(n, 1000); i++) fn(i); // warm up
  const t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn(i);
  const s = Number(process.hrtime.bigint() - t) / 1e9;
  return { name, value: Math.round(n / s), unit: 'ops/s', n };
}
function median(name, runs, fn) {
  fn();
  const times = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); fn(); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  return { name, value: +times[Math.floor(runs / 2)].toFixed(1), unit: 'ms (median)', n: runs };
}

let sink = 0;
const results = [
  rate('decodeSharingConfig (2 shareholders, recorded account)', 100_000, () => { sink += decodeSharingConfig(cfgBytes).shareholders.length; }),
  rate('decodeSocialFeePda (179 bytes, recorded account)', 100_000, () => { sink += decodeSocialFeePda(sfpBytes).platform; }),
  median(`aggregateLedger over ${accounts.length} recorded SocialFeePda accounts (decode + aggregate + rank)`, 20, () => { sink += aggregateLedger(accounts, { rentExemptLamports: ledgerFx.rentExemptLamports }).accounts.total; }),
  rate('socialFeePda(id, 2) derivation (sha256 + ed25519 off-curve check)', 20_000, (i) => { sink += socialFeePda(String(100000 + i), 2).length; }),
  rate('sharingConfigPda(mint) derivation', 20_000, (i) => { sink += sharingConfigPda(accounts[i % accounts.length].pubkey).length; }),
  rate('creatorVaultPdas(config): 3 PDAs incl. the WSOL ATA', 5_000, (i) => { sink += creatorVaultPdas(accounts[i % accounts.length].pubkey).pumpVault.length; }),
];

const cpu = os.cpus()[0]?.model ?? 'unknown cpu';
console.log(`machine: ${cpu}, ${os.cpus().length} cores, ${os.platform()} ${os.release()}, Node ${process.version}`);
console.log('command: node bench/decode.mjs\n');
console.log('| benchmark | result | iterations |');
console.log('|---|---|---|');
for (const r of results) console.log(`| ${r.name} | ${r.value.toLocaleString('en-US')} ${r.unit} | ${r.n.toLocaleString('en-US')} |`);
if (sink === -1) console.log(sink);
