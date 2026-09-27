// GET /api/ledger: network-wide SocialFeePda ledger for the hero. Served from the store (written by
// ledger-cron every 15 min), with its age (ageSeconds). Logins are always masked here (login '####',
// githubId/socialFeePda null, rowId); /api/lookup reveals one on request.
// Netlify: computed on demand if missing or older than 60 min. Cloudflare Workers: a request never runs the
// scan (the CPU and subrequest limits are per invocation); it serves the last snapshot whatever its age, or a
// warmingUp answer until the cron has written the first one.
import { ledgerResponse, buildLedgerWith } from '../../lib/api.mjs';
import { libOptions, maskSecret, STORE } from '../../lib/sources.mjs';
import { getStore } from '../../lib/store.mjs';
import { onCloudflare } from '../../lib/platform.mjs';
import { sweepProgress } from '../../lib/sweep.mjs';

export default async () => {
  const store = await getStore(STORE);
  if (onCloudflare()) return ledgerResponse({ store, maskSecret, progress: () => sweepProgress(store) });
  // On demand: resolve at most 20 new GitHub logins so the request stays fast; the cron fills the rest.
  return ledgerResponse({ store, maskSecret, build: async () => buildLedgerWith(await libOptions(), 20) });
};

export const config = { path: '/api/ledger' };
