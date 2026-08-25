/**
 * The B13 practice-account probe: prove `create_campaign` against Meta without
 * creating anything.
 *
 * Two things are printed, because they answer different questions:
 *
 *  1. Meta's OWN validation answer for the exact campaign body the executor
 *     would send (`execution_options=["validate_only"]`). This is what tells us
 *     the objective, the buying type, the special-ad-categories shape and the
 *     CBO budget are acceptable — a rail that refuses first would hide it.
 *  2. The executor's verdict for the same intent with `dry_run: true`, which
 *     runs every rail (write mode, budget ceiling, fence bootstrap) and stops
 *     at the same point.
 *
 * PRE-FLIGHT, always, per the standing rule for this account: every campaign
 * off and no spend in the last 7 days. If either fails the probe REPORTS and
 * SKIPS rather than working in an account somebody is using.
 *
 * The only account this may ever touch is the practice account below. Nothing
 * here writes: there is no code path in this file that omits validate_only or
 * that sets dry_run false.
 *
 * Run: cd /root/dai && set -a && source .env && set +a \
 *      && node_modules/.bin/tsx scripts/_b13-practice-dryrun.mts
 */

// Import-safe: ada-console-assist binds port 8092 unless this is set, and the
// live service already holds it. Same escape hatch the test runner uses.
process.env.VITEST = '1';

const PRACTICE_ACCOUNT = 'act_1570076840279279';
const PRACTICE_CLIENT_CODE = 'AOTUS';
const GRAPH = 'https://graph.facebook.com/v21.0';

const { handleExecuteAction } = await import('./ada-console-assist.js');
const { envTokenFor } = await import('../src/integrations/meta-token.js');

const token = envTokenFor(PRACTICE_CLIENT_CODE);
if (!token) {
  console.error('no Meta token on this rail — nothing probed');
  process.exit(1);
}

async function graph(path: string, params: Record<string, string>, method: 'GET' | 'POST' = 'GET') {
  const qs = new URLSearchParams({ ...params, access_token: token as string });
  const url = method === 'GET' ? `${GRAPH}/${path}?${qs}` : `${GRAPH}/${path}`;
  const res = await fetch(url, method === 'GET' ? {} : { method: 'POST', body: qs });
  return (await res.json()) as Record<string, unknown>;
}

// ---------------------------------------------------------------- pre-flight
const campaigns = await graph(`${PRACTICE_ACCOUNT}/campaigns`, {
  fields: 'id,effective_status',
  limit: '200',
});
if (campaigns.error) {
  console.error('PRE-FLIGHT FAILED — could not read campaigns:', JSON.stringify(campaigns.error));
  process.exit(1);
}
const rows = (campaigns.data as Array<{ id: string; effective_status?: string }> | undefined) ?? [];
const live = rows.filter((c) => c.effective_status !== 'PAUSED' && c.effective_status !== 'ARCHIVED');
console.log(`campaigns: ${rows.length} total, ${live.length} not paused`);
if (live.length > 0) {
  console.log('SKIPPED — these campaigns are not paused:', live.map((c) => `${c.id}=${c.effective_status}`).join(', '));
  process.exit(0);
}

const insights = await graph(`${PRACTICE_ACCOUNT}/insights`, { fields: 'spend', date_preset: 'last_7d' });
const spendRows = (insights.data as Array<{ spend?: string }> | undefined) ?? [];
const spend7d = spendRows.reduce((sum, r) => sum + (Number(r.spend ?? 0) || 0), 0);
console.log(`7-day spend: $${spend7d.toFixed(2)}`);
if (spend7d > 0) {
  console.log('SKIPPED — the practice account has spent in the last 7 days.');
  process.exit(0);
}

// ------------------------------------------------- 1. Meta's own validation
const SETTINGS = {
  name: `ADA B13 PROBE // never created // ${new Date().toISOString().slice(0, 10)}`,
  objective: 'OUTCOME_SALES',
  status: 'PAUSED',
  budget_mode: 'cbo',
  daily_budget_usd: 50,
  bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
};

const validation = await graph(`${PRACTICE_ACCOUNT}/campaigns`, {
  name: SETTINGS.name,
  objective: SETTINGS.objective,
  status: 'PAUSED',
  buying_type: 'AUCTION',
  special_ad_categories: JSON.stringify([]),
  bid_strategy: SETTINGS.bid_strategy,
  daily_budget: String(SETTINGS.daily_budget_usd * 100),
  execution_options: JSON.stringify(['validate_only']),
}, 'POST');
console.log('\n--- 1. Graph validate_only response ---');
console.log(JSON.stringify(validation, null, 2));

// -------------------------------------------- 2. the executor's own dry run
const verdict = await handleExecuteAction({
  client_code: PRACTICE_CLIENT_CODE,
  user_id: 'b13-probe',
  dry_run: true,
  intent: { type: 'create_campaign', target_id: PRACTICE_ACCOUNT, settings: SETTINGS },
});
console.log('\n--- 2. handleExecuteAction dry_run verdict ---');
console.log(JSON.stringify(verdict, null, 2));
