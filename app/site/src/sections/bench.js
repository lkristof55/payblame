// Benchmarks, copied from the repo root README.md ("Benchmarks (measured)"), each with its command. Update both together.
export const BENCH = [
  { value: '186,385', unit: '/s', what: 'decodeSharingConfig, recorded mainnet account', cmd: 'node bench/decode.mjs' },
  { value: '5', unit: 'ms', what: 'decode + aggregate + rank 12,274 SocialFeePdas (median of 20)', cmd: 'node bench/decode.mjs' },
  { value: '5,729', unit: '/s', what: 'socialFeePda derivations: sha256 + BigInt off-curve check', cmd: 'node bench/decode.mjs' },
  { value: '782', unit: 'ms', what: 'one recipient lookup, 89 coins, end to end (median of 5)', cmd: 'PAYBLAME_RPC_URL=... node bench/live.mjs <login> 5' },
  { value: '278', unit: 'ms', what: 'the whole ledger: 1 getProgramAccounts (median of 3)', cmd: 'PAYBLAME_RPC_URL=... node bench/live.mjs' },
  { value: '15', unit: 'rpc', what: 'calls per recipient lookup, warm (17 cold)', cmd: 'PAYBLAME_RPC_URL=... node bench/live.mjs' },
];
export const BENCH_MACHINE = 'Apple M5, 10 cores, Darwin 25.5.0, Node v26.8.1, 2026-09-25. Live numbers use Helius mainnet RPC at 13:55Z and depend on the RPC and its load. Source: README.md at the repo root.';
