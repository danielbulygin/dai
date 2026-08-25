/**
 * The B11 practice-account probe: prove the pause/resume rail against real
 * Meta without writing anything.
 *
 * Resume is the only verb on the approve rail that turns spend ON, so what is
 * worth proving live is not that it works but that it REFUSES: a campaign
 * outside the fence has to be turned down against real ids, not only against a
 * mock. And the level-aware target read exists because of a Graph error that
 * has to be seen rather than assumed — an ad-set-shaped read of a campaign id
 * throws, and every campaign-level verb went through that read before.
 *
 * PRE-FLIGHT, always, per the standing rule for this account: every campaign
 * off and no spend in the last 7 days, or the probe reports and skips.
 *
 * Every call here is a GET or a dry run. `dry_run` is hardcoded true at the one
 * call site, and no branch in this file sets it false.
 *
 * Run: cd /root/dai && set -a && source .env && set +a \
 *      && node_modules/.bin/tsx scripts/_b11-practice-dryrun.mts
 */

// Import-safe: ada-console-assist binds port 8092 unless this is set, and the
// live service already holds it. Same escape hatch the test runner uses.
process.env.VITEST = '1';

const PRACTICE_ACCOUNT = 'act_1570076840279279';
const PRACTICE_CLIENT_CODE = 'AOTUS';
const GRAPH = 'https://graph.facebook.com/v21.0';

const { handleExecuteAction } = await import('./ada-console-assist.js');
const { envTokenFor } = await import('../src/integrations/meta-token.js');
const { getSupabase } = await import('../src/integrations/supabase.js');

const token = envTokenFor(PRACTICE_CLIENT_CODE);
if (!token) {
  console.error('no Meta token on this rail — nothing probed');
  process.exit(1);
}

async function graph(path: string, params: Record<string, string>) {
  const qs = new URLSearchParams({ ...params, access_token: token as string });
  const res = await fetch(`${GRAPH}/${path}?${qs}`);
  return (await res.json()) as Record<string, unknown>;
}

/** dry_run is not a parameter of this helper on purpose. */
const dryRun = (intent: Record<string, unknown>) =>
  handleExecuteAction({ client_code: PRACTICE_CLIENT_CODE, user_id: 'b11-probe', dry_run: true, intent });

// ---------------------------------------------------------------- pre-flight
const list = await graph(`${PRACTICE_ACCOUNT}/campaigns`, { fields: 'id,effective_status', limit: '200' });
if (list.error) {
  console.error('PRE-FLIGHT FAILED — could not read campaigns:', JSON.stringify(list.error));
  process.exit(1);
}
const rows = (list.data as Array<{ id: string; effective_status?: string }> | undefined) ?? [];
const live = rows.filter((c) => c.effective_status !== 'PAUSED' && c.effective_status !== 'ARCHIVED');
console.log(`campaigns: ${rows.length} total, ${live.length} not paused`);
if (live.length > 0) {
  console.log('SKIPPED — these campaigns are not paused:', live.map((c) => `${c.id}=${c.effective_status}`).join(', '));
  process.exit(0);
}
const insights = await graph(`${PRACTICE_ACCOUNT}/insights`, { fields: 'spend', date_preset: 'last_7d' });
const spend7d = ((insights.data as Array<{ spend?: string }> | undefined) ?? [])
  .reduce((sum, r) => sum + (Number(r.spend ?? 0) || 0), 0);
console.log(`7-day spend: $${spend7d.toFixed(2)}`);
if (spend7d > 0) {
  console.log('SKIPPED — the practice account has spent in the last 7 days.');
  process.exit(0);
}

// The fence is read from the client row, never hardcoded: the whole point of
// check D is that the refusal comes from what the account actually opened.
const { data: client } = await getSupabase()
  .from('clients').select('allowed_campaign_ids').eq('code', PRACTICE_CLIENT_CODE).maybeSingle();
const fence: string[] = (client?.allowed_campaign_ids as string[] | null) ?? [];
const fenced = rows.find((r) => fence.includes(r.id));
const outside = rows.find((r) => !fence.includes(r.id));
if (!fenced || !outside) {
  console.log('SKIPPED — needs one fenced and one unfenced campaign to compare.');
  process.exit(0);
}
console.log(`fenced=${fenced.id} outside=${outside.id}`);

console.log('\n--- A. an ad-set-shaped read of a CAMPAIGN id ---');
const adsetShaped = await graph(fenced.id, {
  fields: 'id,name,status,effective_status,daily_budget,campaign_id,account_id',
});
console.log(JSON.stringify(adsetShaped.error ?? adsetShaped, null, 2).slice(0, 400));

console.log('\n--- B. the campaign-shaped read the rail uses instead ---');
const campaignShaped = await graph(fenced.id, {
  fields: 'id,name,status,effective_status,daily_budget,account_id',
});
console.log(JSON.stringify({
  id: campaignShaped.id, status: campaignShaped.status,
  effective_status: campaignShaped.effective_status,
  has_daily_budget: Boolean(campaignShaped.daily_budget),
  account_id: campaignShaped.account_id,
}, null, 2));

console.log('\n--- C. resume_campaign dry run, inside the fence ---');
console.log(JSON.stringify(await dryRun({ type: 'resume_campaign', target_id: fenced.id }), null, 2));

console.log('\n--- D. resume_campaign dry run, OUTSIDE the fence ---');
console.log(JSON.stringify(await dryRun({ type: 'resume_campaign', target_id: outside.id }), null, 2));

console.log('\n--- E. pause_campaign dry run on a campaign already paused ---');
console.log(JSON.stringify(await dryRun({ type: 'pause_campaign', target_id: fenced.id }), null, 2));

console.log('\n--- F. resume_ad_set dry run, ad set inside a fenced campaign ---');
const adsets = await graph(`${fenced.id}/adsets`, { fields: 'id,effective_status', limit: '3' });
const firstAdSet = ((adsets.data as Array<{ id: string }> | undefined) ?? [])[0];
if (!firstAdSet) console.log('(no ad sets in the fenced campaign)');
else console.log(JSON.stringify(await dryRun({ type: 'resume_ad_set', target_id: firstAdSet.id }), null, 2));
