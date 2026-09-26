// GET /api/ledger: network-wide SocialFeePda ledger for the hero. Served from Blobs (written by
// ledger-cron every 15 min); computed on demand if missing or older than 60 min. Logins are always
// masked here (login '####', githubId/socialFeePda null, rowId); /api/lookup reveals one on request.
import { ledgerResponse, buildLedgerWith } from '../../lib/api.mjs';
import { libOptions, maskSecret, STORE } from '../../lib/sources.mjs';
import { getStore } from '../../lib/store.mjs';

export default async () => {
  const store = await getStore(STORE);
  // On demand: resolve at most 20 new GitHub logins so the request stays fast; the cron fills the rest.
  return ledgerResponse({ store, maskSecret, build: async () => buildLedgerWith(await libOptions(), 20) });
};

export const config = { path: '/api/ledger' };
