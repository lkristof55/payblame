// GET /api/lookup?q=<login|github:login|ghid:id|x:id|wallet|mint>&limit=1..250&mask=1
// mask=1: logins, handles, social ids and SocialFeePda addresses masked server-side (auto-run feeds).
// Recipient blame (every coin that pays q) or coin blame (who a mint pays), from chain state.
// On the Cloudflare Workers Free plan a recipient lists at most LOOKUP_MAX_LIMIT coins (default 20; meta.limitCap).
import { lookupResponse } from '../../lib/api.mjs';
import { libOptions } from '../../lib/sources.mjs';
import { budgets } from '../../lib/platform.mjs';

export default async (req) => {
  if (req.method !== 'GET') return Response.json({ error: 'GET only', code: 'BAD_INPUT' }, { status: 405 });
  return lookupResponse(new URL(req.url), { options: () => libOptions(), maxLimit: budgets().lookupMaxLimit });
};

export const config = { path: '/api/lookup' };
