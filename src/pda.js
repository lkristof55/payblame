// Program-derived addresses, with no @solana/web3.js: sha256 from node:crypto and a BigInt
// ed25519 decompression check (a PDA must be a point that is NOT on the curve).
import { createHash } from 'node:crypto';
import { decodeBase58, encodeBase58 } from './base58.js';
import { PUMP_FEES, PUMP, PUMP_AMM, ATA_PROGRAM, TOKEN_PROGRAM, WSOL_MINT } from './constants.js';

const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P + P; // ed25519 d, positive representative
const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');

function mod(a) { const r = a % P; return r < 0n ? r + P : r; }
function modPow(b, e) {
  let r = 1n; b = mod(b);
  while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
  return r;
}
function modInv(a) { return modPow(a, P - 2n); }

/**
 * Jacobi symbol (a/n) for odd n > 0, by quadratic reciprocity (a few hundred shifts and small
 * reductions instead of a 252-bit modular exponentiation). For a prime n it is the Legendre symbol:
 * 1 when a is a nonzero square mod n, -1 when it is not, 0 when n divides a.
 */
function jacobi(a, n) {
  let t = 1;
  while (a !== 0n) {
    while ((a & 1n) === 0n) {
      a >>= 1n;
      const r = n & 7n;
      if (r === 3n || r === 5n) t = -t;
    }
    const s = a; a = n; n = s;
    if ((a & 3n) === 3n && (n & 3n) === 3n) t = -t;
    a %= n;
  }
  return n === 1n ? t : 0;
}

/**
 * True when the 32 bytes decompress to a point on ed25519. Mirrors curve25519-dalek's
 * CompressedEdwardsY::decompress, which Solana uses: y is read little-endian with the sign bit
 * cleared and reduced mod p, and the point exists iff (y^2 - 1) / (d*y^2 + 1) is a square
 * (the sign bit only picks which root). v = d*y^2 + 1 is never 0 (-1/d is not a square), so
 * u/v is a square iff u = 0 or u*v is a nonzero square: one Jacobi symbol, no square root.
 * @param {Uint8Array} bytes
 */
export function isOnCurve(bytes) {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y = mod(y);
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  if (u === 0n) return true;
  return jacobi((u * v) % P, P) === 1;
}

const keyCache = new Map();
function key(b58) {
  let k = keyCache.get(b58);
  if (!k) { k = decodeBase58(b58); if (k.length !== 32) throw new Error(`not a 32-byte address: ${b58}`); keyCache.set(b58, k); }
  return k;
}
const utf8 = (s) => new TextEncoder().encode(s);

/**
 * Solana findProgramAddress: the first bump from 255 down whose hash is off the curve.
 * @param {(Uint8Array|string)[]} seeds  strings are UTF-8 seeds; use key() bytes for pubkeys
 * @param {string} programId base58
 * @returns {[string, number]} [address base58, bump]
 */
export function findProgramAddress(seeds, programId) {
  const parts = seeds.map((s) => (typeof s === 'string' ? utf8(s) : s));
  for (const p of parts) if (p.length > 32) throw new Error('seed longer than 32 bytes');
  const program = key(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const p of parts) h.update(p);
    h.update(Uint8Array.of(bump)); h.update(program); h.update(PDA_MARKER);
    const digest = new Uint8Array(h.digest());
    if (!isOnCurve(digest)) return [encodeBase58(digest), bump];
  }
  throw new Error('no viable bump');
}

/** SocialFeePda for a platform user id: PDA(['social-fee-pda', utf8(userId), u8 platform], pump_fees). */
export function socialFeePda(userId, platform = 2) {
  return findProgramAddress(['social-fee-pda', String(userId), Uint8Array.of(platform)], PUMP_FEES)[0];
}
/** SharingConfig of a mint: PDA(['sharing-config', mint], pump_fees). */
export function sharingConfigPda(mint) {
  return findProgramAddress(['sharing-config', key(mint)], PUMP_FEES)[0];
}
/** pump bonding curve of a mint: PDA(['bonding-curve', mint], pump). */
export function bondingCurvePda(mint) {
  return findProgramAddress(['bonding-curve', key(mint)], PUMP)[0];
}
/** Associated token account: PDA([owner, tokenProgram, mint], ATA program). */
export function associatedTokenAddress(owner, mint, tokenProgram = TOKEN_PROGRAM) {
  return findProgramAddress([key(owner), key(tokenProgram), key(mint)], ATA_PROGRAM)[0];
}
/**
 * The two places a coin's creator fees accumulate, for a creator (a SharingConfig for fee-shared
 * coins, else the creator wallet):
 *  - pumpVault: PDA(['creator-vault', creator], pump), holds lamports while the coin is on the curve;
 *  - ammVaultAuthority: PDA(['creator_vault', creator], pump_amm), and ammVaultAta, its WSOL
 *    associated token account, which collects PumpSwap fees after graduation.
 */
export function creatorVaultPdas(creator) {
  const pumpVault = findProgramAddress(['creator-vault', key(creator)], PUMP)[0];
  const ammVaultAuthority = findProgramAddress(['creator_vault', key(creator)], PUMP_AMM)[0];
  const ammVaultAta = associatedTokenAddress(ammVaultAuthority, WSOL_MINT, TOKEN_PROGRAM);
  return { pumpVault, ammVaultAuthority, ammVaultAta };
}

export { key as addressBytes };
