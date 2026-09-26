// GET /api/lookup?q=<login|github:login|ghid:id|x:id|wallet|mint>&limit=1..250&mask=1
// mask=1: logins, handles, social ids and SocialFeePda addresses masked server-side (auto-run feeds).
// Recipient blame (every coin that pays q) or coin blame (who a mint pays), from chain state.
import { lookupResponse } from '../../lib/api.mjs';
import { libOptions } from '../../lib/sources.mjs';

export default async (req) => {
  if (req.method !== 'GET') return Response.json({ error: 'GET only', code: 'BAD_INPUT' }, { status: 405 });
  return lookupResponse(new URL(req.url), { options: () => libOptions() });
};

export const config = { path: '/api/lookup' };
