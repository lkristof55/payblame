// Who a coin says it pays vs who its SharingConfig pays (mainnet, read-only).
//   PAYBLAME_RPC_URL=... node examples/coin-diff.mjs [mint]
// The default mint is a coin whose description names an X handle while its SharingConfig pays one GitHub account.
import { blameCoin } from '../src/index.js';

const c = await blameCoin(process.argv[2] || 'J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpump', { rpcUrl: process.env.PAYBLAME_RPC_URL });
console.log(c.blame.join('\n'));
if (c.diff.length) console.log('\n' + c.diff.join('\n'));
console.log(`\nsplit locked: ${c.config ? c.config.adminRevoked : 'n/a (legacy creator)'}; declared recipients missing on-chain: ${c.mismatch}`);
