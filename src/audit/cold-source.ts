import type { PackAdRow, PackAccountRow } from './report-pack.js';

/**
 * Cold-path data source — turns a live Meta Graph `level=ad, time_increment=1`
 * insights pull into the EXACT in-memory shapes the audit's deterministic
 * compute functions already consume, so a freshly-connected account (no synced
 * `ad_daily` / `account_daily`) runs the same fast tier as a warehouse account.
 *
 * This module is PURE (Graph JSON → row arrays); the Graph fetching + token
 * resolution live in the orchestrator wiring. Account-level rows are DERIVED by
 * aggregating the ad-level pull per date — one pull, internally consistent, and
 * the R2 diff against the synced warehouse surfaces any real divergence.
 *
 * Field semantics follow the warehouse sync (daily_fb_sync.py) so the diff is
 * apples-to-apples:
 *  - purchases   = actions[omni_purchase | purchase]      (count)
 *  - purchase_value = action_values[omni_purchase | purchase]
 *  - leads       = actions[lead]
 *  - link_clicks = actions[link_click]
 *  - hook_rate   = video_view / impressions   (FRACTION, 4dp — as ad_daily stores it)
 *  - hold_rate   = video_thruplay / impressions (FRACTION, 4dp)
 * `results` is left 0 (ad_daily.results is null for most accounts; every consumer
 * falls back through `resultOf` = results||purchases||leads, report-pack.ts),
 * matching warehouse behaviour. `leads` therefore rides on BOTH the ad rows and
 * the derived account rows: a consumer that cannot see it divides by nothing.
 *
 * KNOWN divergences from the warehouse (intentional — assert-tolerate these in
 * the R2 cold-vs-synced diff; full list in the build-3 handover):
 *  - purchases COUNT: warehouse reads bare `purchase` only (its purchase_VALUE
 *    is omni-first — the warehouse count/value disagree; that's a warehouse
 *    finding, not a bug here).
 *  - hold_rate: warehouse syncs never populate it; cold computes it.
 *  - funnel counts (view_content / add_to_cart / initiate_checkout): cold falls
 *    back to the omni_* variant when the bare event is absent; warehouse reads
 *    the bare name only.
 *  - account rows: warehouse account_daily merges the Graph `conversions` array
 *    (custom pixel events) into actions before extraction; cold-derived account
 *    rows are summed from ad-level actions, which have no such merge.
 */

interface RawAction {
  action_type?: string;
  value?: string | number;
}

/** A single Graph insights row at level=ad, time_increment=1 (one ad × one day). */
export interface RawAdDay {
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  date_start?: string;
  date_stop?: string;
  spend?: string | number;
  impressions?: string | number;
  clicks?: string | number;
  frequency?: string | number;
  actions?: RawAction[];
  action_values?: RawAction[];
  video_thruplay_watched_actions?: RawAction[];
}

/** Ad-level 30d aggregate with a landing destination (from live creative resolution). */
export interface ColdLandingRow {
  ad_id: string;
  spend: number;
  purchases: number;
  purchase_value: number;
  leads: number | null;
  landing_page_market: string | null;
  landing_page_path: string | null;
}

/** The full account-daily record the funnel section aggregates (aggregateDaily fields). */
export interface ColdAccountFullRow {
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  link_clicks: number;
  content_views: number;
  add_to_carts: number;
  checkouts_initiated: number;
  purchases: number;
  purchase_value: number;
  leads: number;
  complete_registrations: number;
  results: number;
}

export interface ColdRows {
  packRows90: PackAdRow[];
  packRows180: Array<Pick<PackAdRow, 'ad_id' | 'date' | 'spend'>>;
  packAccRows90: PackAccountRow[];
  accFull30: ColdAccountFullRow[];
  landing30: ColdLandingRow[];
  /** How many distinct (ad, day) rows the pull yielded — for logging / caveats. */
  rowCount: number;
  /** Distinct days covered in the window (drives the thin-window caveat). */
  daysCovered: number;
}

export interface BuildColdRowsInput {
  adDays: RawAdDay[];
  /** ad_id → resolved current landing destination (from live creative reads). */
  destinations?: Record<string, { market: string | null; path: string | null }>;
  /** Window anchor (YYYY-MM-DD). Defaults to today (UTC). Explicit for tests. */
  asOf?: string;
}

const numOf = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

/** First matching action type's value (warehouse get_action_value semantics). */
function actionVal(actions: RawAction[] | undefined, types: string[]): number {
  if (!actions) return 0;
  for (const t of types) {
    const hit = actions.find((a) => a.action_type === t);
    if (hit) return numOf(hit.value);
  }
  return 0;
}

const cutISO = (asOf: string, days: number): string => {
  const d = new Date(`${asOf}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

const round4 = (v: number): number => Math.round(v * 10_000) / 10_000;

/** Normalised per-(ad, day) record — the single source all output shapes derive from. */
interface Norm {
  ad_id: string;
  ad_name: string | null;
  adset_id: string | null;
  date: string;
  spend: number;
  impressions: number;
  clicks: number;
  frequency: number | null;
  purchases: number;
  purchase_value: number;
  leads: number;
  link_clicks: number;
  content_views: number;
  add_to_carts: number;
  checkouts_initiated: number;
  complete_registrations: number;
  hook_rate: number | null;
  hold_rate: number | null;
}

function normalize(raw: RawAdDay): Norm | null {
  const ad_id = raw.ad_id ? String(raw.ad_id) : '';
  const date = (raw.date_start ?? raw.date_stop ?? '').slice(0, 10);
  if (!ad_id || !date) return null;
  const impressions = numOf(raw.impressions);
  const videoViews = actionVal(raw.actions, ['video_view']);
  const thruplays = actionVal(raw.video_thruplay_watched_actions, ['video_view']);
  return {
    ad_id,
    ad_name: raw.ad_name ? String(raw.ad_name) : null,
    adset_id: raw.adset_id ? String(raw.adset_id) : null,
    date,
    spend: numOf(raw.spend),
    impressions,
    clicks: numOf(raw.clicks),
    frequency: raw.frequency != null ? numOf(raw.frequency) : null,
    purchases: actionVal(raw.actions, ['omni_purchase', 'purchase']),
    purchase_value: actionVal(raw.action_values, ['omni_purchase', 'purchase']),
    leads: actionVal(raw.actions, ['lead']),
    link_clicks: actionVal(raw.actions, ['link_click']),
    content_views: actionVal(raw.actions, ['view_content', 'omni_view_content']),
    add_to_carts: actionVal(raw.actions, ['add_to_cart', 'omni_add_to_cart']),
    checkouts_initiated: actionVal(raw.actions, ['initiate_checkout', 'omni_initiated_checkout']),
    complete_registrations: actionVal(raw.actions, ['complete_registration']),
    hook_rate: videoViews > 0 && impressions > 0 ? round4(videoViews / impressions) : null,
    hold_rate: thruplays > 0 && impressions > 0 ? round4(thruplays / impressions) : null,
  };
}

/**
 * Build the cold-path row set from a Graph ad-level daily pull. Windows (30/90/
 * 180d) are computed off `asOf`; the caller should pull ≥180d for full cohort
 * coverage (sections degrade honestly on a shorter pull).
 */
export function buildColdRows(input: BuildColdRowsInput): ColdRows {
  const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
  const cut30 = cutISO(asOf, 30);
  const cut90 = cutISO(asOf, 90);
  const cut180 = cutISO(asOf, 180);
  const dest = input.destinations ?? {};

  const norm: Norm[] = [];
  for (const raw of input.adDays) {
    const n = normalize(raw);
    if (n) norm.push(n);
  }

  const packRows90: PackAdRow[] = norm
    .filter((n) => n.date >= cut90)
    .map((n) => ({
      ad_id: n.ad_id,
      ad_name: n.ad_name,
      adset_id: n.adset_id,
      date: n.date,
      spend: n.spend,
      impressions: n.impressions,
      purchases: n.purchases,
      purchase_value: n.purchase_value,
      results: 0,
      frequency: n.frequency,
      hook_rate: n.hook_rate,
      hold_rate: n.hold_rate,
      leads: n.leads,
    }));

  const packRows180 = norm
    .filter((n) => n.date >= cut180)
    .map((n) => ({ ad_id: n.ad_id, date: n.date, spend: n.spend }));

  // Account-daily = ad-level aggregated per date.
  const accByDate = new Map<string, ColdAccountFullRow>();
  for (const n of norm) {
    if (n.date < cut90) continue;
    const a = accByDate.get(n.date) ?? {
      date: n.date, spend: 0, impressions: 0, clicks: 0, link_clicks: 0, content_views: 0,
      add_to_carts: 0, checkouts_initiated: 0, purchases: 0, purchase_value: 0, leads: 0,
      complete_registrations: 0, results: 0,
    };
    a.spend += n.spend;
    a.impressions += n.impressions;
    a.clicks += n.clicks;
    a.link_clicks += n.link_clicks;
    a.content_views += n.content_views;
    a.add_to_carts += n.add_to_carts;
    a.checkouts_initiated += n.checkouts_initiated;
    a.purchases += n.purchases;
    a.purchase_value += n.purchase_value;
    a.leads += n.leads;
    a.complete_registrations += n.complete_registrations;
    accByDate.set(n.date, a);
  }
  const accAll = [...accByDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const packAccRows90: PackAccountRow[] = accAll.map((a) => ({
    date: a.date,
    spend: a.spend,
    impressions: a.impressions,
    link_clicks: a.link_clicks,
    purchases: a.purchases,
    purchase_value: a.purchase_value,
    results: a.results,
    // `results` stays 0 here (warehouse parity); the weekday read needs the lead
    // count to divide by, or it reports raw spend as a cost per result.
    leads: a.leads,
  }));

  const accFull30 = accAll.filter((a) => a.date >= cut30);

  // landing30 = ad-level 30d aggregate + resolved destination.
  const landByAd = new Map<string, ColdLandingRow>();
  for (const n of norm) {
    if (n.date < cut30) continue;
    const d = dest[n.ad_id];
    const a = landByAd.get(n.ad_id) ?? {
      ad_id: n.ad_id, spend: 0, purchases: 0, purchase_value: 0, leads: 0,
      landing_page_market: d?.market ?? null, landing_page_path: d?.path ?? null,
    };
    a.spend += n.spend;
    a.purchases += n.purchases;
    a.purchase_value += n.purchase_value;
    a.leads = (a.leads ?? 0) + n.leads;
    landByAd.set(n.ad_id, a);
  }

  return {
    packRows90,
    packRows180,
    packAccRows90,
    accFull30,
    landing30: [...landByAd.values()],
    rowCount: norm.length,
    daysCovered: new Set(norm.filter((n) => n.date >= cut30).map((n) => n.date)).size,
  };
}

// ---------------------------------------------------------------------------
// Stated-economics helpers (margin re-basing + attribution, 2026-07-04).
// Founder-sim debt #1: the audit page cited the lead's own signup target as if
// it were ours ("unsourced number on a show-your-work page"). These are pure so
// the breakeven math and the attribution contract are unit-testable.
// ---------------------------------------------------------------------------

/**
 * 1 ÷ gross margin, 2dp — e.g. a stated 45% margin → 2.22× breakeven ROAS.
 * Invalid or missing margins (≤0, ≥100, null) fall back to the honest 1.0×
 * default, which computeFatigue then caveats as "your true breakeven is higher".
 */
export function coldBreakeven(grossMarginPct: number | null | undefined): { grossMarginPct: number | null; breakevenRoas: number } {
  const pct = typeof grossMarginPct === 'number' && Number.isFinite(grossMarginPct) && grossMarginPct > 0 && grossMarginPct < 100
    ? grossMarginPct
    : null;
  return { grossMarginPct: pct, breakevenRoas: pct != null ? Math.round((100 / pct) * 100) / 100 : 1.0 };
}

/**
 * The cold-path clientKnowledge block for every synthesis call. The contract:
 * anything the owner stated at signup is cited AS THEIRS, in-text, every time —
 * and anything they did NOT state is never invented, assumed, or implied.
 */
export function buildColdKnowledge(args: {
  goalMetric?: string | null;
  goalValue?: number | null;
  grossMarginPct: number | null;
  breakevenRoas: number;
}): string {
  const hasGoal = !!args.goalMetric && args.goalValue != null;
  const parts: string[] = [];
  if (hasGoal) {
    const metric = args.goalMetric!.toUpperCase();
    parts.push(
      `The account owner set this target themselves at signup: ${metric} of ${args.goalValue}. ` +
        `When you cite it, ALWAYS attribute it in-text — e.g. "the ${metric} ${args.goalValue} target you set when you connected" — ` +
        `never present it as our estimate, a Meta value, or an industry number.`,
    );
  }
  if (args.grossMarginPct != null) {
    parts.push(
      `The account owner stated their gross margin at signup: ${args.grossMarginPct}%, which puts their true breakeven at ` +
        `${args.breakevenRoas}x ROAS (1 ÷ margin). Same attribution rule — cite it as theirs, e.g. "at your stated ` +
        `${args.grossMarginPct}% margin", never as our estimate or an industry number.`,
    );
  }
  if (parts.length === 0) {
    parts.push(
      `The owner gave us NO target, margin, or breakeven. NEVER invent, assume, or imply one. ` +
        `Anchor judgments to the account's own observed figures and, where a target would matter, ` +
        `say plainly that no target has been set yet.`,
    );
  } else {
    if (!hasGoal) {
      parts.push(`No performance target was given — never invent or imply one; where a target would matter, say plainly that none has been set yet.`);
    }
    if (args.grossMarginPct == null) {
      parts.push(`No gross margin was given — never invent or imply a margin or breakeven figure.`);
    }
  }
  parts.push(`No other client history is available — this is a first-time audit of a freshly connected account.`);
  return parts.join(' ');
}
