// Scheduled every 15 min: the SocialFeePda ledger -> store 'payblame' key 'ledger/latest' (masked).
// Netlify, Workers Paid (CF_FREE_PLAN=0): one getProgramAccounts over all SocialFeePda accounts per run,
// about 11 Helius credits (1 gPA + 1 rent call), up to 50 new GitHub id lookups.
// Workers Free: one getProgramAccountsV2 page per run (LEDGER_PAGE_SIZE, default 3000) folded into a running
// aggregate; the run that reads the last page publishes the snapshot (lib/sweep.mjs); up to 10 GitHub lookups.
import { buildLedgerWith, LEDGER_KEY } from '../../lib/api.mjs';
import { libOptions, STORE } from '../../lib/sources.mjs';
import { getStore } from '../../lib/store.mjs';
import { budgets } from '../../lib/platform.mjs';
import { sweepStep } from '../../lib/sweep.mjs';

const redact = (m) => String(m).replace(/api-key=[^&\s]+/g, 'api-key=***');

export default async () => {
  const t = Date.now();
  try {
    const b = budgets();
    if (b.ledgerPageSize > 0) {
      const r = await sweepStep({ store: await getStore(STORE), opts: await libOptions({ timeoutMs: 20000 }), pageSize: b.ledgerPageSize, githubPerRun: b.githubPerRun });
      console.log(`[ledger-cron] page ${r.page}: ${r.accounts} accounts (${r.scanned} this sweep)${r.done ? ', sweep complete' : ''}${r.published ? ', published' : ''}, github ${r.githubKnown}/${r.githubRows} known (+${r.githubAdded}), ${Date.now() - t} ms`);
      return new Response('ok');
    }
    const ledger = await buildLedgerWith(await libOptions({ timeoutMs: 20000 }), b.githubPerRun);
    await (await getStore(STORE)).setJSON(LEDGER_KEY, ledger);
    console.log(`[ledger-cron] ${ledger.accounts.total} accounts, github=${ledger.github.accounts}, ${Date.now() - t} ms`);
    return new Response('ok');
  } catch (e) {
    console.error(`[ledger-cron] failed: ${e.code || e.name}: ${redact(e.message)}`);
    return new Response('failed', { status: 502 });
  }
};

export const config = { schedule: '*/15 * * * *' };
