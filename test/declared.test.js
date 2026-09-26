import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDeclared, diffDeclared } from '../src/index.js';

test('extractDeclared: @handles, x.com, twitter.com, github.com; ignores emails and dupes', () => {
  const d = extractDeclared({
    name: 'Sample Coin',
    symbol: 'sample_handle',
    description: 'Fees to @Sample_Handle via some-platform. see https://x.com/sample_handle and twitter.com/other_one, code at github.com/sample-org/sample. mail dev@example.com',
  });
  const handles = d.map((x) => `${x.platform}:${x.handle.toLowerCase()}`).sort();
  assert.deepEqual(handles, ['github:sample-org', 'x:other_one', 'x:sample_handle']);
  assert.ok(!handles.includes('x:example'));
  assert.deepEqual(extractDeclared({}), []);
  assert.deepEqual(extractDeclared({ description: null }), []);
});

test('diffDeclared: declared x handle, but 100% on-chain to a GitHub account', () => {
  const declared = extractDeclared({ description: 'Fees to @sample_handle via some-platform' });
  const holders = [{ address: 'C'.repeat(32), bps: 10000, kind: 'github', login: 'sample-platform', userId: '9000900002' }];
  const r = diffDeclared(declared, holders);
  assert.equal(r.mismatch, true);
  assert.deepEqual(r.diff, ['--- declared (name/symbol/description)', '+++ on-chain (SharingConfig)', '- x:@sample_handle', '+ github:sample-platform 10000bps']);
  assert.equal(r.declared[0].status, 'absent');
});

test('diffDeclared: match, unverifiable, and nothing declared', () => {
  const holders = [
    { address: 'A'.repeat(32), bps: 6000, kind: 'github', login: 'Sample-Dev', userId: '9000900001' },
    { address: 'B'.repeat(32), bps: 4000, kind: 'x', login: null, userId: '9000900004' },
  ];
  const r = diffDeclared(extractDeclared({ description: 'github.com/sample-dev and @someone' }), holders);
  assert.equal(r.mismatch, false);
  assert.deepEqual(r.declared.map((d) => d.status), ['match', 'unverifiable']);
  assert.deepEqual(r.diff.slice(2), ['  github:@sample-dev', '~ x:@someone (x ids are numeric on-chain)', '+ x:#9000900004 4000bps']);
  assert.deepEqual(diffDeclared([], holders), { declared: [], mismatch: false, diff: [] });
});
