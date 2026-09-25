// No network: decode a recorded SharingConfig and SocialFeePda, and derive the PDAs that tie them together.
//   node examples/offline-decode.mjs
import { readFileSync } from 'node:fs';
import { decodeSharingConfig, decodeSocialFeePda, socialFeePda, sharingConfigPda, creatorVaultPdas, accountData } from '../src/index.js';

const raw = JSON.parse(readFileSync(new URL('../test/fixtures/raw-accounts.json', import.meta.url)));
const cfg = decodeSharingConfig(accountData(raw.sharingConfig.dataBase64First420));
const sfp = decodeSocialFeePda(accountData(raw.socialFeePda.dataBase64));

console.log('SharingConfig', raw.sharingConfig.pubkey, { ...cfg, shareholders: cfg.shareholders.map((s) => `${s.address} ${s.bps}bps`) });
console.log('derived from its mint:', sharingConfigPda(cfg.mint), sharingConfigPda(cfg.mint) === raw.sharingConfig.pubkey ? '(matches)' : '(MISMATCH)');
console.log('fee vaults:', creatorVaultPdas(raw.sharingConfig.pubkey));
console.log('SocialFeePda', raw.socialFeePda.pubkey, sfp);
console.log(`PDA('social-fee-pda', '${sfp.userId}', ${sfp.platform}) =`, socialFeePda(sfp.userId, sfp.platform));
