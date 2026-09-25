// Synthetic accounts for edge-case tests (clearly not mainnet data).
import { decodeBase58, encodeBase58 } from '../../src/base58.js';
import { DISC } from '../../src/constants.js';
import { createHash } from 'node:crypto';

export const fakeKey = (seed) => encodeBase58(createHash('sha256').update(String(seed)).digest());

export function encodeSharingConfig({ mint, admin, adminRevoked = true, version = 2, status = 1, shareholders }) {
  const b = new Uint8Array(1024);
  b.set(DISC.SharingConfig, 0);
  b[8] = 255; b[9] = version; b[10] = status;
  b.set(decodeBase58(mint), 11);
  b.set(decodeBase58(admin), 43);
  b[75] = adminRevoked ? 1 : 0;
  const dv = new DataView(b.buffer);
  dv.setUint32(76, shareholders.length, true);
  shareholders.forEach(([addr, bps], k) => { b.set(decodeBase58(addr), 80 + 34 * k); dv.setUint16(80 + 34 * k + 32, bps, true); });
  return b;
}

export function encodeSocialFeePda({ userId, platform = 2, totalClaimed = 0, lastClaimed = 0 }) {
  const b = new Uint8Array(179);
  b.set(DISC.SocialFeePda, 0);
  b[8] = 254; b[9] = 1;
  const dv = new DataView(b.buffer);
  const id = new TextEncoder().encode(userId);
  dv.setUint32(10, id.length, true);
  b.set(id, 14);
  const o = 14 + id.length;
  b[o] = platform;
  dv.setBigUint64(o + 1, BigInt(totalClaimed), true);
  dv.setBigUint64(o + 9, BigInt(lastClaimed), true);
  return b;
}

export const b64 = (bytes) => [Buffer.from(bytes).toString('base64'), 'base64'];
