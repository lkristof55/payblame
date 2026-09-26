import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery } from '../src/index.js';

test('parseQuery grammar, in contract order', () => {
  assert.deepEqual(parseQuery('sample-dev'), { kind: 'github', login: 'sample-dev' });
  assert.deepEqual(parseQuery('  @Sample-Org '), { kind: 'github', login: 'Sample-Org' });
  assert.deepEqual(parseQuery('github:sample-dev'), { kind: 'github', login: 'sample-dev' });
  assert.deepEqual(parseQuery('ghid:9000900001'), { kind: 'ghid', id: '9000900001' });
  assert.deepEqual(parseQuery('x:9000900004'), { kind: 'x', id: '9000900004' });
  assert.deepEqual(parseQuery('J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpump'), { kind: 'address', address: 'J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpump' });
});

test('parseQuery rejects malformed input', () => {
  for (const q of ['', '   ', 'x'.repeat(65), 'github:-bad', 'github:bad--login', 'ghid:12a', 'x:', 'x:123456789012345678901', '@@double', 'has space', 'emoji\u{1F600}', 'a'.repeat(40), 'J141JCiXKGcrhDCgWUTCL9qz7h943iCibNiLNfqZpum0', null, undefined, 42]) {
    assert.equal(parseQuery(q).kind, 'invalid', `expected invalid: ${String(q)}`);
  }
});

test('a 32-44 char string that does not decode to 32 bytes is not an address', () => {
  // 44 z's decode to 33 bytes; it is also not a valid login (too long) -> invalid
  assert.equal(parseQuery('z'.repeat(44)).kind, 'invalid');
  // 32 chars of base58 that decode to fewer than 32 bytes and are a valid login -> github
  assert.deepEqual(parseQuery('abcdefghijkmnopqrstuvwxyzABCDEFG'), { kind: 'github', login: 'abcdefghijkmnopqrstuvwxyzABCDEFG' });
});
