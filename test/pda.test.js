import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { socialFeePda, sharingConfigPda, bondingCurvePda, creatorVaultPdas, isOnCurve, decodeBase58, findProgramAddress } from '../src/index.js';

// The user ids are synthetic (9000000001+, the ids the fixtures give their three GitHub recipients, plus
// one whose bump is 253), so no real account is named. The expected SocialFeePdas were computed with an
// independent implementation, @solana/web3.js 1.99.0 PublicKey.findProgramAddressSync([ 'social-fee-pda',
// id, [2] ], pump_fees). The same findProgramAddress is checked against mainnet accounts in the next test.
test('socialFeePda matches @solana/web3.js findProgramAddressSync (synthetic ids)', () => {
  assert.equal(socialFeePda('9000006192', 2), 'B2DL2TJ4RoQpPsDBiFRrW9N68MzqDfxCFR1q3A5eZSVR');
  assert.equal(socialFeePda('9000008460', 2), '4XRUDNnXsAmHZvNXmmRiT3hZY2BhYPg8RFt3PbujpVpk');
  assert.equal(socialFeePda('9000010390', 2), 'CmydSRXRbC9TciRijENJU8CJFfdJv7KZm9fRfqYff5xd');
  assert.deepEqual(findProgramAddress(['social-fee-pda', '9000900003', Uint8Array.of(2)], 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'), ['D9PSA3zx7jatCiZxLePEWMrPwmzq6G2jtmpK2iGJaXNs', 253]);
});

// Every expected value below was read from mainnet (recorded 2026-09-25): coin accounts, not people.
test('sharing config, bonding curve and creator vaults match mainnet', () => {
  const mint = 'J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpump';
  const cfg = sharingConfigPda(mint);
  assert.equal(cfg, 'HNjQnXdLk1QY9Z9YR9G7QGrHb8jP39pNPXpurKxvcWhe');
  assert.equal(bondingCurvePda(mint), '77VKEmREHTjavVzWfEzD9irLUNfzyrnHXRUpVc6Uc78');
  const v = creatorVaultPdas(cfg);
  assert.equal(v.pumpVault, '7EZuYDkCnxiZMQbou8nXSrwKejErw17dtkuZcoMDzGQj');
  assert.equal(v.ammVaultAta, 'Cg9m5JbikNEUbRZtsD2yo9RWimJmx5WAFKhHzGCrVs3z');
  const t = creatorVaultPdas('A8e1KGJd9fR54BFbSUep6NYASXFSNGpvbV9vXQT3EiU4');
  assert.equal(t.pumpVault, 'BVJqo5mogU9FmGCm7NJaaUiZdfNLFvJQYygZijxV5gA3');
  assert.equal(t.ammVaultAta, 'BiUNGQHSidZJ2LCrJ7y3YURP66Du3UZH1rNnEFk864E7');
});

test('isOnCurve: wallets are on the curve, PDAs are not', () => {
  // system-owned wallet keys (ed25519 public keys) are on the curve
  assert.equal(isOnCurve(decodeBase58('svn5xpVGu81NZzQf9FdhSrB1HBdiu8oNBVKxWJKXo4R')), true);
  assert.equal(isOnCurve(decodeBase58('AXVSPBVcTQwMK9tmTdGSSPsMoJP2i7qcFTRfKRkdJWk3')), true);
  assert.equal(isOnCurve(decodeBase58('B2DL2TJ4RoQpPsDBiFRrW9N68MzqDfxCFR1q3A5eZSVR')), false);
  assert.equal(isOnCurve(decodeBase58('HNjQnXdLk1QY9Z9YR9G7QGrHb8jP39pNPXpurKxvcWhe')), false);
});

// The reference: the square-root form of curve25519-dalek's decompress (x = u v^3 (u v^7)^((p-5)/8),
// then check v x^2 = +-u), which isOnCurve used before it switched to one Jacobi symbol.
function isOnCurveBySqrt(bytes) {
  const P = 2n ** 255n - 19n;
  const mod = (a) => ((a % P) + P) % P;
  const pow = (b, e) => { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; };
  const D = mod(-121665n * pow(121666n, P - 2n));
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y = mod(y);
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  if (u === 0n) return true;
  const v3 = (v * v % P) * v % P;
  const x = (u * v3 % P) * pow(u * ((v3 * v3 % P) * v % P) % P, (P - 5n) / 8n) % P;
  const vx2 = v * (x * x % P) % P;
  return vx2 === u || vx2 === mod(-u);
}

test('isOnCurve agrees with the square-root form of the check on 5,000 inputs and the edge cases', () => {
  const edge = [
    new Uint8Array(32),                                          // y = 0
    Uint8Array.from([1, ...Array(31).fill(0)]),                  // y = 1: u = 0
    Uint8Array.from([0xec, ...Array(30).fill(0xff), 0x7f]),      // y = p - 1
    Uint8Array.from([0xed, ...Array(30).fill(0xff), 0x7f]),      // y = p (non-canonical, reduces to 0)
    Uint8Array.from([0xee, ...Array(30).fill(0xff), 0xff]),      // y = p + 1 with the sign bit set
    Uint8Array.from({ length: 32 }, () => 0xff),
  ];
  for (const b of edge) assert.equal(isOnCurve(b), isOnCurveBySqrt(b), Buffer.from(b).toString('hex'));
  let on = 0;
  for (let i = 0; i < 5000; i++) {
    const b = new Uint8Array(createHash('sha256').update(`payblame curve check ${i}`).digest());
    const want = isOnCurveBySqrt(b);
    assert.equal(isOnCurve(b), want, Buffer.from(b).toString('hex'));
    if (want) on++;
  }
  assert.ok(on > 2200 && on < 2800, `about half of all hashes are on the curve (${on})`);
});

test('findProgramAddress rejects seeds over 32 bytes', () => {
  assert.throws(() => findProgramAddress(['x'.repeat(33)], '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), /longer than 32/);
});
