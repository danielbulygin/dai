/**
 * R2 QC gate — cold vs synced diff (handover §C), zero-LLM version.
 *
 * Runs the SAME account through both DATA paths and diffs the deterministic
 * outputs. The LLM sections execute identical code over these same rows, so
 * diffing the row aggregates + pure fast-tier sections proves the cold path
 * without spending a cent:
 *   synced = the exact Supabase pulls runMagicAudit does
 *   cold   = getTokenForClient(env branch) → fetchColdAdDays → buildColdRows
 *
 * Usage:  npx tsx scripts/audit-cold-vs-synced.ts GG
 *
 * Expected legitimate deltas (assert-tolerated, from the build-3 handover):
 *  - purchases: warehouse counts bare `purchase` only; cold counts omni-first
 *  - hold_rate: warehouse never populates it; cold computes it
 *  - funnel counts where only the omni_* variant is reported
 *  - account rows where the warehouse merges the `conversions` array
 * Everything else should reconcile within ~1%.
 */
import { getSupabase } from '../src/integrations/supabase.js';
import { getTokenForClient } from '../src/integrations/meta-token.js';
import { fetchColdAdDays } from '../src/audit/cold-fetch.js';
import { buildColdRows } from '../src/audit/cold-source.js';
import {
  computeConcentration, computeFatigue, computeCohorts, computeCostTrend, computeDayOfWeek,
  type PackAdRow, type PackAccountRow,
} from '../src/audit/report-pack.js';

const TOLERATED = new Set(['purchases', 'purchase_value', 'hold_rate_coverage', 'content_views', 'add_to_carts', 'checkouts_initiated', 'leads']);
const PCT_TOLERANCE = 1.5; // % — spend/impressions/clicks must reconcile within this

const daysAgoISO = (days: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

async function pageAll<T>(table: string, select: string, clientId: string, sinceDays: number, maxRows = 400_000): Promise<T[]> {
  const sb = getSupabase();
  const out: T[] = [];
  for (let from = 0; from < maxRows; from += 1000) {
    const { data, error } = await sb.from(table).select(select)
      .eq('client_id', clientId).gte('date', daysAgoISO(sinceDays))
      .range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

interface Totals { spend: number; impressions: number; purchases: number; purchase_value: number; leads: number }
const totalsOf = (rows: Array<{ spend: number; impressions: number; purchases: number; purchase_value: number; leads?: number | null }>): Totals => ({
  spend: rows.reduce((s, r) => s + (r.spend || 0), 0),
  impressions: rows.reduce((s, r) => s + (r.impressions || 0), 0),
  purchases: rows.reduce((s, r) => s + (r.purchases || 0), 0),
  purchase_value: rows.reduce((s, r) => s + (r.purchase_value || 0), 0),
  leads: rows.reduce((s, r) => s + (r.leads || 0), 0),
});

const pct = (a: number, b: number): string => {
  if (a === 0 && b === 0) return '0.0%';
  const base = Math.max(Math.abs(a), Math.abs(b));
  return `${(((b - a) / base) * 100).toFixed(1)}%`;
};
const pctNum = (a: number, b: number): number => {
  if (a === 0 && b === 0) return 0;
  return Math.abs(((b - a) / Math.max(Math.abs(a), Math.abs(b))) * 100);
};

async function main(): Promise<void> {
  const code = (process.argv[2] ?? '').toUpperCase();
  if (!code) { console.error('usage: npx tsx scripts/audit-cold-vs-synced.ts <CLIENT_CODE>'); process.exit(1); }

  const sb = getSupabase();
  const { data: client } = await sb.from('clients').select('id, name, ad_account_id, currency').ilike('code', code).maybeSingle();
  if (!client?.id) throw new Error(`client ${code} not found`);
  console.log(`\n=== R2 diff: ${code} (${client.name}) — cold Graph pull vs synced warehouse ===\n`);

  // --- synced rows (the exact pulls runMagicAudit does) ---
  const PACK_AD_COLS = 'ad_id, ad_name, adset_id, date, spend, impressions, purchases, purchase_value, results, leads:actions->lead, frequency, hook_rate, hold_rate';
  const [syncAd90, syncAcc90] = await Promise.all([
    pageAll<PackAdRow>('ad_daily', PACK_AD_COLS, client.id as string, 90),
    pageAll<PackAccountRow>('account_daily', 'date, spend, impressions, link_clicks, purchases, purchase_value, results', client.id as string, 90),
  ]);

  // --- cold rows (live Graph, env token — read-only, no LLM) ---
  const resolution = await getTokenForClient({ clientCode: code });
  if (!resolution) throw new Error(`no token/account resolvable for ${code}`);
  console.log(`token source: ${resolution.source}, account: ${resolution.adAccountId}`);
  const pull = await fetchColdAdDays(resolution.token, resolution.adAccountId, { days: 90 });
  const cold = buildColdRows({ adDays: pull.adDays });
  console.log(`cold pull: ${cold.rowCount} ad-day rows, truncated=${pull.truncated}, failedSlices=${pull.failedSlices}`);
  console.log(`synced:    ${syncAd90.length} ad-day rows (ad_daily 90d)\n`);

  // --- 1) row-aggregate diff ---
  const failures: string[] = [];
  const report = (label: string, key: string, a: number, b: number): void => {
    const delta = pctNum(a, b);
    const tolerated = TOLERATED.has(key);
    // Coverage counts (distinct ads) wobble more than money with sync lag /
    // Meta restating recent days — allow 5% there, 1.5% on delivery totals.
    const tolerance = label === 'cov' ? 5 : PCT_TOLERANCE;
    const flag = delta <= tolerance ? 'OK ' : tolerated ? 'TOL' : 'FAIL';
    if (flag === 'FAIL') failures.push(`${label}.${key}`);
    console.log(`  ${flag}  ${label}.${key}: synced=${Math.round(a)} cold=${Math.round(b)} (Δ ${pct(a, b)})`);
  };

  console.log('— ad-level 90d totals —');
  const sT = totalsOf(syncAd90); const cT = totalsOf(cold.packRows90);
  for (const k of ['spend', 'impressions', 'purchases', 'purchase_value', 'leads'] as const) report('ad90', k, sT[k], cT[k]);

  console.log('— account-level 90d totals (synced account_daily vs cold derived) —');
  const sA = totalsOf(syncAcc90); const cA = totalsOf(cold.packAccRows90);
  for (const k of ['spend', 'impressions', 'purchases', 'purchase_value'] as const) report('acc90', k, sA[k], cA[k]);

  console.log('— hook/hold coverage (ads with a POSITIVE rate) —');
  // > 0, not non-null: legacy warehouse rows (pre-May backfills) stored
  // hook_rate 0 where the current sync stores NULL (video_plays=0 days, i.e.
  // statics). Cold uses the current NULL semantics — comparing non-null would
  // count the artifact as missing coverage (found on GG, 2026-07-03: 149 of
  // 516 "covered" ads were zero-only artifact rows).
  const cov = (rows: PackAdRow[], f: 'hook_rate' | 'hold_rate'): number => new Set(rows.filter((r) => (r[f] ?? 0) > 0).map((r) => r.ad_id)).size;
  report('cov', 'hook_rate_coverage', cov(syncAd90, 'hook_rate'), cov(cold.packRows90, 'hook_rate'));
  report('cov', 'hold_rate_coverage', cov(syncAd90, 'hold_rate'), cov(cold.packRows90, 'hold_rate'));

  // --- 2) deterministic fast-tier sections on both row sets ---
  console.log('\n— fast-tier sections (pure functions over each row set) —');
  const rows30s = syncAd90.filter((r) => r.date >= daysAgoISO(30));
  const rows30c = cold.packRows90.filter((r) => r.date >= daysAgoISO(30));
  const secs: Array<[string, () => unknown, () => unknown]> = [
    ['concentration', () => computeConcentration(rows30s), () => computeConcentration(rows30c)],
    ['fatigue', () => computeFatigue(syncAd90, 1.0, ''), () => computeFatigue(cold.packRows90, 1.0, '')],
    ['cohorts', () => computeCohorts(syncAd90), () => computeCohorts(cold.packRows180.filter((r) => r.date >= daysAgoISO(90)))],
    ['cost_trend', () => computeCostTrend(syncAcc90, ''), () => computeCostTrend(cold.packAccRows90, '')],
    ['day_of_week', () => computeDayOfWeek(syncAcc90), () => computeDayOfWeek(cold.packAccRows90)],
  ];
  for (const [name, sFn, cFn] of secs) {
    try {
      const s = JSON.stringify((sFn() as { summary?: string }).summary ?? '');
      const c = JSON.stringify((cFn() as { summary?: string }).summary ?? '');
      const same = s === c;
      console.log(`  ${same ? 'MATCH' : 'DIFF '}  ${name}`);
      if (!same) { console.log(`         synced: ${s.slice(0, 140)}`); console.log(`         cold:   ${c.slice(0, 140)}`); }
    } catch (err) {
      console.log(`  ERR    ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n=== verdict: ${failures.length === 0 ? 'PASS' : `FAIL (${failures.join(', ')})`} ===`);
  console.log('(TOL rows are the documented warehouse divergences — expected; DIFF section summaries need eyeballing, small text deltas from tolerated fields are fine.)\n');
  process.exit(failures.length === 0 ? 0 : 2);
}

main().catch((err) => { console.error(err); process.exit(1); });
