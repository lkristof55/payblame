import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBlame, formatLedger, fmtSol, LOGIN_MASK } from '../src/index.js';

const line = (o) => ({ mint: 'X', symbol: 'SAMPLE', slot: 0, shareholderCount: 1, bps: 10000, adminRevoked: true, pendingForRecipientLamports: 0, ...o });

// Synthetic sample recipient (placeholder login, synthetic id 9000900001 and its PDA, made-up amounts); the layout is the contract's Format A.
test('Format A: header, totals and coin lines, byte for byte', () => {
  const lines = formatBlame({
    recipient: { type: 'github', address: '3Hy8kZEexr8Y68raQkcS2RJAzCobyWBjzhGib9PaqL4i', login: 'sample-dev', userId: '9000900001', accountType: 'User' },
    account: { unclaimedLamports: 123456789012, totalClaimedLamports: 0, lastClaimedAt: null },
    totals: { coins: 12, listed: 12, truncated: false, pendingForRecipientLamports: 14000000000 },
    coins: [
      line({ mint: 'SampLeA1111111111111111111111111111111111111', pendingForRecipientLamports: 10546225068 }),
      line({ mint: 'SampLeB2222222222222222222222222222222222pump', adminRevoked: false, pendingForRecipientLamports: 2113420298 }),
    ],
  });
  assert.deepEqual(lines, [
    '# payblame github:sample-dev id=9000900001 type=User pda=3Hy8kZEe..PaqL4i',
    '# coins=12 listed=12 unclaimed=123.457 claimed=0.000 last-claim=never pending=14.000 SOL',
    'SampLeA1 (SAMPLE     10000bps 1/1 locked )     10.546 SOL pending',
    'SampLeB2 (SAMPLE     10000bps 1/1 MUTABLE)      2.113 SOL pending',
  ]);
});

test('Format A: wallet header, truncation marker, non-ASCII symbols', () => {
  const lines = formatBlame({
    recipient: { type: 'wallet', address: '27VDheZ7Y9cC8jp8NYE9PmMq7AFbBV1pJkBp33TsfUXn' },
    account: {},
    totals: { coins: 300, listed: 250, truncated: true, pendingForRecipientLamports: 0 },
    coins: [line({ mint: 'AAAAAAAAAAAA', symbol: '\u{1F415}DOG猫', slot: 1, shareholderCount: 2, bps: 50 })],
  });
  assert.equal(lines[0], '# payblame wallet:27VD..fUXn address=27VDheZ7Y9cC8jp8NYE9PmMq7AFbBV1pJkBp33TsfUXn');
  assert.equal(lines[1], '# coins=300 listed=250 (truncated) unclaimed=n/a claimed=n/a last-claim=n/a pending=0.000 SOL');
  assert.equal(lines[2], 'AAAAAAAA (?DOG?' + ' '.repeat(9) + '50bps 2/2 locked )      0.000 SOL pending');
  for (const l of lines) assert.match(l, /^[\x20-\x7e]*$/);
});

const L_HEAD = {
  snapshotAt: '2026-09-25T12:40:11.000Z',
  github: { accounts: 11455, unclaimedLamports: 17504188943493, totalClaimedLamports: 85863983567708, neverClaimed: 10289 },
};

test('Format L (revealed): key=value numbers, never a label before a number', () => {
  const lines = formatLedger({
    ...L_HEAD,
    logins: 'revealed',
    topUnclaimed: [
      { socialFeePda: 'D9PSA3zx7jatCiZxLePEWMrPwmzq6G2jtmpK2iGJaXNs', githubId: '9000900003', login: 'sample-org', accountType: 'Organization', unclaimedLamports: 1292371665766, totalClaimedLamports: 0, lastClaimedAt: null },
      { socialFeePda: 'BcZEva3YmZSJVCykJeYU95cGirA2QSL6GYEfEYAk9FZu', githubId: '9000900002', login: null, accountType: null, unclaimedLamports: 0, totalClaimedLamports: 20343867650683, lastClaimedAt: '2026-09-25T12:44:05.000Z' },
    ],
  });
  assert.deepEqual(lines, [
    '# payblame --ledger 2026-09-25T12:40Z github-recipients=11455',
    '# unclaimed=17504.189 claimed=85863.984 never-claimed=10289 (SOL)',
    'D9PSA3zx (github:sample-org            org ) unclaimed=1292.372  claimed=0.000     last=never',
    'BcZEva3Y (github:#9000900002           ?   ) unclaimed=0.000     claimed=20343.868 last=2026-09-25',
  ]);
  for (const l of lines.slice(2)) {
    assert.doesNotMatch(l, /(unclaimed|claimed|last) +[\d-n]/, 'no label followed by a space and a value');
    assert.doesNotMatch(l, /\d claimed/, 'no crop can read "<n> claimed"');
  }
  assert.equal(fmtSol(1), '0.000');
});

test('Format L (masked): mask, row id, logins=masked in line 1', () => {
  const lines = formatLedger({
    ...L_HEAD,
    logins: 'masked',
    topUnclaimed: [
      { socialFeePda: null, githubId: null, login: LOGIN_MASK, masked: true, rowId: 'row:0a1b2c3d', accountType: 'User', unclaimedLamports: 1869443295037, totalClaimedLamports: 0, lastClaimedAt: null },
    ],
  });
  assert.deepEqual(lines, [
    '# payblame --ledger 2026-09-25T12:40Z github-recipients=11455 logins=masked',
    '# unclaimed=17504.189 claimed=85863.984 never-claimed=10289 (SOL)',
    'row:0a1b2c3d (github:####                  user) unclaimed=1869.443  claimed=0.000     last=never',
  ]);
});
