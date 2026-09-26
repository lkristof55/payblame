// End-to-end lookups replayed from recorded mainnet traffic (test/record.js). No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { lookup, clearRentCache, PayblameError } from '../src/index.js';
import { readGz, replayFetch, seededCache } from './helpers/transcript.js';

const dir = new URL('./fixtures/', import.meta.url);
const load = (name) => readGz(new URL(`${name}.json.gz`, dir));
async function replay(name) {
  const fx = load(name);
  clearRentCache();
  const f = replayFetch(fx.transcript);
  try {
    return { fx, f, result: await lookup(fx.q, { rpcUrl: 'http://replay.invalid', fetch: f, cache: seededCache(fx.cacheSeed), limit: fx.limit }) };
  } catch (error) { return { fx, f, error }; }
}

test('every recorded scenario replays to the recorded output', async () => {
  const names = readdirSync(dir).filter((n) => n.endsWith('.json.gz') && !n.startsWith('ledger')).map((n) => n.slice(0, -8));
  assert.ok(names.length >= 7);
  for (const name of names) {
    const { fx, result, error } = await replay(name);
    if (fx.expect.error) {
      assert.ok(error instanceof PayblameError, name);
      assert.equal(error.code, fx.expect.error.code, name);
    } else {
      assert.ifError(error);
      assert.deepEqual(result.blame, fx.expect.blame, name);
      if (fx.expect.diff) assert.deepEqual(result.diff, fx.expect.diff, name);
    }
  }
});

test('recipient with 89 coins: 10 probes, exact totals, sorted lines, pending = vault math', async () => {
  const { result: r } = await replay('recipient-89-coins');
  assert.equal(r.kind, 'recipient');
  assert.equal(r.recipient.type, 'github');
  assert.equal(r.recipient.address, 'B2DL2TJ4RoQpPsDBiFRrW9N68MzqDfxCFR1q3A5eZSVR'); // PDA of the recipient's synthetic id
  assert.equal(r.probeHits.length, 10);
  assert.equal(r.totals.coins, r.probeHits.reduce((a, b) => a + b, 0));
  assert.equal(r.totals.listed, r.coins.length);
  assert.equal(r.totals.truncated, false);
  assert.equal(r.account.everClaimed, false);
  assert.equal(r.account.lastClaimedAt, null);
  assert.ok(r.account.unclaimedLamports > 600e9);
  for (let i = 1; i < r.coins.length; i++) assert.ok(r.coins[i - 1].pendingForRecipientLamports >= r.coins[i].pendingForRecipientLamports);
  for (const c of r.coins) {
    assert.equal(c.pendingForRecipientLamports, Math.floor((c.pendingLamports * c.bps) / 10000));
    assert.equal(c.coRecipients.length, c.shareholderCount - 1);
  }
  assert.equal(r.totals.mutable, r.coins.filter((c) => !c.adminRevoked).length);
  assert.equal(r.meta.rpcCalls, 17); // 10 probes + account + rent(0) + rent(179) + 1 config batch + 2 vault batches + DAS
});

test('coin that names an X handle but pays a GitHub account on-chain -> mismatch diff', async () => {
  const { result: c } = await replay('coin-declared-mismatch');
  assert.equal(c.kind, 'coin');
  assert.equal(c.feeSharing, true);
  assert.equal(c.sharingConfig, 'HNjQnXdLk1QY9Z9YR9G7QGrHb8jP39pNPXpurKxvcWhe');
  assert.equal(c.config.shareholders.length, 1);
  assert.equal(c.config.shareholders[0].kind, 'github');
  const [only] = c.config.shareholders;
  assert.match(only.login, /^[A-Za-z0-9-]+$/);
  assert.equal(c.mismatch, true);
  assert.ok(c.declared.some((d) => d.platform === 'x' && d.status === 'absent'));
  assert.ok(c.diff.some((l) => /^- x:@\w+$/.test(l)));
  assert.ok(c.diff.includes(`+ github:${only.login} 10000bps`));
  assert.equal(c.curve.creator, c.sharingConfig);
});

test('coin with two GitHub shareholders: each with its own claim record', async () => {
  const { result: c } = await replay('coin-two-github');
  const [a, b] = c.config.shareholders;
  assert.ok(a.kind === 'github' && b.kind === 'github' && a.login && b.login && a.login !== b.login);
  assert.equal(a.everClaimed, false);
  assert.equal(b.everClaimed, true);
  assert.equal(a.bps + b.bps, 10000);
  assert.equal(a.pendingForShareholderLamports, Math.floor(c.vaults.pendingLamports / 2));
});

test('legacy coin and brand-new mint: no SharingConfig, creator wallet is paid directly', async () => {
  for (const name of ['coin-legacy', 'coin-new']) {
    const { result: c } = await replay(name);
    assert.equal(c.feeSharing, false, name);
    assert.equal(c.config, null, name);
    assert.ok(c.curve.exists, name);
    assert.match(c.blame[0], /no SharingConfig: legacy creator$/, name);
    assert.match(c.blame[1], /paid directly on collect$/, name);
  }
});

test('empty wallet: zero coins, wallet shape, no social fields', async () => {
  const { result: r } = await replay('wallet-empty');
  assert.equal(r.recipient.type, 'wallet');
  assert.equal(r.recipient.platform, null);
  assert.deepEqual(r.totals, { coins: 0, listed: 0, truncated: false, mutable: 0, pendingForRecipientLamports: 0 });
  assert.equal(r.account.exists, false);
  assert.equal(r.account.unclaimedLamports, null);
  assert.deepEqual(r.coins, []);
});

test('USDC is a mint but not a pump.fun coin -> NOT_PUMP (404)', async () => {
  const { error } = await replay('not-pump-usdc');
  assert.equal(error.code, 'NOT_PUMP');
  assert.equal(error.status, 404);
});

test('malformed input never reaches the network', async () => {
  const f = async () => { throw new Error('network used'); };
  for (const q of ['', 'not a login!', 'ghid:abc', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1O']) {
    await assert.rejects(lookup(q, { rpcUrl: 'http://x.invalid', fetch: f }), (e) => e.code === 'BAD_INPUT' && e.status === 400);
  }
  await assert.rejects(lookup('11111111111111111111111111111111', { rpcUrl: 'http://x.invalid', fetch: f }), (e) => e.code === 'BAD_INPUT');
});
