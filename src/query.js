// The input grammar, checked in this order:
//   github:<login> | ghid:<digits> | x:<digits> | base58 address (32 bytes) | [@]<github login>
import { isAddress } from './base58.js';

export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const ID_RE = /^\d{1,20}$/;

/**
 * @param {string} raw
 * @returns {{kind:'github', login:string} | {kind:'ghid', id:string} | {kind:'x', id:string}
 *   | {kind:'address', address:string} | {kind:'invalid', reason:string}}
 */
export function parseQuery(raw) {
  const q = typeof raw === 'string' ? raw.trim() : '';
  if (q.length < 1 || q.length > 64) return { kind: 'invalid', reason: 'q must be 1-64 characters' };
  let m;
  if ((m = /^github:(.*)$/i.exec(q))) {
    return LOGIN_RE.test(m[1]) ? { kind: 'github', login: m[1] } : { kind: 'invalid', reason: 'not a valid GitHub login' };
  }
  if ((m = /^ghid:(.*)$/i.exec(q))) {
    return ID_RE.test(m[1]) ? { kind: 'ghid', id: String(BigInt(m[1])) } : { kind: 'invalid', reason: 'ghid must be 1-20 digits' };
  }
  if ((m = /^x:(.*)$/i.exec(q))) {
    return ID_RE.test(m[1]) ? { kind: 'x', id: String(BigInt(m[1])) } : { kind: 'invalid', reason: 'x id must be 1-20 digits' };
  }
  if (isAddress(q)) return { kind: 'address', address: q };
  const s = q.startsWith('@') ? q.slice(1) : q;
  if (LOGIN_RE.test(s)) return { kind: 'github', login: s };
  return { kind: 'invalid', reason: 'unrecognized input' };
}
