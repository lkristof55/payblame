#!/usr/bin/env node
// payblame CLI. Needs PAYBLAME_RPC_URL (a mainnet RPC that allows getProgramAccounts with memcmp).
import { lookup, buildLedger, PayblameError } from '../src/index.js';

const HELP = `payblame: git blame, but for money

usage:
  payblame <github-login>            every pump.fun coin whose fees route to that account
  payblame ghid:<id> | x:<id> | <wallet>
  payblame <mint>                    who a coin pays, plus declared-vs-on-chain diff
  payblame --ledger                  every GitHub fee account on pump.fun, ranked, logins masked
options:
  --json          print the full result as JSON
  --limit <n>     coins decoded in detail (1-250, default 100)
  --reveal        --ledger only: print real GitHub logins instead of github:#### + row ids
env:
  PAYBLAME_RPC_URL      required, e.g. https://mainnet.helius-rpc.com/?api-key=...
  GITHUB_TOKEN          optional, raises the GitHub API limit from 60 to 5000 requests/h
  PAYBLAME_MASK_SECRET  optional, keeps masked row ids stable across runs (else random per run)`;

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--limit');

if (flag('--help') || flag('-h') || (!positional.length && !flag('--ledger'))) {
  console.log(HELP);
  process.exit(positional.length || flag('--ledger') ? 0 : 1);
}
const rpcUrl = process.env.PAYBLAME_RPC_URL;
if (!rpcUrl) { console.error('payblame: set PAYBLAME_RPC_URL to a Solana mainnet RPC URL'); process.exit(2); }
const opts = {
  rpcUrl, githubToken: process.env.GITHUB_TOKEN, limit: opt('--limit') ? Number(opt('--limit')) : undefined,
  reveal: flag('--reveal'), maskSecret: process.env.PAYBLAME_MASK_SECRET || undefined,
};

try {
  const t = performance.now();
  const out = flag('--ledger') ? await buildLedger(opts) : await lookup(positional.join(' '), opts);
  if (flag('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
  for (const line of out.blame) console.log(line);
  if (out.kind === 'coin' && out.diff.length) { console.log(''); for (const line of out.diff) console.log(line); }
  const calls = out.meta?.rpcCalls ?? out.stats?.rpcCalls;
  console.error(`# ${Math.round(performance.now() - t)} ms, ${calls} rpc calls. listed != involved: recipients did not necessarily launch, endorse or know about these coins.`);
} catch (e) {
  if (e instanceof PayblameError) { console.error(`payblame: ${e.message} (${e.code})`); process.exit(e.status === 400 ? 2 : 1); }
  throw e;
}
