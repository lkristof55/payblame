// Captures real mainnet responses into fixtures (run once; needs HELIUS_API_KEY or PAYBLAME_RPC_URL in app/.env):
//   npm run record
// 1. ../test/fixtures/*.json.gz (the library's fixtures at the repo root): request/response transcripts the
//    library and service tests replay. Scrubbed before they are written (see ../test/helpers/scrub.js).
// 2. test/fixtures/ledger-snapshot.json: a real /api/ledger body for the service tests, masked as served.
//    Its row ids use a random secret that is thrown away after the run, so they can't be mapped back to accounts.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(app, '..');
try {
  for (const line of readFileSync(path.join(app, '.env'), 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch { /* optional */ }
if (!process.env.HELIUS_API_KEY && !process.env.PAYBLAME_RPC_URL) { console.error('HELIUS_API_KEY or PAYBLAME_RPC_URL missing'); process.exit(2); }
process.env.PAYBLAME_RPC_URL ||= `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

const r = spawnSync(process.execPath, ['test/record.js'], { cwd: repo, stdio: 'inherit', env: process.env });
if (r.status !== 0) process.exit(r.status ?? 1);

const { buildLedger } = await import('../../src/index.js');
const ledger = await buildLedger({ rpcUrl: process.env.PAYBLAME_RPC_URL, githubToken: process.env.GITHUB_TOKEN, maxLookups: 50, maskSecret: randomBytes(32) });
writeFileSync(path.join(app, 'test/fixtures/ledger-snapshot.json'), JSON.stringify(ledger, null, 1));
console.log(`ledger-snapshot.json ${ledger.accounts.total} accounts at ${ledger.snapshotAt}`);
