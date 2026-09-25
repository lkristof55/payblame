import test from 'node:test';
import assert from 'node:assert/strict';
import { socialFeePda, sharingConfigPda, bondingCurvePda, creatorVaultPdas, isOnCurve, decodeBase58, findProgramAddress } from '../src/index.js';

// Every expected value below was read from mainnet (recorded 2026-09-25).
// The ids are three GitHub fee recipients whose SocialFeePda accounts exist on mainnet; the test is about the PDA math, not who they are.
test('socialFeePda matches mainnet accounts', () => {
  assert.equal(socialFeePda('127238744', 2), '3x8HHmCKSrWPiHeM3FgeLWVPsdPrsdrmmQQzA5NmhosX');
  assert.equal(socialFeePda('322216527', 2), 'FfLpuH4WPn2MR8Lqn1MpwQc1HtAPPqL3qvMWZjnFHGpv');
  assert.equal(socialFeePda('275368270', 2), 'E8gBTZqNiG7Nqkh7vT28oF2TAZfkk7QG1HTmpdUiNvMt');
});

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
  assert.equal(isOnCurve(decodeBase58('3x8HHmCKSrWPiHeM3FgeLWVPsdPrsdrmmQQzA5NmhosX')), false);
  assert.equal(isOnCurve(decodeBase58('HNjQnXdLk1QY9Z9YR9G7QGrHb8jP39pNPXpurKxvcWhe')), false);
});

test('findProgramAddress rejects seeds over 32 bytes', () => {
  assert.throws(() => findProgramAddress(['x'.repeat(33)], '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), /longer than 32/);
});
