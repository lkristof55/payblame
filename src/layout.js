// Byte-level decoders for the accounts Payblame reads. Pure functions over Uint8Array; no I/O.
import { encodeBase58 } from './base58.js';
import { DISC, SHARING, SOCIAL, CURVE, TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from './constants.js';

export class DecodeError extends Error {}

const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const pubkeyAt = (b, o) => encodeBase58(b.subarray(o, o + 32));
const u64 = (dv, o) => Number(dv.getBigUint64(o, true));
function hasDisc(b, disc) {
  if (b.length < 8) return false;
  for (let i = 0; i < 8; i++) if (b[i] !== disc[i]) return false;
  return true;
}

/** RPC `data: [base64, 'base64']` (or a bare base64 string) to bytes. */
export function accountData(data) {
  const b64 = Array.isArray(data) ? data[0] : data;
  if (typeof b64 !== 'string') return new Uint8Array(0);
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export const isSharingConfig = (b) => hasDisc(b, DISC.SharingConfig);
export const isSocialFeePda = (b) => hasDisc(b, DISC.SocialFeePda);

/**
 * SharingConfig (pump_fees). Needs at least bytes 0..80+34n (dataSlice {0, 420} is always enough).
 *   0 disc(8) | 8 bump | 9 version | 10 status | 11 mint | 43 admin | 75 admin_revoked |
 *   76 u32 len | 80 + 34k: address(32) + share_bps u16 LE
 * @param {Uint8Array} b
 */
export function decodeSharingConfig(b) {
  if (!isSharingConfig(b)) throw new DecodeError('not a SharingConfig (discriminator mismatch)');
  if (b.length < SHARING.shareholders) throw new DecodeError(`SharingConfig too short: ${b.length} bytes`);
  const dv = view(b);
  const n = dv.getUint32(SHARING.vecLen, true);
  if (n > SHARING.maxShareholders) throw new DecodeError(`SharingConfig has ${n} shareholders (max 10)`);
  if (b.length < SHARING.shareholders + SHARING.stride * n) throw new DecodeError('SharingConfig truncated inside the shareholder vec');
  const shareholders = [];
  let bpsTotal = 0;
  for (let k = 0; k < n; k++) {
    const o = SHARING.shareholders + SHARING.stride * k;
    const bps = dv.getUint16(o + 32, true);
    bpsTotal += bps;
    shareholders.push({ address: pubkeyAt(b, o), bps });
  }
  const version = b[SHARING.version];
  const statusCode = b[SHARING.status];
  return {
    bump: b[SHARING.bump],
    version,
    versionRecognized: version === 1 || version === 2,
    statusCode,
    status: statusCode === 1 ? 'active' : 'paused',
    mint: pubkeyAt(b, SHARING.mint),
    admin: pubkeyAt(b, SHARING.admin),
    adminRevoked: b[SHARING.adminRevoked] === 1,
    shareholders,
    bpsTotal,
  };
}

/**
 * SocialFeePda (pump_fees), 179 bytes. Offsets after user_id move with its length:
 *   0 disc | 8 bump | 9 version | 10 u32 len + utf8 user_id | platform u8 | total_claimed u64 |
 *   last_claimed u64 (unix s) | total_stable_claimed u64 | 120 reserved
 * dataSlice {0, 59} covers every field for user ids up to 20 characters.
 * @param {Uint8Array} b
 */
export function decodeSocialFeePda(b) {
  if (!isSocialFeePda(b)) throw new DecodeError('not a SocialFeePda (discriminator mismatch)');
  if (b.length < SOCIAL.userId + 4) throw new DecodeError('SocialFeePda too short');
  const dv = view(b);
  const len = dv.getUint32(SOCIAL.userId, true);
  if (len > SOCIAL.maxUserIdLen) throw new DecodeError(`SocialFeePda user_id length ${len} > 20`);
  const o = SOCIAL.userId + 4 + len;
  if (b.length < o + 17) throw new DecodeError('SocialFeePda truncated');
  const userId = new TextDecoder().decode(b.subarray(SOCIAL.userId + 4, o));
  return {
    bump: b[8],
    version: b[9],
    userId,
    platform: b[o],
    totalClaimed: u64(dv, o + 1),
    lastClaimed: u64(dv, o + 9),
    totalStableClaimed: b.length >= o + 25 ? u64(dv, o + 17) : null,
  };
}

/** pump BondingCurve: complete @48, creator @49. Returns null if the account is not a curve. */
export function decodeBondingCurve(b) {
  if (!hasDisc(b, DISC.BondingCurve) || b.length < CURVE.minLength) return null;
  return { complete: b[CURVE.complete] === 1, creator: pubkeyAt(b, CURVE.creator) };
}

/** SPL token account amount (u64 @64). Accepts a full account or a {offset: 64, length: 8} slice. */
export function tokenAmount(b) {
  if (b.length === 8) return u64(view(b), 0);
  if (b.length >= 72) return u64(view(b), 64);
  return 0;
}

/** Token or Token-2022 mint: owner is a token program and data is 82 bytes or has AccountType 1 at byte 165. */
export function isMintAccount(account) {
  if (!account) return false;
  if (account.owner !== TOKEN_PROGRAM && account.owner !== TOKEN_2022_PROGRAM) return false;
  const b = accountData(account.data);
  return b.length === 82 || (b.length > 165 && b[165] === 1);
}
