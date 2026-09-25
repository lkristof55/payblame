import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeSharingConfig, decodeSocialFeePda, decodeBondingCurve, tokenAmount, isMintAccount, accountData, DecodeError, encodeBase58, decodeBase58, isAddress } from '../src/index.js';
import { encodeSharingConfig, encodeSocialFeePda, fakeKey } from './helpers/synth.js';

const raw = JSON.parse(readFileSync(new URL('./fixtures/raw-accounts.json', import.meta.url)));

test('decodeSharingConfig: recorded mainnet account', () => {
  const c = decodeSharingConfig(accountData(raw.sharingConfig.dataBase64First420));
  const e = raw.sharingConfig.expect;
  assert.equal(c.mint, e.mint);
  assert.equal(c.admin, e.admin);
  assert.equal(c.adminRevoked, e.adminRevoked);
  assert.equal(c.version, e.version);
  assert.equal(c.status, 'active');
  assert.deepEqual(c.shareholders.map((s) => [s.address, s.bps]), e.shareholders);
  assert.equal(c.bpsTotal, 10000);
});

test('decodeSocialFeePda: recorded mainnet account', () => {
  const d = decodeSocialFeePda(accountData(raw.socialFeePda.dataBase64));
  assert.equal(d.userId, '127238744');
  assert.equal(d.platform, 2);
  assert.equal(d.totalClaimed, 0);
  assert.equal(d.lastClaimed, 0);
  assert.equal(raw.socialFeePda.lamports - 1559560, raw.socialFeePda.expect.unclaimedLamports);
});

test('decodeSocialFeePda works on the 59-byte slice for a 20-char user id', () => {
  const b = encodeSocialFeePda({ userId: '18446744073709551615', platform: 1, totalClaimed: 5e12, lastClaimed: 1790340245 });
  const d = decodeSocialFeePda(b.subarray(0, 59));
  assert.equal(d.userId, '18446744073709551615');
  assert.equal(d.platform, 1);
  assert.equal(d.totalClaimed, 5e12);
  assert.equal(d.lastClaimed, 1790340245);
});

test('decoders reject wrong discriminators, oversize vecs and truncation', () => {
  const sc = accountData(raw.sharingConfig.dataBase64First420);
  assert.throws(() => decodeSocialFeePda(sc), DecodeError);
  assert.throws(() => decodeSharingConfig(accountData(raw.socialFeePda.dataBase64)), DecodeError);
  assert.throws(() => decodeSharingConfig(sc.subarray(0, 100)), /truncated/);
  const bad = encodeSharingConfig({ mint: fakeKey(1), admin: fakeKey(2), shareholders: [[fakeKey(3), 10000]] });
  new DataView(bad.buffer).setUint32(76, 11, true);
  assert.throws(() => decodeSharingConfig(bad), /max 10/);
  assert.throws(() => decodeSharingConfig(new Uint8Array(0)), DecodeError);
});

test('decodeSharingConfig: ten shareholders, MUTABLE, paused, unknown version flagged', () => {
  const holders = Array.from({ length: 10 }, (_, i) => [fakeKey(`h${i}`), 1000]);
  const c = decodeSharingConfig(encodeSharingConfig({ mint: fakeKey('m'), admin: fakeKey('a'), adminRevoked: false, status: 0, version: 7, shareholders: holders }));
  assert.equal(c.shareholders.length, 10);
  assert.equal(c.shareholders[9].address, holders[9][0]);
  assert.equal(c.adminRevoked, false);
  assert.equal(c.status, 'paused');
  assert.equal(c.versionRecognized, false);
});

test('bonding curve, token amount and mint detection', () => {
  const curve = new Uint8Array(150);
  curve.set([23, 183, 248, 55, 96, 216, 172, 96]);
  curve[48] = 1;
  curve.set(decodeBase58(fakeKey('creator')), 49);
  assert.deepEqual(decodeBondingCurve(curve), { complete: true, creator: fakeKey('creator') });
  assert.equal(decodeBondingCurve(new Uint8Array(150)), null);
  const ata = new Uint8Array(165);
  new DataView(ata.buffer).setBigUint64(64, 31133220n, true);
  assert.equal(tokenAmount(ata), 31133220);
  assert.equal(tokenAmount(ata.subarray(64, 72)), 31133220);
  assert.equal(tokenAmount(new Uint8Array(0)), 0);
  const tok = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  assert.equal(isMintAccount({ owner: tok, data: [Buffer.alloc(82).toString('base64'), 'base64'] }), true);
  assert.equal(isMintAccount({ owner: tok, data: [Buffer.alloc(165).toString('base64'), 'base64'] }), false);
  const t22 = Buffer.alloc(200); t22[165] = 1;
  assert.equal(isMintAccount({ owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', data: [t22.toString('base64'), 'base64'] }), true);
  assert.equal(isMintAccount(null), false);
});

test('base58 round trip and address validation', () => {
  for (const s of ['3x8HHmCKSrWPiHeM3FgeLWVPsdPrsdrmmQQzA5NmhosX', '11111111111111111111111111111111', 'So11111111111111111111111111111111111111112']) {
    assert.equal(encodeBase58(decodeBase58(s)), s);
    assert.equal(isAddress(s), true);
  }
  assert.equal(isAddress('3x8HHmCKSrWPiHeM3FgeLWVPsdPrsdrmmQQzA5Nmhos0'), false); // '0' not in alphabet
  assert.equal(isAddress('3x8HHmCKSrWPiHeM3FgeLWVPsdPrsdrmmQQzA5NmhosXX'), false); // 45 chars
  assert.equal(isAddress('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'), false); // 44 chars, decodes to 33 bytes
  assert.throws(() => decodeBase58('abc0'), /invalid base58/);
});
