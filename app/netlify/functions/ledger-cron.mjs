// Scheduled every 15 min: one getProgramAccounts over all SocialFeePda accounts -> Blobs 'payblame'
// key 'ledger/latest'. About 11 Helius credits per run (1 gPA + 1 rent call).
import { buildLedgerWith, LEDGER_KEY } from '../../lib/api.mjs';
import { libOptions, STORE } from '../../lib/sources.mjs';
import { getStore } from '../../lib/store.mjs';

export default async () => {
  const t = Date.now();
  try {
    const ledger = await buildLedgerWith(await libOptions({ timeoutMs: 20000 }), 50);
    await (await getStore(STORE)).setJSON(LEDGER_KEY, ledger);
    console.log(`[ledger-cron] ${ledger.accounts.total} accounts, github=${ledger.github.accounts}, ${Date.now() - t} ms`);
    return new Response('ok');
  } catch (e) {
    console.error(`[ledger-cron] failed: ${e.code || e.name}: ${String(e.message).replace(/api-key=[^&\s]+/g, 'api-key=***')}`);
    return new Response('failed', { status: 502 });
  }
};

export const config = { schedule: '*/15 * * * *' };
