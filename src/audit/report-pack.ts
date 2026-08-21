/**
 * Report pack — the audit's DETERMINISTIC fast tier (Ada 2.0 Phase C).
 *
 * WHY: Dan (2026-07-02): "the speed to the first truly magic moment correlates
 * with conversion." These five reports are Dan's confirmed build set from the
 * design spec (docs/ada-magic-audit-design-2026-06-25.md §menu) that need ZERO
 * LLM calls and ZERO new syncs — pure math over ad_daily/account_daily. They
 * land in seconds, before any Opus synthesis finishes, so the first screen of
 * the audit is already "invisible things about YOUR money" while the heavy
 * sections still cook. Every function is pure (rows in → section out) and
 * unit-tested (tests/report-pack.test.ts).
 *
 * BINDING RULES from the design spec (do not weaken):
 * - Fatigue = ROAS *TREND*, never age or frequency. Old + stable + good =
 *   EVERGREEN — protect it, never flag it for refresh (Dan 2026-06-25).
 * - Frequency-aware kill guard: below-breakeven at LOW frequency is likely
 *   true top-of-funnel acquisition — never recommend killing on ROAS alone.
 * - Statistical floor: suppress findings built on thin data (persona fix #4).
 * - A labelled "Next step:" on EVERY report (Francis's #1 theme).
 * - Plain operator voice in templates — say it like you'd say it on a call.
 * - Honest labels: name the granularity/window; never imply data we don't have.
 */

export interface PackAdRow {
  ad_id: string;
  ad_name: string | null;
  date: string;
  spend: number;
  impressions: number;
  purchases: number;
  purchase_value: number;
  results: number;
  frequency: number | null;
  hook_rate: number | null;
  hold_rate: number | null;
  /** Present on the 90d pull since Session D (optimization-event spend mapping). */
  adset_id?: string | null;
  /**
   * Ad-level leads extracted from the actions JSONB (`leads:actions->lead`) —
   * `ad_daily.results` is NULL for most lead-gen accounts (GG read "cost per
   * result 30,480" = raw spend before this fallback, 2026-07-02).
   */
  leads?: number | null;
  /**
   * Ad-level link clicks, on the paths that have them per ad (the cold and
   * bridged pulls extract `actions[link_click]`; the warehouse ad-level select
   * does not carry a column for it).
   *
   * OPTIONAL and undefined-means-unread, never zero: the attention read below
   * asks whether an ad was watched and not clicked, and an unread click count
   * arriving as 0 would answer yes about every ad on a warehouse account.
   */
  link_clicks?: number | null;
}

export interface PackAccountRow {
  date: string;
  spend: number;
  impressions: number;
  link_clicks: number;
  purchases: number;
  purchase_value: number;
  results: number;
  /**
   * Account-level leads (`account_daily.leads`, or the cold path's summed ad
   * lead actions). Same reason as `PackAdRow.leads`: `results` is 0 or NULL on
   * most lead-gen accounts, so without this the weekday read divides spend by
   * nothing and reports raw spend as a cost per result.
   */
  leads?: number | null;
}

export interface PackSection {
  summary: string;
  /**
   * OPTIONAL, and absent on purpose when the section found nothing: the page
   * reads a next step as an action worth taking, so a quiet section carrying
   * one renders as a finding. A quiet row is its summary and nothing else.
   */
  next_step?: string;
  /**
   * Section payload. Every compute function in this file sets `data.signal`:
   * false means the section ran clean and found nothing (a flat CPM trend, an
   * empty fatigue list, a healthy cohort mix), so the page can give it a line
   * instead of a full chapter. It is NOT an error and NOT a suppression: the
   * numbers behind it are still here.
   */
  data: Record<string, unknown>;
  warnings?: string[];
  /**
   * "How we got this" — the derivation shown behind an expandable on the page
   * (pro-trust layer, UX review §5.5; Francis: "show fatigue days derivation").
   * Plain operator voice: window, inputs, floors, formula — no mystique.
   */
  derivation?: string;
}

/** Label a rounded money amount with the account currency (currency-naive when unset). */
const money = (v: number, currency: string): string =>
  `${Math.round(v).toLocaleString('en-US')}${currency ? ` ${currency}` : ''}`;

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r1 = (v: number): number => Math.round(v * 10) / 10;
const pct = (num: number, den: number): number => (den > 0 ? r1((num / den) * 100) : 0);
const div = (num: number, den: number): number => (den > 0 ? num / den : 0);

/**
 * The result count one row actually carries: `results` when the sync mapped it,
 * else purchases, else the lead actions. The cold/bridged path leaves `results`
 * at 0 (matching `ad_daily.results`, NULL for most lead-gen accounts), so any
 * cpr read that divides by `results` alone silently degrades into raw spend —
 * the live lead-gen audit printed "cost per result 2,605" against a real 18.59
 * cost per lead. 0 out means the account has no mapped result for this row at
 * all, which callers SUPPRESS rather than plot as a zero.
 */
export function resultOf(row: { results?: number | null; purchases?: number | null; leads?: number | null }): number {
  return row.results || row.purchases || row.leads || 0;
}

/** Whether this account's economics read as ROAS (purchase value present) or cost-per-result. */
/**
 * The ONE cost word a report is allowed to use, decided from the lens and
 * nowhere else. Null when the lens cannot pick one, and then nothing is
 * rewritten: on an account recording both leads and purchases, or neither,
 * there is no single word that is true.
 *
 * The live read said "CPL" on one chip, "Meta CPL" in an insight and "cost per
 * result" in three chapter labels, all about the same number. A reader
 * counting metrics counted three.
 */
export function costWordForLens(
  lens: 'lead_gen' | 'ecommerce' | 'mixed' | 'unknown' | null | undefined,
): string | null {
  if (lens === 'lead_gen') return 'cost per lead';
  if (lens === 'ecommerce') return 'Meta CPA';
  return null;
}

export function kpiMode(rows: Array<{ purchase_value: number; results: number }>): 'roas' | 'cpr' {
  const value = rows.reduce((s, r) => s + (r.purchase_value || 0), 0);
  return value > 0 ? 'roas' : 'cpr';
}

// ---------------------------------------------------------------------------
// 1. Spend concentration: how much of the account rides on one ad
// ---------------------------------------------------------------------------

export function computeConcentration(rows30: PackAdRow[]): PackSection {
  const byAd = new Map<string, { ad_id: string; name: string; spend: number }>();
  let total = 0;
  for (const r of rows30) {
    total += r.spend || 0;
    const a = byAd.get(r.ad_id) ?? { ad_id: r.ad_id, name: r.ad_name ?? r.ad_id, spend: 0 };
    a.spend += r.spend || 0;
    if (r.ad_name) a.name = r.ad_name;
    byAd.set(r.ad_id, a);
  }
  const ads = [...byAd.values()].sort((a, b) => b.spend - a.spend);
  const share = (n: number) => pct(ads.slice(0, n).reduce((s, a) => s + a.spend, 0), total);
  const top1 = share(1);
  const top3 = share(3);
  const top10 = share(10);
  // HHI over spend shares (0..10000 convention)
  const hhi = Math.round(ads.reduce((s, a) => s + Math.pow((100 * a.spend) / (total || 1), 2), 0));

  // Benchmark bands (design spec: give "what good looks like", not just their number)
  const band = top3 >= 60 ? 'high' : top3 >= 40 ? 'elevated' : 'healthy';
  const bandLine =
    band === 'high'
      ? `Above 60% in the top 3 means one ad carries the account: if the #1 ad fatigues, most of the account goes with it.`
      : band === 'elevated'
        ? `40–60% in the top 3 is workable but worth watching — most healthy accounts at this spend sit under 40%.`
        : `Under 40% in the top 3 is a healthy spread.`;

  const warnings: string[] = [];
  if (ads.length < 5 || total < 500) {
    warnings.push(`Thin base (${ads.length} ads with spend) — concentration reads are directional only.`);
  }

  const topAds = ads.slice(0, 10);
  const nameCounts = new Map<string, number>();
  for (const a of topAds) nameCounts.set(a.name, (nameCounts.get(a.name) ?? 0) + 1);

  return {
    summary:
      `Your top ad takes ${top1}% of the last 30 days' spend; the top 3 take ${top3}% and the top 10 take ${top10}% ` +
      `(${ads.length} ads spent anything at all). ${bandLine}`,
    // A healthy spread is this chapter reading clean (signal false below), so
    // it carries no action row: "keep the cadence that produced this" asks for
    // nothing the account is not already doing.
    ...(band === 'healthy'
      ? {}
      : {
          next_step:
            band === 'high'
              ? `Get 2–3 genuinely different concepts live this month so the account isn't riding one creative. Start from what the top ad does well, and vary the angle rather than cloning it.`
              : `Keep at least one new concept entering test every other week so the top 3 never become the whole account.`,
        }),
    data: {
      window_days: 30,
      total_spend: Math.round(total),
      ads_with_spend: ads.length,
      top1_share_pct: top1,
      top3_share_pct: top3,
      top10_share_pct: top10,
      hhi,
      band,
      signal: band !== 'healthy',
      top_ads: topAds.map((a) => ({
        ad_id: a.ad_id,
        ad_name: a.name,
        spend: Math.round(a.spend),
        share_pct: pct(a.spend, total),
        // Two different ads can carry the same name, and the page rendered two
        // identical rows. The flag lets it disambiguate; we never rename an ad.
        ...(nameCounts.get(a.name)! > 1 ? { name_shared_with_other_ad: true } : {}),
      })),
    },
    warnings: warnings.length ? warnings : undefined,
    derivation:
      `Summed each ad's spend across the last 30 days (${ads.length} ads spent anything), ` +
      `ranked them, and took the top-1/3/10 share of the total. The bands come from what we see across accounts: ` +
      `top-3 under 40% = healthy spread, 40–60% = elevated, over 60% = one ad carries the account.`,
  };
}

// ---------------------------------------------------------------------------
// 2. Creative fatigue & runway (evergreen-aware — the binding rule)
// ---------------------------------------------------------------------------

export interface FatigueAd {
  ad_id: string;
  ad_name: string;
  spend: number;
  in_window_age_days: number;
  kpi_first_half: number;
  kpi_second_half: number;
  /** The last-14-active-days level — where the ad is NOW (classification + runway use this). */
  kpi_recent: number;
  trend_pct: number; // second half vs first half, negative = worse
  avg_frequency: number | null;
  /**
   * The verdict, and it never claims more than the rule proved:
   * - `fatiguing`: 25%+ down AND confirmed (near the floor, or 40%+ down) on a run old enough to read.
   * - `declining_unconfirmed`: 25%+ down, or a recent level well off the first half, but the
   *   confirmation the fatiguing call needs is not there (too young, thin confirmation window,
   *   still far from the floor). It sits between stable and fatiguing, and it is NOT a kill call.
   * - `too_young_to_call`: under 21 days and not declining. The old name for this was `fresh`,
   *   which read as a verdict on the creative rather than on how much we can see.
   * - `stable`: the confirmation window holds within 25% of the first half.
   * - `evergreen`: 60+ days with the number holding (within 15%). Protected, never refreshed.
   */
  class: 'evergreen' | 'fatiguing' | 'declining_unconfirmed' | 'too_young_to_call' | 'stable';
  days_to_breakeven: number | null;
  low_frequency_acquisition_guard: boolean;
  /** Avg spend/day over the ad's last 14 active days — its CURRENT run-rate. */
  recent_daily_spend: number;
  /**
   * The ad's REAL summed spend over the last 30 days of the window, beside the
   * 90-day `spend`. A page that multiplied `recent_daily_spend` by 30 printed
   * 4,110 for an ad on an account whose whole 30 days was 8,999.
   */
  spend_30d: number;
  /**
   * Cost per result over the first half of the run, cpr mode only (null in roas
   * mode, and null when that half booked no result). The `kpi_*` fields above
   * are unitless results-per-spend RATES for the trend math, so printing one as
   * a KPI reads as "0.04x" next to a real cost per lead of 18.59.
   */
  cpl_first_half: number | null;
  /** Cost per result over the confirmation window, same rules as above. */
  cpl_last_14: number | null;
  /**
   * The ad's OWN last day with spend in the window. A stopped ad with a
   * `spend_30d` of 0 next to a 141/day run rate reads as a bug; the date is
   * what actually happened.
   */
  last_spend_date: string | null;
  /** Days from that last spending day to the window's last day (0 = it spent on the final day). */
  days_since_last_spend: number | null;
  /** Whether the ad spent anything in the window's last 7 days. False = it is not spending now. */
  still_spending: boolean;
  /** How many days the confirmation window actually got. Under 14 means the read is thin. */
  confirmation_days: number;
}

/**
 * The ads actually dragging spend: fatiguing, NOT flagged as low-frequency
 * acquisition, ranked by real 30-day spend, capped at three. Emitted here
 * because the page cannot derive it: a "below breakeven" filter over the
 * unitless rate fields matches EVERY ad on a cost-per-result account, and a
 * guarded acquisition ad is not dragging anything.
 */
export interface DraggingAd {
  ad_id: string;
  ad_name: string;
  spend_30d: number;
  recent_daily_spend: number;
  /** The headline figure in the account's own grammar, already labelled. */
  stat: string;
  /** One sentence saying why it is on this list, with a real number in it. */
  why: string;
}

/**
 * Relative statistical floors must be capped: on a 20M-SEK/90d account the
 * uncapped 1%-of-total fatigue floor excluded EVERY ad (NP, assessed_ads=0).
 * Caps are currency-naive, like the 200 base floor.
 */
export const FATIGUE_FLOOR_CAP = 2_500;
export const CONCEPT_FLOOR_CAP = 5_000;

/**
 * An ad that never found traction: old enough to have had its chance, never
 * funded past the assessment floor, and never a single measured result.
 *
 * It is deliberately NOT a fatigue class. Fatigue is a number coming down from
 * somewhere, and these ads never got up: they are invisible to the trend read
 * (they never clear its floor) and to the suppressed-no-result count (which is
 * for ads that DID clear it), so before this they were simply not in the report
 * at all — which is how an account launches thirty ads, funds four and hears
 * nothing about the other twenty-six.
 */
export interface DeadOnArrivalAd {
  ad_id: string;
  ad_name: string;
  spend: number;
  /** Days from its first spending day to its last, inside the window. */
  age_days: number;
  spend_days: number;
  last_spend_date: string | null;
}

/** Minimum age before "it never got going" is a verdict rather than impatience. */
export const DEAD_ON_ARRIVAL_MIN_DAYS = 5;

/**
 * An ad people watched and did not click: the plays are there, the link clicks
 * are not. It reads as entertainment rather than as an ad, and it is only
 * checkable where the rows carry per-ad link clicks.
 */
export interface AttentionWithoutActionAd {
  ad_id: string;
  ad_name: string;
  spend: number;
  impressions: number;
  video_plays: number;
  play_rate_pct: number;
  link_clicks: number;
  click_rate_pct: number;
}

export const ATTENTION_MIN_IMPRESSIONS = 1_000;
/** Watched: three-second plays on at least this share of impressions. */
export const ATTENTION_MIN_PLAY_RATE = 0.15;
/** And not clicked: link clicks on at most this share of impressions. */
export const ATTENTION_MAX_CLICK_RATE = 0.002;

/**
 * One ad's plays and link clicks, or null when the rows do not carry clicks at
 * all. Null is the honest answer for the warehouse ad-level select, which has
 * no per-ad click column: reading an absent count as zero would report every ad
 * on the account as watched and never clicked.
 */
function readAttention(rows: PackAdRow[]): { impressions: number; plays: number; linkClicks: number } | null {
  if (!rows.some((r) => typeof r.link_clicks === 'number')) return null;
  let impressions = 0;
  let plays = 0;
  let linkClicks = 0;
  for (const r of rows) {
    impressions += r.impressions || 0;
    // hook_rate is plays ÷ impressions as a fraction, so this recovers the count
    // the rate was made from rather than needing a second column for it.
    if (typeof r.hook_rate === 'number' && r.hook_rate > 0) plays += r.hook_rate * (r.impressions || 0);
    if (typeof r.link_clicks === 'number') linkClicks += r.link_clicks;
  }
  return { impressions, plays: Math.round(plays), linkClicks };
}
const cappedFloor = (base: number, relative: number, cap: number): number =>
  Math.max(base, Math.min(relative, cap));

/** An exact money figure (two decimals) — a cost per lead of 18.59 must not round to 19. */
const moneyExact = (v: number, currency: string): string => `${v.toFixed(2)}${currency ? ` ${currency}` : ''}`;

/** The ad's headline figure, labelled, in the account's own grammar. */
function draggingStat(ad: FatigueAd, mode: 'roas' | 'cpr', currency: string): string {
  if (mode === 'roas') return `Meta ROAS ${ad.kpi_recent.toFixed(2)}`;
  if (ad.cpl_last_14 == null) return 'no leads measured in the last 14 days';
  return `Meta CPL ${moneyExact(ad.cpl_last_14, currency)}`;
}

/** Why this ad is on the dragging list, in one sentence carrying a real number. */
function draggingWhy(ad: FatigueAd, mode: 'roas' | 'cpr', currency: string): string {
  const daily = `${money(ad.recent_daily_spend, currency)} a day`;
  if (mode === 'roas') {
    return `ROAS is down ${Math.abs(ad.trend_pct)}% from the first half of its run to the second, it sits at ${ad.kpi_recent.toFixed(2)} now, and it still takes ${daily}.`;
  }
  if (ad.cpl_first_half != null && ad.cpl_last_14 != null) {
    return `Cost per lead moved from ${moneyExact(ad.cpl_first_half, currency)} in the first half of its run to ${moneyExact(ad.cpl_last_14, currency)} now, and it still takes ${daily}.`;
  }
  if (ad.cpl_last_14 != null) {
    return `Leads per unit of spend are down ${Math.abs(ad.trend_pct)}% across its run and it now buys a lead for ${moneyExact(ad.cpl_last_14, currency)}, on ${daily}.`;
  }
  return `No lead was measured in its most recent days while it kept spending ${daily}.`;
}

export function computeFatigue(rows90: PackAdRow[], breakevenRoas = 1.0, currency = '', grossMarginPct: number | null = null): PackSection & { data: { ads: FatigueAd[] } & Record<string, unknown> } {
  const mode = kpiMode(rows90);
  const byAd = new Map<string, PackAdRow[]>();
  for (const r of rows90) {
    const list = byAd.get(r.ad_id) ?? [];
    list.push(r);
    byAd.set(r.ad_id, list);
  }
  const totalSpend = rows90.reduce((s, r) => s + (r.spend || 0), 0);
  // The window's own last day, so a 30-day spend is REAL summed spend and never
  // a daily run-rate multiplied out to a month.
  const windowEndMs = rows90.reduce((max, r) => Math.max(max, Date.parse(r.date)), 0);

  const ads: FatigueAd[] = [];
  let suppressedNoResults = 0;
  const deadOnArrival: DeadOnArrivalAd[] = [];
  const attentionWithoutAction: AttentionWithoutActionAd[] = [];
  const assessmentFloor = cappedFloor(200, totalSpend * 0.01, FATIGUE_FLOOR_CAP);
  for (const [adId, list] of byAd.entries()) {
    const spend = list.reduce((s, r) => s + r.spend, 0);
    const days = [...new Set(list.map((r) => r.date))].sort();
    const adName = list.find((r) => r.ad_name)?.ad_name ?? adId;
    const spentDays = [...new Set(list.filter((r) => (r.spend || 0) > 0).map((r) => r.date))].sort();
    const ageDays = Math.max(
      1,
      Math.round((Date.parse(days[days.length - 1]!) - Date.parse(days[0]!)) / 86_400_000) + 1,
    );

    // Watched and not clicked. Judged on real money only, and only where the
    // rows carry link clicks at all.
    const attention = spend >= assessmentFloor ? readAttention(list) : null;
    if (attention && attention.impressions >= ATTENTION_MIN_IMPRESSIONS) {
      const playRate = attention.plays / attention.impressions;
      const clickRate = attention.linkClicks / attention.impressions;
      if (playRate >= ATTENTION_MIN_PLAY_RATE && clickRate <= ATTENTION_MAX_CLICK_RATE) {
        attentionWithoutAction.push({
          ad_id: adId,
          ad_name: adName,
          spend: Math.round(spend),
          impressions: attention.impressions,
          video_plays: attention.plays,
          play_rate_pct: r1(playRate * 100),
          link_clicks: attention.linkClicks,
          click_rate_pct: r2(clickRate * 100),
        });
      }
    }

    // Statistical floor: enough days AND enough money to say anything.
    if (days.length < 10 || spend < assessmentFloor) {
      // The ads under that floor are not all the same. One that ran long enough
      // to be read, never got past the floor and never produced a result never
      // found traction, and saying so is the only way it appears in the report.
      if (ageDays >= DEAD_ON_ARRIVAL_MIN_DAYS && spend > 0 && list.reduce((s, r) => s + resultOf(r), 0) === 0) {
        deadOnArrival.push({
          ad_id: adId,
          ad_name: adName,
          spend: Math.round(spend),
          age_days: ageDays,
          spend_days: spentDays.length,
          last_spend_date: spentDays.length ? spentDays[spentDays.length - 1]! : null,
        });
      }
      continue;
    }
    // A cpr-mode ad with no mapped result anywhere in the window has no trend to
    // read: both halves rate 0.00, which files a 60-day ad as "evergreen" on flat
    // nothing. Leave it out and report the count instead of plotting the zero.
    if (mode === 'cpr' && list.reduce((s, r) => s + resultOf(r), 0) === 0) {
      suppressedNoResults += 1;
      continue;
    }

    const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date));
    const mid = Math.floor(sorted.length / 2);
    const rate = (part: PackAdRow[]): number => {
      const sp = part.reduce((s, r) => s + r.spend, 0);
      if (mode === 'roas') return div(part.reduce((s, r) => s + r.purchase_value, 0), sp);
      // cost-per-result mode: LOWER is better, so invert into a "results per spend" rate for trend math
      return div(part.reduce((s, r) => s + resultOf(r), 0), sp);
    };
    // The unitless rate above carries the TREND. A cost per result is what the
    // account actually pays, and it is the only figure worth printing in cpr mode.
    const costPer = (part: PackAdRow[]): number | null => {
      if (mode !== 'cpr') return null;
      const res = part.reduce((s, r) => s + resultOf(r), 0);
      return res > 0 ? r2(div(part.reduce((s, r) => s + r.spend, 0), res)) : null;
    };
    const h1 = rate(sorted.slice(0, mid));
    const h2 = rate(sorted.slice(mid));
    const trendPct = h1 > 0 ? r1(((h2 - h1) / h1) * 100) : 0;
    // The half-window mean LAGS where the ad is NOW — a steady decliner can
    // average 1.65 while sitting at 1.2 today. Classify + runway off the
    // recent level (last 14 active days), trend off the halves.
    // The confirmation window is capped at HALF the run: on a run under 28 active
    // days a flat 14-day window reaches back into the first half, so the trend
    // would be confirmed against itself.
    const recentWindowDays = Math.max(1, Math.min(14, Math.floor(days.length / 2)));
    const recentDates = new Set(days.slice(-recentWindowDays));
    const recentRows = sorted.filter((r) => recentDates.has(r.date));
    const recent = rate(recentRows);
    const recentDays = recentDates.size;
    const recentDailySpend = recentRows.reduce((s, r) => s + r.spend, 0) / recentDays;
    const spend30d = list
      .filter((r) => windowEndMs - Date.parse(r.date) < 30 * 86_400_000)
      .reduce((s, r) => s + (r.spend || 0), 0);
    // An ad whose last spending day is more than 30 days back has a REAL
    // spend_30d of 0. The date is what makes that readable next to a run rate.
    const spentDates = sorted.filter((r) => (r.spend || 0) > 0).map((r) => r.date);
    const lastSpendDate = spentDates.length ? spentDates[spentDates.length - 1]! : null;
    const daysSinceLastSpend = lastSpendDate
      ? Math.round((windowEndMs - Date.parse(lastSpendDate)) / 86_400_000)
      : null;
    const stillSpending = daysSinceLastSpend != null && daysSinceLastSpend <= 6;
    const freqVals = list.map((r) => r.frequency).filter((f): f is number => typeof f === 'number' && f > 0);
    const avgFreq = freqVals.length ? r2(freqVals.reduce((s, f) => s + f, 0) / freqVals.length) : null;

    // Classification — TREND-driven, never age-driven (the binding rule). The
    // class words may not claim more than the rule proved: an ad 25%+ down that
    // the fatiguing test refused is `declining_unconfirmed`, never `stable`, and
    // a young ad is `too_young_to_call` rather than `fresh` (which read as a
    // verdict on the creative, so a 17-day ad whose cost per lead went 16.68 →
    // 23.65 was filed as healthy).
    const declining = trendPct <= -25;
    const nearFloor = mode === 'roas' ? recent < breakevenRoas * 1.5 : false;
    const tooYoung = ageDays < 21;
    const cplFirstHalf = costPer(sorted.slice(0, mid));
    const cplLast14 = costPer(recentRows);
    // "Stable" is a claim about where the ad is NOW, so it is earned on the
    // confirmation window against the first half, not on the halves alone.
    // A first half with no result to price is nothing to have declined from.
    const holdsRecent =
      mode === 'roas'
        ? h1 <= 0 || recent >= h1 * 0.75
        : cplFirstHalf == null
          ? cplLast14 != null
          : cplLast14 == null
            ? false
            : cplLast14 <= cplFirstHalf * 1.25;
    let cls: FatigueAd['class'];
    if (declining && !tooYoung && (nearFloor || trendPct <= -40)) cls = 'fatiguing';
    else if (declining) cls = 'declining_unconfirmed';
    else if (tooYoung) cls = 'too_young_to_call';
    else if (ageDays >= 60 && trendPct >= -15) cls = 'evergreen';
    else cls = holdsRecent ? 'stable' : 'declining_unconfirmed';

    // Runway: only for ROAS mode, only when genuinely declining toward
    // breakeven — extrapolated from the RECENT level at the observed rate.
    let runway: number | null = null;
    if (mode === 'roas' && declining && recent > breakevenRoas && ageDays > 0) {
      const perDay = (h2 - h1) / (ageDays / 2); // decline rate across the two halves
      if (perDay < 0) runway = Math.max(1, Math.round((recent - breakevenRoas) / -perDay));
    }

    // The frequency-aware kill guard (binding): below breakeven + LOW frequency
    // is likely true acquisition — never recommend killing on ROAS alone.
    const belowBreakeven = mode === 'roas' && recent < breakevenRoas;
    const lowFreqGuard = belowBreakeven && avgFreq !== null && avgFreq < 1.5;

    ads.push({
      ad_id: adId,
      ad_name: adName,
      spend: Math.round(spend),
      in_window_age_days: ageDays,
      kpi_first_half: r2(h1),
      kpi_second_half: r2(h2),
      kpi_recent: r2(recent),
      trend_pct: trendPct,
      avg_frequency: avgFreq,
      class: cls,
      days_to_breakeven: runway,
      low_frequency_acquisition_guard: lowFreqGuard,
      recent_daily_spend: Math.round(recentDailySpend),
      spend_30d: Math.round(spend30d),
      cpl_first_half: cplFirstHalf,
      cpl_last_14: cplLast14,
      last_spend_date: lastSpendDate,
      days_since_last_spend: daysSinceLastSpend,
      still_spending: stillSpending,
      confirmation_days: recentDays,
    });
  }

  // The rows are ranked by the figure the row SHOWS (last-30-day spend), so a
  // list labelled "the most spend" is true of its own order; the 90-day sum only
  // breaks ties, which is what puts the stopped ads at the bottom.
  ads.sort((a, b) => b.spend_30d - a.spend_30d || b.spend - a.spend);
  const spendOf = (cls: FatigueAd['class']) => ads.filter((a) => a.class === cls).reduce((s, a) => s + a.spend, 0);
  const assessedSpend = ads.reduce((s, a) => s + a.spend, 0);
  const fatiguingShare = pct(spendOf('fatiguing'), assessedSpend);
  const evergreenShare = pct(spendOf('evergreen'), assessedSpend);
  const fatiguing = ads.filter((a) => a.class === 'fatiguing');
  const unconfirmed = ads.filter((a) => a.class === 'declining_unconfirmed');
  const evergreens = ads.filter((a) => a.class === 'evergreen');
  const soonest = fatiguing.filter((a) => a.days_to_breakeven != null).sort((a, b) => a.days_to_breakeven! - b.days_to_breakeven!)[0];
  // Names the denominator wherever a share is printed: "1.3% of assessed spend"
  // left the reader guessing whether it was the account's spend or ours.
  const assessedWord = `the last 90 days' spend behind the ${ads.length} ad${ads.length === 1 ? '' : 's'} we could read`;
  /** An ad with no last-30-day spend states its last spending day instead of a zero. */
  const spendNote = (ad: FatigueAd): string =>
    ad.spend_30d > 0
      ? ''
      : ad.last_spend_date
        ? ` (nothing in the last 30 days, it last spent on ${ad.last_spend_date})`
        : ` (nothing in the last 30 days)`;
  /** The two levels behind a decline, in the account's own grammar. */
  const levelsOf = (ad: FatigueAd): string => {
    if (mode === 'roas') return ` at ${ad.kpi_first_half.toFixed(2)}× then ${ad.kpi_recent.toFixed(2)}×`;
    if (ad.cpl_first_half != null && ad.cpl_last_14 != null)
      return ` at ${moneyExact(ad.cpl_first_half, currency)} then ${moneyExact(ad.cpl_last_14, currency)}`;
    if (ad.cpl_last_14 == null) return `, which booked no result at all in its last ${ad.confirmation_days} days`;
    return ` at ${moneyExact(ad.cpl_last_14, currency)} now`;
  };

  const kpiWord = mode === 'roas' ? 'ROAS' : 'results per spend';
  // Attribution rule (founder-sim debt, 2026-07-04): when the owner gave us
  // their gross margin, the breakeven line is THEIRS — say so wherever it's
  // cited. Without a margin, 1.0× stays the honest default with the honest
  // caveat that the true line is higher.
  const breakevenWord = grossMarginPct != null && breakevenRoas > 1.0 ? `its ${breakevenRoas}× breakeven` : 'breakeven';
  // The fatiguing set's CURRENT run-rate — the honest "money riding on declining
  // creative" number (pro-trust layer). A run-rate, not a loss claim, and only
  // the ads that are actually still spending: an ad that stopped six weeks ago
  // still reports a run rate over its own last active days, and summing those
  // into a "right now" figure printed 569/day on a 300/day account.
  const fatiguingDailyBurn = Math.round(
    fatiguing.filter((a) => a.still_spending).reduce((s, a) => s + a.recent_daily_spend, 0),
  );
  // The list the page prints as "what is dragging the most spend". A guarded
  // acquisition ad is not dragging anything, an ad with no spend in the last 30
  // days is not dragging anything NOW, and the ranking is real 30-day spend.
  const dragging: DraggingAd[] = fatiguing
    .filter((a) => !a.low_frequency_acquisition_guard && a.spend_30d > 0)
    .sort((a, b) => b.spend_30d - a.spend_30d)
    .slice(0, 3)
    .map((a) => ({
      ad_id: a.ad_id,
      ad_name: a.ad_name,
      spend_30d: a.spend_30d,
      recent_daily_spend: a.recent_daily_spend,
      stat: draggingStat(a, mode, currency),
      why: draggingWhy(a, mode, currency),
    }));

  const summaryParts: string[] = [];
  if (fatiguing.length) {
    // Naming the ads is the point: "1 evergreen winner (35.7% of assessed
    // spend). Protect these" told a reader nothing they could act on.
    const biggestFatiguing = fatiguing[0]!;
    summaryParts.push(
      `${fatiguing.length} ad${fatiguing.length > 1 ? 's' : ''} carrying ${fatiguingShare}% of ${assessedWord} ` +
      `${fatiguing.length > 1 ? 'are' : 'is'} genuinely fatiguing (${kpiWord} down 25%+ from the first half of its run to the second)` +
      (fatiguing.length > 1 ? `, the biggest being "${biggestFatiguing.ad_name}"` : `: "${biggestFatiguing.ad_name}"`) +
      spendNote(biggestFatiguing) +
      (soonest?.days_to_breakeven && soonest.days_to_breakeven > 1 ? `; at the current decline "${soonest.ad_name}" crosses ${breakevenWord} in roughly ${soonest.days_to_breakeven} days` : soonest?.days_to_breakeven === 1 ? `; at the current decline "${soonest.ad_name}" crosses ${breakevenWord} within a day` : '') + '.' +
      (fatiguingDailyBurn > 0 ? ` Right now ≈${money(fatiguingDailyBurn, currency)}/day runs on this declining set, and that is the budget the replacements inherit. Each daily figure is that ad's own average while it was running.` : ''),
    );
  } else {
    summaryParts.push(`No ad with meaningful spend shows a confirmed fatigue pattern right now (${kpiWord} trend, not age: long-running ads that still hold their number don't count).`);
  }
  // The split, stated plainly, so the chart's colours and the verdict agree.
  // "1 evergreen, everything else stable" hid the ads the rule had refused to
  // clear: a 25%+ decline the confirmation test would not confirm is not stable.
  if (unconfirmed.length) {
    const biggestUnconfirmed = unconfirmed[0]!;
    summaryParts.push(
      (fatiguing.length
        ? `${fatiguing.length} confirmed fatiguing; ${unconfirmed.length} more ${unconfirmed.length > 1 ? 'are' : 'is'} declining `
        : `Nothing is confirmed fatiguing; ${unconfirmed.length} ad${unconfirmed.length > 1 ? 's are' : ' is'} declining `) +
      `but too young or too thin to confirm; ` +
      `the biggest of those is "${biggestUnconfirmed.ad_name}"${levelsOf(biggestUnconfirmed)}${spendNote(biggestUnconfirmed)}.`,
    );
  }
  if (evergreens.length) {
    const biggestEvergreen = evergreens[0]!;
    summaryParts.push(
      `${evergreens.length} evergreen winner${evergreens.length > 1 ? 's' : ''} (${evergreenShare}% of ${assessedWord}), the biggest "${biggestEvergreen.ad_name}", running 60+ days with the number holding. Protect these; do not "refresh" them.`,
    );
  }
  // A separate class of ad and a separate sentence: these never came down from
  // anywhere, so calling them fatiguing would be wrong in both directions.
  const deadSpend = deadOnArrival.reduce((s, a) => s + a.spend, 0);
  if (deadOnArrival.length) {
    const biggestDead = [...deadOnArrival].sort((a, b) => b.spend - a.spend)[0]!;
    summaryParts.push(
      `${deadOnArrival.length} ad${deadOnArrival.length > 1 ? 's' : ''} never found traction: ${deadOnArrival.length > 1 ? 'each ran' : 'it ran'} for at least ${DEAD_ON_ARRIVAL_MIN_DAYS} days, ` +
        `never got past ${money(assessmentFloor, currency)} of spend and never produced a measured result${deadOnArrival.length > 1 ? `, ${money(deadSpend, currency)} between them` : ''}. ` +
        `The biggest is "${biggestDead.ad_name}" at ${money(biggestDead.spend, currency)} over ${biggestDead.age_days} days. That is a different problem from fatigue: these never got going.`,
    );
  }
  if (attentionWithoutAction.length) {
    const worst = [...attentionWithoutAction].sort((a, b) => b.spend - a.spend)[0]!;
    summaryParts.push(
      `${attentionWithoutAction.length} ad${attentionWithoutAction.length > 1 ? 's were' : ' was'} watched and not clicked: "${worst.ad_name}" got ${worst.video_plays.toLocaleString('en-US')} three-second plays on ` +
        `${worst.impressions.toLocaleString('en-US')} impressions (${worst.play_rate_pct}%) and ${worst.link_clicks} link click${worst.link_clicks === 1 ? '' : 's'} (${worst.click_rate_pct}%), on ${money(worst.spend, currency)} of spend. ` +
        `People are watching it and doing nothing, so the opening works and the ask does not.`,
    );
  }

  // The style-guide clause only exists when there IS an evergreen list: the live
  // report pointed a reader at one on an account with zero evergreen rows.
  const evergreenGuideWord = evergreens.length
    ? `, and the evergreen list is the style guide for what this account rewards`
    : '';

  const warnings: string[] = [];
  if (suppressedNoResults > 0) {
    warnings.push(
      `${suppressedNoResults} ad(s) with real spend carry no mapped result in the window (no purchases, no lead actions), so their trend is left out rather than shown as 0.00.`,
    );
  }
  const guarded = ads.filter((a) => a.low_frequency_acquisition_guard);
  if (guarded.length) {
    warnings.push(
      `${guarded.length} below-breakeven ad(s) run at low frequency (<1.5) — that pattern is usually true top-of-funnel acquisition, not waste. Don't kill on ROAS alone.`,
    );
  }

  return {
    summary: summaryParts.join(' '),
    next_step: fatiguing.length
      ? ads.some((a) => a.days_to_breakeven != null)
        ? `Brief replacements for the fatiguing ad(s) now: the runway number is the deadline${evergreenGuideWord}.`
        : `Brief replacements for the fatiguing ad(s) now, starting with "${(dragging[0] ?? fatiguing[0]!).ad_name}"${evergreenGuideWord}.`
      : unconfirmed.length
        ? `Nothing is confirmed fatiguing yet, so don't cut anything on this chapter alone. Watch "${unconfirmed[0]!.ad_name}" and re-read this in two weeks, when its confirmation window is long enough to settle it.`
        : deadOnArrival.length
          ? `Nothing is fatiguing. The decision to make is about the ${deadOnArrival.length} ad${deadOnArrival.length > 1 ? 's' : ''} that never found traction: fund one of them properly or turn ${deadOnArrival.length > 1 ? 'them' : 'it'} off, because at ${money(assessmentFloor, currency)} nothing can be learned either way.`
          : attentionWithoutAction.length
            ? `Nothing is fatiguing. Rework the ask on "${attentionWithoutAction[0]!.ad_name}": people are watching it and not clicking, so the hook is doing its job and the rest of the ad is not.`
            : `Nothing to refresh on trend. Re-check in 30 days: the runway math only means something when the decline is real.`,
    data: {
      window_days: 90,
      kpi_mode: mode,
      assessed_ads: ads.length,
      /** The denominator under every share in this section: the 90-day spend of the assessed ads. */
      assessed_spend: Math.round(assessedSpend),
      // Every `recent_daily_spend` and the burn are averages over each ad's own
      // ACTIVE days, so they do not sum to the account's calendar spend rate and
      // must never be presented as if they did.
      daily_basis: 'active_days',
      sorted_by: 'spend_30d',
      ads_shown: Math.min(20, ads.length),
      // An account with no purchase revenue has no breakeven and no margin line,
      // so neither figure is emitted for it (the scatter does the same).
      breakeven_roas: mode === 'roas' ? breakevenRoas : undefined,
      gross_margin_pct: mode === 'roas' ? (grossMarginPct ?? undefined) : undefined,
      fatiguing_spend_share_pct: fatiguingShare,
      evergreen_spend_share_pct: evergreenShare,
      fatiguing_count: fatiguing.length,
      declining_unconfirmed_count: unconfirmed.length,
      evergreen_count: evergreens.length,
      fatiguing_daily_burn: fatiguingDailyBurn,
      currency: currency || undefined,
      ads_suppressed_no_results: suppressedNoResults || undefined,
      // A 25%+ decline the confirmation test could not confirm is still a
      // finding: the section that reports one carries an action row. So is an ad
      // that never got going, and so is one people watch without clicking.
      signal:
        fatiguing.length > 0 ||
        unconfirmed.length > 0 ||
        deadOnArrival.length > 0 ||
        attentionWithoutAction.length > 0,
      /** The floor an ad had to clear to be assessed at all, in the account's currency. */
      assessment_floor: Math.round(assessmentFloor),
      never_found_traction_count: deadOnArrival.length,
      never_found_traction_spend: Math.round(deadSpend),
      never_found_traction: deadOnArrival.sort((a, b) => b.spend - a.spend).slice(0, 10),
      attention_without_action_count: attentionWithoutAction.length,
      attention_without_action: attentionWithoutAction.sort((a, b) => b.spend - a.spend).slice(0, 10),
      dragging,
      dragging_note: dragging.length
        ? undefined
        : 'No ad clears the bar as dragging spend once the low-frequency acquisition ads are excluded. An ad with no spend in the last 30 days is not dragging anything now, so it is not on this list either. Budget concentration is covered in the concentration and budget chapters.',
      ads: ads.slice(0, 20),
    },
    warnings: warnings.length ? warnings : undefined,
    derivation:
      `For every ad with 10+ active days and real spend in the last 90 days, we split its run into a first and second half ` +
      `and compared ${kpiWord} between them — a 25%+ drop that also holds in the last 14 active days reads as fatigue. ` +
      `Age alone never flags an ad: old creative whose number still holds is evergreen and gets protected. ` +
      `A 25%+ drop we cannot yet confirm (the run is under 21 days, or its confirmation window got fewer than 14 days) ` +
      `is reported as declining and unconfirmed, never as stable and never as a reason to cut. ` +
      (mode === 'roas'
        ? grossMarginPct != null && breakevenRoas > 1.0
          ? `Breakeven line = ${breakevenRoas}× ROAS — your breakeven at the ${grossMarginPct}% gross margin you gave us (1 ÷ margin); runways and below-breakeven calls are measured against your line, not a generic 1.0×. `
          : breakevenRoas > 1.0
            ? `Breakeven line = ${breakevenRoas}× ROAS, as set for this account. `
            : `Breakeven line = 1.0× ROAS — the honest default when we don't know your gross margin; your true breakeven is higher (roughly 1 ÷ gross margin), so treat these runways as optimistic. `
        : '') +
      (ads.some((a) => a.days_to_breakeven != null)
        ? `The runway extrapolates the observed per-day decline from the ad's last-14-day level down to breakeven — a deadline estimate, not a guarantee. `
        : '') +
      `The daily figure is each fatiguing ad's average spend over its own last 14 ACTIVE days, summed across the ones still spending ` +
      `(half its run when it has been live under 28 days). Because each one is that ad's own average while it was running, these ` +
      `figures do not add up to the account's daily spend and are not meant to. ` +
      `Rows are ranked by real last-30-day spend, the figure each row shows, and an ad that spent nothing in those 30 days states its last spending day instead. ` +
      `The dragging list ranks the fatiguing ads that are NOT flagged as low-frequency acquisition, and still spending, by their real last-30-day spend. ` +
      `Separately, every ad UNDER that assessment floor of ${money(assessmentFloor, currency)} was checked for one thing the trend read cannot see: at least ${DEAD_ON_ARRIVAL_MIN_DAYS} days between its first and last day, ` +
      `spend that never cleared the floor, and no measured result at all. Those are reported as never having found traction, which is a different finding from a number coming down.` +
      (attentionWithoutAction.length > 0
        ? ` The watched-and-not-clicked read compares each ad's three-second plays against its link clicks over the same impressions, and only names an ad past ${ATTENTION_MIN_IMPRESSIONS.toLocaleString('en-US')} impressions ` +
          `with plays on ${Math.round(ATTENTION_MIN_PLAY_RATE * 100)}% of them or more and link clicks on ${ATTENTION_MAX_CLICK_RATE * 100}% or fewer.`
        : ''),
  };
}

// ---------------------------------------------------------------------------
// 2.5 Budget scatter — spend × return per ad (the Lumira §01 hero visual)
//
// One dot per ad: x = 30-day spend, y = 30-day ROAS, size = avg frequency.
// The dot's COLOUR is the existing fatigue diagnosis, NOT a fresh 30-day
// re-classification — so the "move it" (red) set is exactly the unguarded
// fatiguing ads whose burn the fatigue chapter already posts. That is the
// binding anti-double-count contract: the scatter is a VIEW of money counted
// once in the fatigue chapter, never a second tally. It posts a stat kicker
// (the starved-winner contrast), never a leak.
// ---------------------------------------------------------------------------

export interface ScatterDot {
  ad_id: string;
  ad_name: string;
  spend_30d: number;
  /** ROAS over the last 30 days (null in cost-per-result mode). */
  roas_30d: number | null;
  /** Cost per result over 30 days (cpr mode; null in ROAS mode). */
  cpr_30d: number | null;
  avg_frequency: number | null;
  spend_share_pct: number;
  /** Colour class — driven by the fatigue diagnosis (trend), never age/position. */
  klass: 'move' | 'acquisition' | 'evergreen' | 'neutral';
  /** Gold-ring annotation: a strong ad getting a small share of budget. */
  starved: boolean;
}

/** A dot needs enough spend to be worth reading — noise dots pollute the field. */
export const SCATTER_FLOOR_CAP = 1_000;

/** A cost target the OWNER stated. Cited as theirs, never as our estimate. */
export interface CostTarget {
  /** The metric they named (cpl, cpa). Decides the noun, never the math. */
  metric: string;
  value: number;
}

/**
 * The account's own conversion grammar, for the words and the derived labels.
 * An account with no purchase revenue has no ROAS and no breakeven line, so
 * "good" can only mean cheaper than the owner's stated target or than the
 * account's own average cost per result. Both optional: without either, the
 * chart states the spread and claims no winner.
 */
export interface ScatterLens {
  /** What one result is called here: 'lead' on a lead-gen account. */
  resultNoun?: string;
  costTarget?: CostTarget | null;
}

export function computeBudgetScatter(
  rows30: PackAdRow[],
  fatigueAds: Array<Pick<FatigueAd, 'ad_id' | 'class' | 'low_frequency_acquisition_guard'>>,
  breakevenRoas = 1.0,
  currency = '',
  grossMarginPct: number | null = null,
  lens: ScatterLens = {},
): PackSection & { data: { dots: ScatterDot[] } & Record<string, unknown> } {
  const mode = kpiMode(rows30);
  const byAd = new Map<string, { ad_id: string; name: string; spend: number; value: number; results: number; freqs: number[] }>();
  let total = 0;
  for (const r of rows30) {
    total += r.spend || 0;
    const a = byAd.get(r.ad_id) ?? { ad_id: r.ad_id, name: r.ad_name ?? r.ad_id, spend: 0, value: 0, results: 0, freqs: [] };
    a.spend += r.spend || 0;
    a.value += r.purchase_value || 0;
    a.results += resultOf(r);
    if (r.ad_name) a.name = r.ad_name;
    if (typeof r.frequency === 'number' && r.frequency > 0) a.freqs.push(r.frequency);
    byAd.set(r.ad_id, a);
  }

  const fatByAd = new Map(fatigueAds.map((f) => [f.ad_id, f]));
  const classOf = (adId: string): ScatterDot['klass'] => {
    const f = fatByAd.get(adId);
    if (!f) return 'neutral';
    if (f.class === 'fatiguing') return f.low_frequency_acquisition_guard ? 'acquisition' : 'move';
    if (f.class === 'evergreen') return 'evergreen';
    return 'neutral';
  };

  // Dot floor: enough spend to read. Capped-relative like the fatigue floor.
  const floor = cappedFloor(100, total * 0.005, SCATTER_FLOOR_CAP);
  const all = [...byAd.values()];
  const plotted = all.filter((a) => a.spend >= floor).sort((a, b) => b.spend - a.spend);
  // In cost-per-result mode a dot with no mapped result would sit at 0.00 and
  // read as a free lead. Those ads get no dot, and the count says so.
  const readable = mode === 'cpr' ? plotted.filter((a) => a.results > 0) : plotted;
  const suppressedNoResults = plotted.length - readable.length;

  const dots: ScatterDot[] = readable.map((a) => {
    const roas = mode === 'roas' ? r2(div(a.value, a.spend)) : null;
    const cpr = mode === 'cpr' ? r2(div(a.spend, a.results)) : null;
    const avgFreq = a.freqs.length ? r2(a.freqs.reduce((s, f) => s + f, 0) / a.freqs.length) : null;
    return {
      ad_id: a.ad_id,
      ad_name: a.name,
      spend_30d: Math.round(a.spend),
      roas_30d: roas,
      cpr_30d: cpr,
      avg_frequency: avgFreq,
      spend_share_pct: pct(a.spend, total),
      klass: classOf(a.ad_id),
      starved: false,
    };
  });

  // What one result is called here, and what "good" is measured against. On a
  // cost-per-result account the line is the owner's own stated target, else the
  // account's own average. There is no breakeven and no 1.0x line to borrow.
  const resultNoun = lens.resultNoun?.trim() || 'result';
  const costTarget = lens.costTarget ?? null;
  const plottedResults = readable.reduce((s, a) => s + a.results, 0);
  const plottedSpend = readable.reduce((s, a) => s + a.spend, 0);
  const cprAverage = mode === 'cpr' && plottedResults > 0 ? r2(div(plottedSpend, plottedResults)) : null;
  const cprLine = mode === 'cpr' ? (costTarget?.value ?? cprAverage) : null;
  const cprLineSource: 'owner_target' | 'account_average' | null =
    mode !== 'cpr' || cprLine == null ? null : costTarget ? 'owner_target' : 'account_average';
  const cprLineWord =
    cprLine == null
      ? `the account's own spread`
      : cprLineSource === 'owner_target'
        ? `your stated target of ${money(cprLine, currency)} per ${resultNoun}`
        : `this account's own average of ${money(cprLine, currency)} per ${resultNoun}`;

  // Starved winner: an ad doing clearly better than the line on a small share of
  // budget. In ROAS mode "clearly better" is 2x the breakeven line; in cost-per-
  // result mode it is 25% under the line, and an average needs 4 plotted ads
  // behind it before it can call anything starved.
  const shares = dots.map((d) => d.spend_share_pct).sort((x, y) => x - y);
  const medianShare = shares.length ? shares[Math.floor(shares.length / 2)]! : 0;
  let starvedBest: ScatterDot | null = null;
  const cprLineIsReadable = cprLine != null && (cprLineSource === 'owner_target' || dots.length >= 4);
  for (const d of dots) {
    if (d.klass === 'move' || d.klass === 'acquisition') continue; // a laggard isn't "starved"
    if (d.spend_share_pct > medianShare) continue;
    if (mode === 'roas') {
      if (d.roas_30d != null && d.roas_30d >= breakevenRoas * 2) {
        d.starved = true;
        if (!starvedBest || (d.roas_30d ?? 0) > (starvedBest.roas_30d ?? 0)) starvedBest = d;
      }
    } else if (cprLineIsReadable && d.cpr_30d != null && d.cpr_30d <= cprLine! * 0.75) {
      d.starved = true;
      if (!starvedBest || (d.cpr_30d ?? Infinity) < (starvedBest.cpr_30d ?? Infinity)) starvedBest = d;
    }
  }

  // The heaviest laggard — the most budget sitting on an ad doing worse than the
  // line, or already flagged as moving — is the honest contrast to the winner.
  const laggards = dots
    .filter((d) =>
      d.klass === 'move' ||
      d.klass === 'acquisition' ||
      (mode === 'roas'
        ? d.roas_30d != null && d.roas_30d < breakevenRoas
        : cprLineIsReadable && d.cpr_30d != null && d.cpr_30d >= cprLine! * 1.25),
    )
    .sort((a, b) => b.spend_30d - a.spend_30d);
  const heaviestLaggard = laggards[0] ?? null;

  const moveCount = dots.filter((d) => d.klass === 'move').length;
  const acqCount = dots.filter((d) => d.klass === 'acquisition').length;
  const dropped = all.length - plotted.length;
  // A red dot can only be claimed when there IS one. The live report said "the
  // red dots are your past-peak ads" on a chart whose only flagged ad sat under
  // the plotting floor, so the reader looked for a dot that was never drawn.
  const plottedIds = new Set(dots.map((d) => d.ad_id));
  const flaggedOffChart = fatigueAds
    .filter((f) => f.class === 'fatiguing' && !f.low_frequency_acquisition_guard && !plottedIds.has(f.ad_id))
    .map((f) => f.ad_id);
  const offChartReason = (adId: string): 'no_spend_30d' | 'below_plot_floor' | 'no_mapped_result' => {
    const a = byAd.get(adId);
    if (!a || a.spend <= 0) return 'no_spend_30d';
    if (a.spend < floor) return 'below_plot_floor';
    return 'no_mapped_result';
  };
  const offChartReasons = [...new Set(flaggedOffChart.map(offChartReason))];
  const offChartWord = (): string => {
    const many = flaggedOffChart.length > 1;
    const subject = `${flaggedOffChart.length === 1 ? 'The one ad' : `The ${flaggedOffChart.length} ads`} flagged past peak in the fatigue chapter`;
    if (offChartReasons.length > 1)
      return `${subject} ${many ? 'get' : 'gets'} no dot here: between them they spend too little in the last 30 days to plot or carry no mapped result.`;
    if (offChartReasons[0] === 'no_spend_30d')
      return `${subject} ${many ? 'have' : 'has'} no spend at all in the last 30 days, so ${many ? 'they get' : 'it gets'} no dot here.`;
    if (offChartReasons[0] === 'no_mapped_result')
      return `${subject} ${many ? 'carry' : 'carries'} no mapped result in the last 30 days, so a cost per ${resultNoun} cannot be plotted for ${many ? 'them' : 'it'}.`;
    return `${subject} ${many ? 'spend' : 'spends'} too little in the last 30 days to plot, so no dot on this chart is red.`;
  };
  const cprValues = dots.map((d) => d.cpr_30d).filter((v): v is number => v != null).sort((x, y) => x - y);
  const spreadRatio =
    cprValues.length >= 2 && cprValues[0]! > 0 ? r2(cprValues[cprValues.length - 1]! / cprValues[0]!) : null;
  const wideSpread = spreadRatio != null && spreadRatio >= 1.5;

  // Caption contrast — "your best ad gets £X, a fraction of what your worst spends".
  let contrast: string | null = null;
  if (starvedBest && heaviestLaggard && starvedBest.ad_id !== heaviestLaggard.ad_id && starvedBest.spend_30d > 0) {
    const ratio = heaviestLaggard.spend_30d / starvedBest.spend_30d;
    const ratioWord = `roughly ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× the budget on the weaker ad`;
    if (ratio >= 1.5 && mode === 'roas') {
      contrast =
        `"${starvedBest.ad_name}" returns ${starvedBest.roas_30d}× on ${money(starvedBest.spend_30d, currency)} of spend, ` +
        `while "${heaviestLaggard.ad_name}" is ${heaviestLaggard.roas_30d != null ? `at ${heaviestLaggard.roas_30d}×` : 'below breakeven'} on ` +
        `${money(heaviestLaggard.spend_30d, currency)} — ${ratioWord}.`;
    } else if (ratio >= 1.5) {
      contrast =
        `"${starvedBest.ad_name}" buys a ${resultNoun} for ${money(starvedBest.cpr_30d ?? 0, currency)} on ${money(starvedBest.spend_30d, currency)} of spend, ` +
        `while "${heaviestLaggard.ad_name}", the heaviest spender doing worse than that line, pays ${money(heaviestLaggard.cpr_30d ?? 0, currency)} per ${resultNoun} on ` +
        `${money(heaviestLaggard.spend_30d, currency)} — ${ratioWord}.`;
    }
  }

  const breakevenWord = grossMarginPct != null && breakevenRoas > 1.0 ? `your ${breakevenRoas}× breakeven` : 'the 1.0× line';
  // The legend names only the colours actually on this chart: a "red = past peak"
  // line over a chart with no red dot sends the reader hunting for it.
  const colourLegendParts = [
    ...(moveCount > 0 ? ['red = past-peak and still spending'] : []),
    ...(acqCount > 0 ? ['blue = below breakeven but low-frequency (acquisition, not waste)'] : []),
    ...(dots.some((d) => d.klass === 'evergreen') ? ['olive = evergreen'] : []),
  ];
  const colourLegend = colourLegendParts.length
    ? colourLegendParts.join(', ')
    : `no plotted ad carries a fatigue verdict, so no dot here is coloured`;
  const summaryParts: string[] = [];
  if (mode === 'roas') {
    summaryParts.push(
      `Each dot is one ad, placed by its last-30-day spend (left→right) against its ROAS (bottom→top); the dashed line is ${breakevenWord}.`,
    );
  } else {
    summaryParts.push(
      `Each dot is one ad, placed by its last-30-day spend (left→right) against its cost per ${resultNoun} (bottom→top, lower is better)` +
        (cprLine != null ? `; the dashed line is ${cprLineWord}` : '') + `.`,
    );
    if (cprValues.length >= 2) {
      // Name the SET: "the worst cost per lead in the set" was read as the whole
      // account, when it is the dearest of the ads big enough to plot.
      summaryParts.push(
        `Across the ${dots.length} biggest spenders of the last 30 days (the ads with enough spend to plot) the cost per ${resultNoun} ` +
          `runs from ${money(cprValues[0]!, currency)} to ${money(cprValues[cprValues.length - 1]!, currency)}.`,
      );
    }
  }
  // Fatigue-driven, so it holds in either grammar: the colour is the trend, not
  // the return. The acquisition guard is a ROAS-mode read and stays there.
  if (moveCount > 0)
    summaryParts.push(`${moveCount} ad${moveCount === 1 ? '' : 's'} sit${moveCount === 1 ? 's' : ''} in the danger zone — past peak and still spending (the same ${moveCount === 1 ? 'one' : 'ones'} flagged in the fatigue chapter).`);
  else if (flaggedOffChart.length > 0) summaryParts.push(offChartWord());
  if (mode === 'roas' && acqCount > 0)
    summaryParts.push(`${acqCount} below-breakeven ad${acqCount === 1 ? '' : 's'} run at low frequency — that reads as acquisition, not waste, so ${acqCount === 1 ? "it's" : "they're"} marked separately.`);
  if (contrast) summaryParts.push(contrast);

  const next_step = starvedBest
    ? mode === 'roas'
      ? `Shift budget toward the starved winners the chart circles — "${starvedBest.ad_name}" is earning well above the line on a small share of spend, so it has room to take more before it saturates.`
      : `Shift budget toward the ads the chart circles — "${starvedBest.ad_name}" is buying a ${resultNoun} for ${money(starvedBest.cpr_30d ?? 0, currency)} against ${cprLineWord}, on a small share of spend.`
    : moveCount > 0
      ? `Move budget off the danger-zone ads and into the ones sitting high on the chart — the fatigue chapter has the deadline.`
      : mode === 'cpr'
        ? cprValues.length >= 2
          ? `Among those ${dots.length} biggest spenders, move budget from the ads near ${money(cprValues[cprValues.length - 1]!, currency)} per ${resultNoun} toward the ones near ${money(cprValues[0]!, currency)}, one step at a time, and re-read the chart in two weeks.`
          : `Keep the current split; there are too few plotted ads to move budget between on this chart alone.`
        : `No ad on this chart is both clearly above ${breakevenWord} and starved of budget, and none is flagged past peak, so the current split stands. Re-read it next month.`;

  return {
    summary: summaryParts.join(' '),
    next_step,
    data: {
      window_days: 30,
      kpi_mode: mode,
      // The y axis in words, so a renderer never has to guess which grammar
      // this account is in — and a purchase axis is never labelled on an
      // account that records no purchase revenue.
      y_axis: mode === 'roas' ? 'roas' : 'cost_per_result',
      y_axis_label: mode === 'roas' ? 'ROAS' : `Cost per ${resultNoun}`,
      result_noun: mode === 'cpr' ? resultNoun : undefined,
      breakeven_roas: mode === 'roas' ? breakevenRoas : undefined,
      gross_margin_pct: mode === 'roas' ? (grossMarginPct ?? undefined) : undefined,
      cpr_average: cprAverage ?? undefined,
      cpr_target: mode === 'cpr' && costTarget ? { metric: costTarget.metric, value: costTarget.value, source: 'owner' } : undefined,
      cpr_line: cprLine ?? undefined,
      cpr_line_source: cprLineSource ?? undefined,
      currency: currency || undefined,
      total_spend: Math.round(total),
      ads_plotted: dots.length,
      ads_dropped_thin: dropped,
      /** What the plotted set IS, for any label that compares within it. */
      plotted_set_label: `the ${dots.length} biggest spenders of the last 30 days`,
      move_count: moveCount,
      acquisition_count: acqCount,
      /** Ads the fatigue chapter flagged that have no dot here. A red-dot sentence is only true when this is empty. */
      flagged_off_chart: flaggedOffChart.length || undefined,
      flagged_off_chart_reasons: flaggedOffChart.length ? offChartReasons : undefined,
      starved_best_ad: starvedBest?.ad_name ?? undefined,
      contrast: contrast ?? undefined,
      dots_suppressed_no_results: suppressedNoResults || undefined,
      spread_ratio: spreadRatio ?? undefined,
      // A wide spread IS a finding: with the dearest plotted ad costing half
      // again what the cheapest does, there is money to move whatever the
      // fatigue classes say. The chart used to post signal false under a next
      // step that told the reader exactly which way to move it.
      signal: moveCount > 0 || acqCount > 0 || !!starvedBest || wideSpread,
      dots: dots.slice(0, 40),
    },
    warnings: suppressedNoResults > 0
      ? [
          `${suppressedNoResults} ad(s) that cleared the spend floor carry no mapped result, so they get no dot: a cost per ${resultNoun} cannot be computed for them.`,
        ]
      : undefined,
    derivation:
      mode === 'roas'
        ? `We summed each ad's spend and revenue over the last 30 days and plotted spend against ROAS, sizing each dot by its average frequency. ` +
          `The colour is the SAME fatigue read from the chapter above: ${colourLegend}. ` +
          `Gold rings mark ads earning well above ${breakevenWord} on a small slice of budget. ` +
          (grossMarginPct != null && breakevenRoas > 1.0
            ? `The dashed line is ${breakevenRoas}× — your breakeven at the ${grossMarginPct}% gross margin you gave us.`
            : `The dashed line is 1.0× — the honest default when we don't know your gross margin; your true breakeven sits higher, so dots just above the line may already be underwater after product cost.`)
        : `We summed each ad's spend and its recorded results over the last 30 days and plotted spend against cost per ${resultNoun}, sizing each dot by its average frequency. ` +
          `The colour is the SAME fatigue read from the chapter above: ${colourLegend}. ` +
          // The line is never borrowed: this account's number is what it pays
          // for a result, so it is read against the owner's own target or the
          // account's own average, and against nothing else.
          (cprLine == null
            ? `No target was given and there are too few plotted ads to average one, so the chart states the spread and calls no winner.`
            : cprLineSource === 'owner_target'
              ? `Every dot is read against your stated target of ${money(cprLine, currency)} per ${resultNoun}, and gold rings mark the ads at least 25% under it on a small slice of budget.`
              : `Every dot is read against this account's own average of ${money(cprLine, currency)} per ${resultNoun}, and gold rings mark the ads at least 25% under it on a small slice of budget.`),
  };
}

// ---------------------------------------------------------------------------
// 3. Creative cohorts by launch month (does the account live off old creative?)
// ---------------------------------------------------------------------------

/**
 * The fatigue chapter's rows, so the cadence read cannot praise a refresh
 * rhythm the account's biggest line in the budget is not getting. The live
 * report graded "a healthy refresh rhythm" in this chapter while the letter
 * above it said the top creative was aging.
 */
export interface FatigueReadForCohorts {
  ads?: Array<{ ad_name?: string; spend_30d?: number; spend?: number; class?: string }>;
}

/** The biggest current spender, when the fatigue chapter says it is on the way down. */
export function agingTopSpender(
  fatigue: FatigueReadForCohorts | undefined,
): { ad_name: string; verdict: 'fatiguing' | 'declining' } | null {
  const ads = (fatigue?.ads ?? []).filter((a) => typeof a.ad_name === 'string' && a.ad_name.length > 0);
  if (ads.length === 0) return null;
  const spendOf = (a: { spend_30d?: number; spend?: number }): number =>
    typeof a.spend_30d === 'number' ? a.spend_30d : (a.spend ?? 0);
  const top = [...ads].sort((a, b) => spendOf(b) - spendOf(a))[0]!;
  if (spendOf(top) <= 0) return null;
  if (top.class === 'fatiguing') return { ad_name: top.ad_name!, verdict: 'fatiguing' };
  if (top.class === 'declining_unconfirmed') return { ad_name: top.ad_name!, verdict: 'declining' };
  return null;
}

export function computeCohorts(
  rows180: Array<Pick<PackAdRow, 'ad_id' | 'date' | 'spend'>>,
  fatigue?: FatigueReadForCohorts,
): PackSection {
  const firstSeen = new Map<string, string>();
  for (const r of rows180) {
    const cur = firstSeen.get(r.ad_id);
    if (!cur || r.date < cur) firstSeen.set(r.ad_id, r.date);
  }
  const month = (d: string) => d.slice(0, 7);
  const windowStart = rows180.reduce((min, r) => (r.date < min ? r.date : min), '9999-12-31');

  // monthly spend by launch-cohort
  const byMonth = new Map<string, Map<string, number>>(); // spend month → (cohort → spend)
  for (const r of rows180) {
    const m = month(r.date);
    const launch = firstSeen.get(r.ad_id)!;
    // Ads already running in the window's first days may predate it — honest label.
    const cohort = month(launch) === month(windowStart) ? `${month(windowStart)} or earlier` : month(launch);
    const row = byMonth.get(m) ?? new Map<string, number>();
    row.set(cohort, (row.get(cohort) ?? 0) + (r.spend || 0));
    byMonth.set(m, row);
  }
  const months = [...byMonth.keys()].sort();
  const series = months.map((m) => {
    const row = byMonth.get(m)!;
    const total = [...row.values()].reduce((s, v) => s + v, 0);
    return {
      month: m,
      total_spend: Math.round(total),
      cohorts: [...row.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([cohort, spend]) => ({ cohort, spend: Math.round(spend), share_pct: pct(spend, total) })),
    };
  });

  // Freshness read on the LAST full month: share of spend on cohorts launched in that month or the one before.
  const last = series[series.length - 1];
  let freshShare = 0;
  if (last) {
    const lastM = last.month;
    const prevM = months.length > 1 ? months[months.length - 2]! : lastM;
    freshShare = last.cohorts.filter((c) => c.cohort === lastM || c.cohort === prevM).reduce((s, c) => s + c.share_pct, 0);
  }
  // A share is a claim about the portfolio, not about the ad carrying the
  // money. Praising the rhythm while the biggest spender is on the way down is
  // the report contradicting itself in two chapters.
  const aging = agingTopSpender(fatigue);
  const read =
    freshShare >= 40
      ? aging
        ? `the launch cadence is there, but the ad carrying the most spend right now, "${aging.ad_name}", is on the fatigue chapter's ${aging.verdict} list, so the fresh work is not yet reaching the biggest line in the budget`
        : `a healthy refresh rhythm, and new work earns budget quickly`
      : freshShare >= 15
        ? `a modest refresh rhythm, and most budget still sits on older launches`
        : `an account living off old creative: recent launches barely take budget, which is exactly how a fatigue cliff builds`;

  // A quiet cadence has no next step: the one thing worth saying (keep going,
  // and check the old cohorts are evergreen) belongs in the same sentence as
  // the number, not in an action row the page renders as a finding.
  const quiet = freshShare >= 40;

  const baseDerivation =
    `Each ad's launch month is approximated by its first day with spend inside the ${series.length}-month window ` +
    `(ads already running when the window opens are grouped as "${month(windowStart)} or earlier" — we can't see further back). ` +
    `Each month's spend is then split by those launch cohorts; freshness = the last full month's share going to creatives launched in that month or the one before.`;

  // A read shorter than ~90 days cannot grade creative age: nearly every ad's
  // first spend day falls inside the window, so freshness trends toward 100% by
  // construction and the live report rendered that as a strength.
  const windowEnd = rows180.reduce((max, r) => (r.date > max ? r.date : max), '0000-01-01');
  const daysCovered =
    windowStart <= windowEnd ? Math.round((Date.parse(windowEnd) - Date.parse(windowStart)) / 86_400_000) + 1 : 0;
  const windowTooShort = daysCovered < 90;
  if (windowTooShort) {
    return {
      summary:
        `The ad-level read covers ${daysCovered} days, too short to judge how old this account's creative is: almost every ad in it first spent inside the window, ` +
        `so a freshness share here would read high because of the window, not because of the account. ` +
        `This chapter says something once about 90 days of ad-level history are synced.`,
      data: {
        window_months: series.length,
        window_too_short: true,
        days_covered: daysCovered,
        fresh_cohort_share_pct: r1(freshShare),
        signal: false,
        series,
      },
      derivation: `${baseDerivation} With only ${daysCovered} days of ad-level history the cohort split is still shown, but it is not graded.`,
    };
  }

  return {
    summary:
      `Of this month's spend, ${r1(freshShare)}% goes to creatives launched in the last ~2 months: ${read}. ` +
      (quiet
        ? aging
          ? `The fatigue chapter has the replacement deadline for it. `
          : `Keep this launch cadence, and use the fatigue report to confirm the older cohorts still earning budget are evergreen rather than decaying. `
        : '') +
      `The stacked view shows each month's spend split by WHEN its creatives first launched (launch month approximated by first spend day in the ${series.length}-month window).`,
    ...(quiet
      ? {}
      : {
          next_step: `Set a monthly launch quota and track this chart month over month — the fresh-cohort share should climb toward 30–40% without touching proven evergreens.`,
        }),
    data: {
      window_months: series.length,
      window_too_short: false,
      days_covered: daysCovered,
      fresh_cohort_share_pct: r1(freshShare),
      aging_top_spender: aging?.ad_name,
      // A cadence that is not reaching the biggest spender is a finding worth
      // reading even though the ask (and the deadline) belong to the fatigue
      // chapter, so the chapter is not filed as clean while its own sentence
      // names an aging top spender.
      signal: freshShare < 40 || !!aging,
      series,
    },
    derivation: baseDerivation,
  };
}

// ---------------------------------------------------------------------------
// 4. CPM / auction-pressure trend (is it the market, or your creative?)
// ---------------------------------------------------------------------------

export function computeCostTrend(accRows90: PackAccountRow[], currency = ''): PackSection {
  const sorted = [...accRows90].sort((a, b) => a.date.localeCompare(b.date));
  // weekly buckets
  const weeks = new Map<string, { spend: number; imps: number; clicks: number }>();
  for (const r of sorted) {
    const d = new Date(r.date + 'T00:00:00Z');
    const wk = new Date(d);
    wk.setUTCDate(d.getUTCDate() - d.getUTCDay()); // week starting Sunday
    const key = wk.toISOString().slice(0, 10);
    const w = weeks.get(key) ?? { spend: 0, imps: 0, clicks: 0 };
    w.spend += r.spend || 0;
    w.imps += r.impressions || 0;
    w.clicks += r.link_clicks || 0;
    weeks.set(key, w);
  }
  const series = [...weeks.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .filter(([, w]) => w.imps > 0)
    .map(([week, w]) => ({ week, cpm: r2(div(w.spend * 1000, w.imps)), ctr_link_pct: r2(pct(w.clicks, w.imps)), spend: Math.round(w.spend), impressions: w.imps }));

  if (series.length < 4) {
    return {
      summary: `Not enough weekly history to read a cost trend (${series.length} weeks with impressions). Revisit once 4+ weeks of delivery are synced.`,
      data: { series, weeks: series.length, signal: false },
      warnings: ['Thin window — cost trend suppressed.'],
    };
  }

  const firstQ = series.slice(0, Math.max(2, Math.floor(series.length / 3)));
  const lastQ = series.slice(-Math.max(2, Math.floor(series.length / 3)));
  const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
  // ONE computation owns the trend: these six figures are what the summary
  // says, what `verdict` is decided from, and what the page prints. The live
  // report printed "flat", "+6.9%" and "+23%" about the same CPM series.
  const cpmFirstRaw = avg(firstQ.map((s) => s.cpm));
  const cpmLastRaw = avg(lastQ.map((s) => s.cpm));
  const ctrFirstRaw = avg(firstQ.map((s) => s.ctr_link_pct));
  const ctrLastRaw = avg(lastQ.map((s) => s.ctr_link_pct));
  const cpmDelta = pct(cpmLastRaw - cpmFirstRaw, cpmFirstRaw);
  // With no link click recorded anywhere in the window there is no CTR read at
  // all — 0% against 0% is not "CTR held".
  const ctrReadable = ctrFirstRaw > 0;
  const ctrDelta = ctrReadable ? pct(ctrLastRaw - ctrFirstRaw, ctrFirstRaw) : 0;
  const cpmFirst = r2(cpmFirstRaw);
  const cpmLast = r2(cpmLastRaw);
  const ctrFirst = r2(ctrFirstRaw);
  const ctrLast = r2(ctrLastRaw);
  const cpmMoveWord = `${cpmDelta >= 0 ? '+' : ''}${r1(cpmDelta)}%`;
  // The page labels the chart's own endpoints while the sentence quotes the
  // thirds comparison, and the live report printed +23% CPM under a +6.8%
  // sentence. Both bases are defensible; unlabelled they read as a contradiction,
  // so BOTH are on the wire and each says what it is.
  const firstBucket = series[0]!;
  const lastBucket = series[series.length - 1]!;
  const cpmChartDelta = firstBucket.cpm > 0 ? r1(pct(lastBucket.cpm - firstBucket.cpm, firstBucket.cpm)) : null;
  const ctrChartDelta =
    firstBucket.ctr_link_pct > 0 ? r1(pct(lastBucket.ctr_link_pct - firstBucket.ctr_link_pct, firstBucket.ctr_link_pct)) : null;
  // The basis, in the words the summary uses, so the chapter and the chart label
  // can never disagree about which comparison a number came from.
  const basisWord = `averaging the first ${firstQ.length} weeks against the last ${lastQ.length}`;

  // Quantify the drift honestly (pro-trust layer): what the LAST quarter of
  // weeks' impressions actually cost vs what they'd have cost at the window's
  // opening CPM. A "same impressions, today's prices" comparison — not a loss
  // claim, and never summed with other reports' numbers.
  const recentImps = lastQ.reduce((s, w) => s + w.impressions, 0);
  const recentSpend = lastQ.reduce((s, w) => s + w.spend, 0);
  const recentWeeks = lastQ.length;
  const extraCost = Math.round(recentSpend - (recentImps * cpmFirstRaw) / 1000);
  const showsExtraCost = cpmDelta > 10 && extraCost > 0;

  // Decompose: CPM up + CTR holding = auction/market. CTR falling while CPM is
  // flat or up = the creative is earning worse auctions, which is a finding on
  // its own — the live report called a 62% CTR slide "flat, no action needed".
  // Named as a weekly average, with the when: this account's measured 30-day
  // link CTR is a different figure, and the two were being quoted side by side.
  const ctrLevels =
    `${ctrLast}% as a weekly average over the last ${lastQ.length} weeks, against ${ctrFirst}% over the first ${firstQ.length}`;
  let verdict: 'cpm_up_ctr_down' | 'ctr_down_cpm_held' | 'cpm_up_ctr_held' | 'ctr_down_cpm_soft' | 'cpm_down' | 'flat';
  let read: string;
  if (cpmDelta > 10 && ctrReadable && ctrDelta < -10) {
    verdict = 'cpm_up_ctr_down';
    read = `costs are up ${r1(cpmDelta)}% AND link CTR is down ${r1(-ctrDelta)}% (${ctrLevels}) — that combination points at the creative earning worse auctions, not just a pricier market`;
  } else if (ctrReadable && ctrDelta <= -25 && cpmDelta >= -5) {
    verdict = 'ctr_down_cpm_held';
    read =
      `link CTR is down ${r1(-ctrDelta)}% (${ctrLevels}) while CPM moved ${cpmMoveWord}. ` +
      `Delivery is not getting cheaper and the creative is earning worse auctions than it did`;
  } else if (cpmDelta > 10) {
    verdict = 'cpm_up_ctr_held';
    read =
      `CPM is up ${r1(cpmDelta)}% while link CTR held (${ctrLevels}), ` +
      `which reads as auction/market pressure, not something your creative did wrong`;
  } else if (ctrReadable && ctrDelta < -10) {
    verdict = 'ctr_down_cpm_soft';
    read = `CPM moved ${cpmMoveWord} but link CTR is down ${r1(-ctrDelta)}% (${ctrLevels}), so delivery is holding while engagement slips`;
  } else if (cpmDelta < -10) {
    verdict = 'cpm_down';
    read = `CPM is DOWN ${r1(-cpmDelta)}% across the window — the market is getting cheaper for you`;
  } else {
    verdict = 'flat';
    read = `CPM has been flat (within ±10%) across the window — cost pressure is not the story here`;
  }
  const quantified = showsExtraCost
    ? ` The last ${recentWeeks} weeks' impressions cost ≈${money(extraCost, currency)} more than the same impressions at your start-of-window CPM.`
    : '';
  const ctrCaveat = ctrReadable ? '' : ` No link click is recorded in this window, so the CTR half of this read is not available.`;

  const next_step =
    verdict === 'cpm_up_ctr_down'
      ? `Treat this as a creative problem first: fresher hooks lift CTR, better CTR buys cheaper auctions. Re-check CPM two weeks after new creative lands.`
      : verdict === 'ctr_down_cpm_held'
        ? `Rebuild the creative rather than waiting for CPM to come back down: at a ${ctrLast}% weekly-average link CTR the auction is pricing weaker engagement, not a pricier market. It ran at ${ctrFirst}% over the first ${firstQ.length} weeks of this window, so that is the recovery target. Brief new hooks this week and re-read this chart two weeks after they land.`
        : verdict === 'cpm_up_ctr_held'
          ? `Nothing to fix on your side — budget for the pricier auction or shift spend toward the placements/dayparts where CPM held.`
          : verdict === 'ctr_down_cpm_soft'
            ? `Get new hooks into test before CPM follows CTR down: falling engagement usually shows up as a pricier auction a few weeks later.`
            : verdict === 'cpm_down'
              ? `Take the cheaper auction while it lasts: the ads already clearing your bar can carry more budget at this CPM.`
              // A flat read is the section saying it found nothing, and a quiet
              // section carries no action row.
              : undefined;

  return {
    // ONE basis in the prose: the thirds averages. The chart's own endpoints
    // are a different comparison of the same series, and quoting both in one
    // paragraph read as a contradiction (+6.8% and +23% about one CPM). They
    // stay on the wire below for the chart label, which says what it is.
    summary:
      `Over the last ${series.length} weeks: ${read}.${quantified}${ctrCaveat} ` +
      `(Account level, ${basisWord}, and every percentage in this chapter is that same comparison.)`,
    ...(next_step ? { next_step } : {}),
    data: {
      series,
      // The ACTUAL bucket count — any week figure in the prose or on the page
      // is this number, never a rounded month count.
      weeks: series.length,
      verdict,
      cpm_delta_pct: r1(cpmDelta),
      ctr_delta_pct: r1(ctrDelta),
      /** What `cpm_delta_pct` / `ctr_delta_pct` are: the average of the first third of weeks against the last third. */
      delta_basis: 'thirds_average',
      delta_first_weeks: firstQ.length,
      delta_last_weeks: lastQ.length,
      /** The endpoints a chart label reads: the last plotted bucket against the first, same buckets as `series`. */
      cpm_chart_delta_pct: cpmChartDelta ?? undefined,
      ctr_chart_delta_pct: ctrChartDelta ?? undefined,
      chart_delta_basis: 'last_bucket_vs_first_bucket',
      cpm_first: cpmFirst,
      cpm_last: cpmLast,
      ctr_first: ctrFirst,
      ctr_last: ctrLast,
      ctr_readable: ctrReadable,
      cpm_extra_cost_recent: showsExtraCost ? extraCost : undefined,
      cpm_extra_cost_weeks: showsExtraCost ? recentWeeks : undefined,
      currency: currency || undefined,
      signal: verdict !== 'flat',
    },
    derivation:
      `Daily account delivery is bucketed into calendar weeks; CPM = spend ÷ impressions × 1000 per week. ` +
      `The trend compares the average of the first third of those ${series.length} weeks against the last third, for CPM and link CTR alike ` +
      `(${basisWord}). The chart's own endpoints, the last week against the first, are a different comparison of the same series ` +
      `and give a different number, so both are on the wire and each one says which comparison it came from. ` +
      `Every CTR here is a weekly average from this account's own delivery, not the 30-day figure quoted elsewhere in the report. ` +
      (showsExtraCost
        ? `The cost figure prices the last ${recentWeeks} weeks' actual impressions at the opening CPM and takes the difference — ` +
          `"same impressions, opening prices". It shares the CPM's causes (market AND creative), so we never add it to other reports' numbers.`
        : `No cost figure is quoted here: it only means something when CPM actually rose over the window.`),
  };
}

// ---------------------------------------------------------------------------
// 5. Day-of-week pattern (honest: daily granularity, not hourly)
// ---------------------------------------------------------------------------

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function computeDayOfWeek(accRows90: PackAccountRow[]): PackSection {
  const mode = kpiMode(accRows90);
  const byDow = new Map<number, { spend: number; value: number; results: number; days: number }>();
  for (const r of accRows90) {
    const dow = new Date(r.date + 'T00:00:00Z').getUTCDay();
    const b = byDow.get(dow) ?? { spend: 0, value: 0, results: 0, days: 0 };
    b.spend += r.spend || 0;
    b.value += r.purchase_value || 0;
    b.results += mode === 'roas' ? r.purchases || 0 : resultOf(r);
    b.days += 1;
    byDow.set(dow, b);
  }
  // A weekday with no mapped result gets NO kpi. Dividing spend by `results || 1`
  // used to return the weekday's raw spend under a "cost per result" label.
  const rows = [...byDow.entries()]
    .map(([dow, b]) => ({
      day: DOW[dow]!,
      spend: Math.round(b.spend),
      kpi: mode === 'roas' ? r2(div(b.value, b.spend)) : b.results > 0 ? r2(div(b.spend, b.results)) : null,
      results: Math.round(b.results * 100) / 100,
      n_days: b.days,
    }))
    .sort((a, b) => DOW.indexOf(a.day) - DOW.indexOf(b.day));

  const enough = rows.every((r) => r.n_days >= 8) && rows.length === 7;
  if (!enough) {
    return {
      summary: `Not enough history for a reliable day-of-week read (need 8+ of each weekday).`,
      next_step: `Revisit at the next audit once the window fills out.`,
      data: { kpi_mode: mode, rows, signal: false },
      warnings: ['Thin window — day-of-week pattern suppressed.'],
    };
  }

  const readable = rows.filter((r): r is typeof r & { kpi: number } => r.kpi != null);
  const suppressedDays = rows.length - readable.length;
  const kpiLabel = mode === 'roas' ? 'Meta ROAS' : 'cost per result';
  if (readable.length < 5) {
    return {
      summary:
        `${readable.length} of the 7 weekdays carry a mapped result, so there is no honest weekday ${kpiLabel} to compare. ` +
        `The spend split by weekday is still in the data.`,
      next_step: `Fix the account's result mapping (no purchases and no lead actions land on ${suppressedDays} weekdays), then re-audit.`,
      data: { kpi_mode: mode, kpi_label: kpiLabel, rows, days_suppressed_no_results: suppressedDays, signal: false },
      warnings: [`No mapped result on ${suppressedDays} of 7 weekdays — weekday ${kpiLabel} suppressed rather than divided by nothing.`],
    };
  }

  const better = (a: { kpi: number }, b: { kpi: number }) => (mode === 'roas' ? b.kpi - a.kpi : a.kpi - b.kpi);
  const ranked = [...readable].sort(better);
  const best = ranked[0]!;
  const worst = ranked[ranked.length - 1]!;
  const gap = mode === 'roas' ? pct(best.kpi - worst.kpi, worst.kpi || 1) : pct(worst.kpi - best.kpi, best.kpi || 1);
  // The SHIFT PAIR is gated by the same 25% guard the next step uses. The live
  // report advised moving budget off Saturday (17.44) onto Tuesday (17.31) — a
  // 2.5% spread — because the page built the advice from the best/worst names
  // itself. The names stay (they caption the table); the pair only exists when
  // the gap is big enough to act on.
  const shiftAdvice = gap >= 25;

  return {
    summary:
      `${best.day} is your strongest day (${kpiLabel} ${best.kpi}) and ${worst.day} the weakest (${worst.kpi}) — a ${r1(gap)}% gap, ` +
      `measured across ~13 of each weekday. Daily granularity only — Meta doesn't give us clean hourly history, so this is day-of-week, not dayparting.` +
      (suppressedDays > 0 ? ` ${suppressedDays} weekday(s) carry no mapped result and are left out of the comparison.` : ''),
    next_step:
      gap >= 25
        ? `Worth acting on: shift a slice of budget toward ${best.day}/${ranked[1]!.day} via a campaign schedule or manual weekly rhythm, and re-measure in 30 days.`
        : `The gap is modest — don't build schedule complexity for ${r1(gap)}%; just keep it on the watchlist.`,
    data: {
      kpi_mode: mode,
      kpi_label: kpiLabel,
      rows,
      best_day: best.day,
      worst_day: worst.day,
      gap_pct: r1(gap),
      /** Whether the best-to-worst spread clears the 25% guard. False = no budget-shift advice may be built from this section. */
      shift_advice: shiftAdvice,
      /** The only pair a shift may be built from, and it exists only when the guard clears. */
      shift_from_day: shiftAdvice ? worst.day : undefined,
      shift_to_day: shiftAdvice ? best.day : undefined,
      shift_withheld_reason: shiftAdvice
        ? undefined
        : `The spread between ${best.day} and ${worst.day} is ${r1(gap)}%, under the 25% we need before moving budget between weekdays. The table stands; the advice does not.`,
      days_suppressed_no_results: suppressedDays || undefined,
      signal: gap >= 25,
    },
    warnings: suppressedDays > 0
      ? [`${suppressedDays} weekday(s) carry no mapped result, so they have no ${kpiLabel} and sit outside the best/worst comparison.`]
      : undefined,
    // The daily-granularity caveat is stated ONCE, in the summary above: the
    // rendered section repeated it verbatim here.
    derivation:
      `90 days of account-level delivery grouped by weekday (~13 of each), ${kpiLabel} computed per weekday from the summed spend and ` +
      `that weekday's own ${mode === 'roas' ? 'purchases' : 'recorded results, the lead actions this account books'}. ` +
      `A weekday with no mapped result gets no ${kpiLabel} at all rather than showing its raw spend. ` +
      `Gaps under 25% stay on the watchlist rather than becoming schedule advice: below that, the strongest and weakest weekday ` +
      `are named as a fact about the table and no budget shift is proposed from them.`,
  };
}

// ---------------------------------------------------------------------------
// 6. Creative concept/angle ROAS (Dan's confirmed set — Session D)
// ---------------------------------------------------------------------------

/**
 * Group 30d spend/return by the Gemini messaging-angle tag. The join
 * (ad_id → content_hash → ai_analysis.messaging_angle) happens in the
 * orchestrator; this stays pure.
 *
 * BINDING (design spec, Francis "be smarter" fix): if the best-returning angle
 * is a discount/offer angle, do NOT say "do more discounts" — over-indexing on
 * discounts empties the funnel and trains the audience to wait. The report
 * flags it instead of scaling it.
 */
const DISCOUNT_ANGLE = /discount|offer|sale|promo|rabatt|deal|coupon|voucher|%\s*off|prozent/i;

export function computeConceptRoas(
  rows30: PackAdRow[],
  angleByAdId: Map<string, string>,
): PackSection {
  const mode = kpiMode(rows30);
  const byAngle = new Map<string, { spend: number; value: number; results: number; purchases: number; ads: Set<string> }>();
  let total = 0;
  let taggedSpend = 0;
  for (const r of rows30) {
    total += r.spend || 0;
    const angle = angleByAdId.get(r.ad_id);
    if (!angle) continue;
    taggedSpend += r.spend || 0;
    const a = byAngle.get(angle) ?? { spend: 0, value: 0, results: 0, purchases: 0, ads: new Set<string>() };
    a.spend += r.spend || 0;
    a.value += r.purchase_value || 0;
    a.results += r.results || r.leads || 0;
    a.purchases += r.purchases || 0;
    a.ads.add(r.ad_id);
    byAngle.set(angle, a);
  }
  const coverage = pct(taggedSpend, total);

  if (byAngle.size < 2 || coverage < 25) {
    return {
      summary: `Not enough angle-tagged creative to read concept performance (${coverage}% of spend has an analyzed angle tag).`,
      next_step: `Run the creative-intelligence analyzer across the account's active ads, then re-audit — this report needs the Gemini angle tags.`,
      data: { coverage_pct: coverage, angles: [], signal: false },
      warnings: ['Thin angle coverage — concept read suppressed rather than guessed.'],
    };
  }

  // Statistical floor: angles below it fold into "other" instead of pretending precision.
  const floor = cappedFloor(200, taggedSpend * 0.03, CONCEPT_FLOOR_CAP);
  const angles = [...byAngle.entries()]
    .map(([angle, a]) => ({
      angle,
      spend: Math.round(a.spend),
      spend_share_pct: pct(a.spend, taggedSpend),
      kpi: mode === 'roas' ? r2(div(a.value, a.spend)) : r2(div(a.spend, a.results || 1)),
      ads: a.ads.size,
      results: mode === 'roas' ? a.purchases : a.results,
      below_floor: a.spend < floor,
    }))
    .sort((a, b) => b.spend - a.spend);
  const assessed = angles.filter((a) => !a.below_floor);
  const kpiLabel = mode === 'roas' ? 'Meta ROAS' : 'cost per result';

  // Some lead-gen accounts carry NO ad-level result mapping at all (results
  // NULL and no lead actions) — "cost per result" would silently degrade to
  // raw spend per angle. Say what we can (the spend split) and stop there.
  if (mode === 'cpr' && assessed.length > 0 && assessed.every((a) => a.results === 0)) {
    const top = assessed[0]!;
    return {
      summary:
        `${assessed.length} creative angles carry real spend — biggest budget: "${top.angle}" (${top.spend_share_pct}% of tagged spend). ` +
        `No ad-level results are mapped for this account, so this is a spend split, not a performance ranking.`,
      next_step: `Fix the ad-level result mapping for this account (the daily sync carries no per-ad result events), then re-audit — angle ranking needs it.`,
      data: {
        window_days: 30,
        kpi_mode: mode,
        kpi_label: kpiLabel,
        coverage_pct: coverage,
        angles: angles.slice(0, 10).map((a) => ({ ...a, kpi: null })),
        discount_flag: false,
        signal: false,
      },
      warnings: [
        `No ad-level result mapping — angle ranking suppressed rather than guessed.`,
        ...(coverage < 60 ? [`Angle tags cover ${coverage}% of spend — the untagged remainder is not represented here.`] : []),
      ],
      derivation:
        `Every analyzed ad carries a messaging-angle tag from our creative analysis. Last-30-day spend is grouped by that tag ` +
        `(tags cover ${coverage}% of spend), but every angle summed to zero mapped results — so the per-angle ${kpiLabel} is withheld ` +
        `instead of dividing spend by nothing.`,
    };
  }

  const better = (a: { kpi: number }, b: { kpi: number }) => (mode === 'roas' ? b.kpi - a.kpi : a.kpi - b.kpi);
  const ranked = [...assessed].sort(better);
  const best = ranked[0];
  const biggest = assessed[0];

  const warnings: string[] = [];
  let discountFlag = false;
  if (best && DISCOUNT_ANGLE.test(best.angle)) {
    discountFlag = true;
    warnings.push(
      `Best ${kpiLabel} sits on a discount/offer angle ("${best.angle}") — that is NOT a green light to scale discounts. ` +
      `Discount creative usually harvests demand the other angles created; over-indexing on it empties the funnel and trains buyers to wait for deals.`,
    );
  }
  if (coverage < 60) {
    warnings.push(`Angle tags cover ${coverage}% of spend — the untagged remainder is not represented here.`);
  }

  const underfunded = best && biggest && best.angle !== biggest.angle && !discountFlag ? best : null;

  return {
    summary: best && biggest
      ? `${assessed.length} creative angles carry real spend. Biggest budget: "${biggest.angle}" (${biggest.spend_share_pct}% of tagged spend, ${kpiLabel} ${biggest.kpi}). ` +
        (best.angle === biggest.angle
          ? `It's also the best performer — budget and performance agree here.`
          : `Best performer: "${best.angle}" (${kpiLabel} ${best.kpi} on ${best.spend_share_pct}% of tagged spend).`)
      : `Angle performance computed on ${coverage}% tag coverage.`,
    next_step: discountFlag
      ? `Scale the best NON-discount angle instead, and keep the discount angle as a harvest layer — watch new-customer share if you push it.`
      : underfunded
        ? `"${underfunded.angle}" out-earns the biggest budget line — shift test budget toward it and brief 2 new variations on that angle.`
        : `Budget already follows performance across angles — keep the current allocation and test a genuinely new angle for diversity.`,
    data: {
      window_days: 30,
      kpi_mode: mode,
      kpi_label: kpiLabel,
      coverage_pct: coverage,
      angles: angles.slice(0, 10),
      discount_flag: discountFlag,
      signal: discountFlag || !!underfunded,
    },
    warnings: warnings.length ? warnings : undefined,
    derivation:
      `Every analyzed ad carries a messaging-angle tag from our creative analysis (what the ad argues, not what it looks like). ` +
      `Last-30-day spend and returns are grouped by that tag — tags cover ${coverage}% of spend, and angles below a statistical floor ` +
      `fold away rather than pretend precision. ${kpiLabel} per angle = the group's summed returns against its summed spend.`,
  };
}

// ---------------------------------------------------------------------------
// 7. Optimization-event correctness (the "1 check / 2 X" panel)
// ---------------------------------------------------------------------------

export interface AdsetConfigLite {
  adset_id: string;
  adset_name: string;
  optimization_goal: string | null;
  custom_event_type: string | null;
  effective_status: string | null;
}

/** Soft signals that never pay the bills when real conversions exist. */
const SOFT_GOALS = new Set(['LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'THRUPLAY', 'POST_ENGAGEMENT', 'REACH', 'IMPRESSIONS', 'PAGE_LIKES', 'VIDEO_VIEWS']);
const MID_FUNNEL_EVENTS = new Set(['ADD_TO_CART', 'INITIATED_CHECKOUT', 'CONTENT_VIEW', 'ADD_TO_WISHLIST', 'SEARCH']);

export function computeOptimizationEvents(
  adsets: AdsetConfigLite[],
  spendByAdset: Map<string, number>,
  totals30: { purchases: number; leads: number; purchase_value: number },
  currency = '',
): PackSection {
  // What SHOULD this account optimize for? Revenue accounts → Purchase;
  // lead accounts → Lead. Mirrors the account-model classification.
  const wantsPurchase = totals30.purchase_value > 0 && totals30.purchases > 0;
  const wantsLead = !wantsPurchase && totals30.leads > totals30.purchases;
  const targetWord = wantsPurchase ? 'Purchase' : wantsLead ? 'Lead' : 'your real conversion';
  // Enough weekly conversion volume that optimizing on the real event is viable
  // (Meta's ~50/week learning heuristic, halved to be conservative per ad set).
  const conversionVolume = wantsPurchase ? totals30.purchases : totals30.leads;
  const volumeOk = conversionVolume >= 100; // ~25/week account-wide

  const rows = adsets
    .map((a) => {
      const spend = spendByAdset.get(a.adset_id) ?? 0;
      const goal = (a.optimization_goal ?? 'UNKNOWN').toUpperCase();
      const event = (a.custom_event_type ?? '').toUpperCase();
      let verdict: 'check' | 'x' | 'question';
      let reason: string;
      if (goal === 'OFFSITE_CONVERSIONS' && (event === 'PURCHASE' || (!wantsPurchase && event === 'LEAD'))) {
        verdict = 'check';
        reason = `Optimizing for ${event.toLowerCase()} — matches what the account actually sells.`;
      } else if (goal === 'OFFSITE_CONVERSIONS' && wantsPurchase && event === 'LEAD') {
        verdict = 'x';
        reason = `Optimizing for Lead on a revenue account — Meta hunts form-fillers, not buyers.`;
      } else if (goal === 'OFFSITE_CONVERSIONS' && MID_FUNNEL_EVENTS.has(event)) {
        verdict = volumeOk ? 'x' : 'question';
        reason = volumeOk
          ? `Optimizing for ${event.replace(/_/g, ' ').toLowerCase()} while the account records ${conversionVolume} ${targetWord.toLowerCase()}s in 30 days — Meta will find carts, not ${targetWord.toLowerCase()}s. Move to ${targetWord}.`
          : `Mid-funnel event — sometimes a deliberate learning-volume choice at ${conversionVolume} ${targetWord.toLowerCase()}s/30d; confirm it's intentional.`;
      } else if (SOFT_GOALS.has(goal)) {
        verdict = conversionVolume >= 30 ? 'x' : 'question';
        reason = conversionVolume >= 30
          ? `Optimizing for ${goal.replace(/_/g, ' ').toLowerCase()} while the pixel records real ${targetWord.toLowerCase()}s — this buys the cheapest clicks, not customers.`
          : `Soft goal — with thin conversion volume this may be deliberate; confirm the intent.`;
      } else if (goal === 'OFFSITE_CONVERSIONS' && !event) {
        verdict = 'question';
        reason = `Conversion-optimized but the event could not be read from the config.`;
      } else if (goal === 'APP_INSTALLS' || goal === 'VALUE' || goal === 'OFFSITE_CONVERSIONS' || goal === 'CONVERSATIONS' || goal === 'LEAD_GENERATION' || goal === 'QUALITY_LEAD') {
        verdict = 'check';
        reason = `Conversion-class goal (${goal.replace(/_/g, ' ').toLowerCase()}).`;
      } else {
        verdict = 'question';
        reason = `Unrecognized goal "${goal}" — read it manually before judging.`;
      }
      return {
        adset_name: a.adset_name,
        goal: goal + (event ? ` → ${event}` : ''),
        spend_30d: Math.round(spend),
        verdict,
        reason,
      };
    })
    .filter((r) => r.spend_30d > 0)
    .sort((a, b) => b.spend_30d - a.spend_30d);

  if (rows.length === 0) {
    return {
      summary: `No ad sets with spend could be matched to a readable optimization config.`,
      next_step: `Check the ad-set config read — this report needs it.`,
      data: { rows: [], signal: false },
      warnings: ['Ad-set config read returned nothing usable — report suppressed.'],
    };
  }

  const totalSpend = rows.reduce((s, r) => s + r.spend_30d, 0);
  const misSpend = rows.filter((r) => r.verdict === 'x').reduce((s, r) => s + r.spend_30d, 0);
  const checks = rows.filter((r) => r.verdict === 'check').length;
  const xs = rows.filter((r) => r.verdict === 'x').length;
  const qs = rows.filter((r) => r.verdict === 'question').length;

  return {
    summary: xs === 0
      ? rows.length === 1
        ? `The one ad set that spent in the last 30 days optimizes for the right thing (${targetWord}-class events). This is the foundational setting most accounts get wrong — yours is clean.`
        : `All ${rows.length} ad sets that spent in the last 30 days optimize for the right thing (${targetWord}-class events). This is the foundational setting most accounts get wrong — yours is clean.`
      : `${xs} of the ${rows.length} ad set${rows.length === 1 ? '' : 's'} that spent in the last 30 days optimize${xs === 1 ? 's' : ''} for the WRONG event — ${pct(misSpend, totalSpend)}% of spend (${money(misSpend, currency)} over 30 days) is telling Meta to hunt something other than ${targetWord.toLowerCase()}s.`,
    next_step: xs === 0
      ? `Nothing to change here — keep new ad sets on the same optimization event.`
      : `Switch the flagged ad sets to ${targetWord} optimization (or fold their budget into the correctly-set ones). Expect a learning reset — do it per ad set, not all at once.`,
    data: {
      window_days: 30,
      target_event: targetWord,
      counts: { check: checks, x: xs, question: qs },
      misoptimized_spend_share_pct: pct(misSpend, totalSpend),
      misoptimized_spend_30d: Math.round(misSpend),
      currency: currency || undefined,
      signal: xs > 0,
      rows: rows.slice(0, 15),
    },
    warnings: qs > 0 ? [`${qs} ad set(s) marked "?" — plausible-but-unusual configs we won't guess about.`] : undefined,
    derivation:
      `Population: every ad set that spent in the last 30 days — whether or not it is still active (the learning-phase check ` +
      `next door covers only the currently active subset, which is why its count can be smaller). ` +
      `We read each ad set's optimization goal and conversion event straight from its Meta config and judged it against ` +
      `what this account actually sells (${targetWord}-class events, inferred from 30 days of recorded conversions). ` +
      `The flagged amount is those ad sets' summed 30-day spend — spend pointed at the wrong target, not money already lost. ` +
      `Configs that could be a deliberate learning-volume choice get a "?" instead of a verdict.`,
  };
}

// ---------------------------------------------------------------------------
// 8. Provisional lead insights (choreography — the top of the page must never
//    be the LAST thing to arrive)
// ---------------------------------------------------------------------------

/**
 * Deterministic top-3 the moment the fast tier lands (UX review §2.2): worst
 * scorecard dimension · the fatiguing ad with its runway · concentration risk,
 * with strengths as fallback. The end-of-audit LLM ranking OVERWRITES these —
 * they are honest placeholders built from real numbers, flagged provisional so
 * the page can say "first read".
 */
export interface ProvisionalInsight {
  headline: string;
  detail: string;
  severity: 'risk' | 'opportunity' | 'info';
  section: string;
  provisional: true;
}

/**
 * The scatter's own stored data, for the starved-winner insight. Read rather
 * than recomputed: the chart already decided which dots are starved, and a
 * second opinion here could circle an ad the chart does not.
 */
export interface ScatterReadForInsights {
  dots?: Array<{
    ad_name?: string;
    spend_30d?: number;
    roas_30d?: number | null;
    cpr_30d?: number | null;
    spend_share_pct?: number;
    starved?: boolean;
  }>;
  kpi_mode?: string;
  cpr_line?: number;
  cpr_line_source?: string;
  result_noun?: string;
  currency?: string;
  plotted_set_label?: string;
}

export function buildProvisionalInsights(
  scorecard: Array<{ dimension: string; band: string; position: string; lever: string; next_step: string; section_key: string }>,
  fatigueData: { ads?: FatigueAd[] } | undefined,
  concentrationData: { top3_share_pct?: number; band?: string; top_ads?: Array<{ ad_name: string; share_pct: number }> } | undefined,
  scatterData?: ScatterReadForInsights,
): ProvisionalInsight[] {
  const out: ProvisionalInsight[] = [];

  const worst = scorecard.find((e) => e.band === 'weak');
  if (worst) {
    out.push({
      headline: worst.position,
      detail: `${worst.lever} ${worst.next_step}`,
      severity: 'risk',
      section: worst.section_key,
      provisional: true,
    });
  }

  const soonest = (fatigueData?.ads ?? [])
    .filter((a) => a.class === 'fatiguing' && a.days_to_breakeven != null)
    .sort((a, b) => a.days_to_breakeven! - b.days_to_breakeven!)[0];
  if (soonest) {
    out.push({
      headline: `"${soonest.ad_name}" crosses breakeven in ~${soonest.days_to_breakeven} days at its current decline`,
      detail: `It carries ${soonest.spend.toLocaleString('en-US')} of 90-day spend and its return has dropped ${Math.abs(soonest.trend_pct)}% from the first half of its run to the second. The runway number is the deadline for its replacement.`,
      severity: 'risk',
      section: 'creative_fatigue',
      provisional: true,
    });
  }

  const conc = concentrationData;
  if (out.length < 3 && conc && typeof conc.top3_share_pct === 'number' && (conc.band === 'high' || conc.band === 'elevated')) {
    const hero = conc.top_ads?.[0];
    out.push({
      headline: `Your top 3 ads carry ${conc.top3_share_pct}% of all spend`,
      detail: hero
        ? `"${hero.ad_name}" alone takes ${hero.share_pct}%. If it fatigues, most of the account goes with it: at this level one ad carries the account, which is not a strategy.`
        : `At this level one ad carries the account, which is not a strategy.`,
      severity: 'risk',
      section: 'spend_concentration',
      provisional: true,
    });
  }

  // The underfunded winner: an ad the chart already circled as doing better
  // than the line on a small slice of budget. It is the one opportunity in the
  // report that costs nothing to act on, so it earns a place beside the risks.
  const starved = (scatterData?.dots ?? []).filter((d) => d.starved === true && typeof d.ad_name === 'string');
  if (out.length < 3 && starved.length > 0) {
    const cprMode = scatterData?.kpi_mode !== 'roas';
    const best = [...starved].sort((a, b) =>
      cprMode
        ? (a.cpr_30d ?? Infinity) - (b.cpr_30d ?? Infinity)
        : (b.roas_30d ?? 0) - (a.roas_30d ?? 0),
    )[0]!;
    const noun = scatterData?.result_noun ?? 'result';
    const currency = scatterData?.currency ? ` ${scatterData.currency}` : '';
    const share = typeof best.spend_share_pct === 'number' ? best.spend_share_pct : null;
    const lineWord =
      scatterData?.cpr_line != null
        ? scatterData.cpr_line_source === 'owner_target'
          ? `your stated target of ${scatterData.cpr_line}${currency}`
          : `the ${scatterData.cpr_line}${currency} average across ${scatterData.plotted_set_label ?? 'the plotted ads'}`
        : null;
    const headline = cprMode
      ? `"${best.ad_name}" buys a ${noun} for ${best.cpr_30d}${currency}${share != null ? ` on ${share}% of the spend` : ''}`
      : `"${best.ad_name}" returns ${best.roas_30d}x${share != null ? ` on ${share}% of the spend` : ''}`;
    const detail = cprMode
      ? `It is one of the cheapest ads on the chart${lineWord ? ` against ${lineWord}` : ''} and it is getting ${share != null ? `${share}% of` : 'a small slice of'} the budget. ` +
        `Give it a step more and re-read it: an ad already beating the line is the cheapest place a budget increase can go.`
      : `It is earning well above the line on ${share != null ? `${share}% of` : 'a small slice of'} the budget. Give it a step more and re-read it before assuming it saturates.`;
    out.push({ headline, detail, severity: 'opportunity', section: 'budget_scatter', provisional: true });
  }

  // Fallbacks so the strip still says something real on a healthy account.
  if (out.length < 3) {
    const evergreens = (fatigueData?.ads ?? []).filter((a) => a.class === 'evergreen');
    if (evergreens.length) {
      const share = evergreens.reduce((s, a) => s + a.spend, 0);
      out.push({
        headline: `${evergreens.length} evergreen winner${evergreens.length > 1 ? 's' : ''} — 60+ days old and still holding their number`,
        detail: `${Math.round(share).toLocaleString('en-US')} of the 90-day spend behind the ads we could read runs on proven creative that is NOT fatiguing. Protect these ads; whatever they do right is this account's style guide.`,
        severity: 'opportunity',
        section: 'creative_fatigue',
        provisional: true,
      });
    }
  }
  if (out.length < 3) {
    const strength = [...scorecard].reverse().find((e) => e.band === 'strong');
    if (strength) {
      out.push({
        headline: strength.position,
        detail: `${strength.lever} A genuine strength — protect what's producing it.`,
        severity: 'opportunity',
        section: strength.section_key,
        provisional: true,
      });
    }
  }

  return out.slice(0, 3);
}

// ---------------------------------------------------------------------------
// 9. Hook-rate inflation correction (Audience Network / rewarded video)
// ---------------------------------------------------------------------------

/**
 * BINDING (design ruling #5, 2026-06-25): rewarded-video placements force the
 * view, so their "3-second plays" inflate the hook rate. The most trust-building
 * move in the persona test was correcting the client's OWN metric DOWN — so we
 * report the real hook rate with forced views stripped out.
 *
 * Pure: placement-broken-down insight rows in (from a live Meta pull), a
 * correction verdict out. Only speaks when the correction is material.
 */
export interface PlacementHookRow {
  publisher_platform: string;
  platform_position: string;
  impressions: number;
  /** 3-second video plays (Meta `video_view` action). */
  video_views: number;
}

export interface HookCorrection {
  /** Hook rate across ALL placements, % (what Meta's UI implies). */
  reported_pct: number;
  /** Hook rate with forced-view placements stripped, % (the real number). */
  corrected_pct: number;
  /** Share of impressions on forced-view placements (rewarded video), %. */
  forced_share_pct: number;
  /** Share of impressions on Audience Network overall, %. */
  an_share_pct: number;
  material: boolean;
  note: string;
}

const FORCED_VIEW = (row: PlacementHookRow): boolean =>
  row.platform_position.toLowerCase().includes('rewarded');

export function computeHookCorrection(rows: PlacementHookRow[]): HookCorrection | null {
  const sum = (xs: PlacementHookRow[], k: 'impressions' | 'video_views') => xs.reduce((s, r) => s + (r[k] || 0), 0);
  const allImps = sum(rows, 'impressions');
  if (allImps < 10_000) return null; // too thin to correct anything honestly
  const clean = rows.filter((r) => !FORCED_VIEW(r));
  const cleanImps = sum(clean, 'impressions');
  if (cleanImps <= 0) return null;

  const reported = (sum(rows, 'video_views') / allImps) * 100;
  const corrected = (sum(clean, 'video_views') / cleanImps) * 100;
  const forcedShare = pct(allImps - cleanImps, allImps);
  const anShare = pct(sum(rows.filter((r) => r.publisher_platform.toLowerCase() === 'audience_network'), 'impressions'), allImps);
  // Material when forced views move the number by ≥1pp AND ≥5% relative.
  const material = forcedShare > 0 && reported - corrected >= 1 && reported > 0 && (reported - corrected) / reported >= 0.05;

  return {
    reported_pct: r1(reported),
    corrected_pct: r1(corrected),
    forced_share_pct: forcedShare,
    an_share_pct: anShare,
    material,
    note: material
      ? `Rewarded-video placements (${forcedShare}% of impressions) force the view, so they count as "3-second plays" no one chose to watch. ` +
        `Stripping them, your real hook rate is ${r1(corrected)}% — not the ${r1(reported)}% the raw numbers imply. ` +
        `Judge your creative on the corrected number (the cohort comparison stays on raw-vs-raw, so it's still apples to apples).`
      : forcedShare > 0
        ? `Rewarded-video placements are ${forcedShare}% of impressions — not enough to move your hook rate meaningfully.`
        : `No forced-view placements in the window — the reported hook rate needs no correction.`,
  };
}

// ---------------------------------------------------------------------------
// 10. Ad preview enrichment merge (pure — the batched Graph fetch lives in
//     magic-audit.ts; this just writes the results into section rows)
// ---------------------------------------------------------------------------

/** Per-ad visual identity fetched live from Graph: a shareable fb.me preview
 * link (`preview_shareable_link` on the ad object) + the creative thumbnail. */
export interface AdPreview {
  preview_link?: string | null;
  thumbnail_url?: string | null;
}

/**
 * Merge per-ad preview links + thumbnails into already-computed section rows
 * (fatigue `ads[]`, concentration `top_ads[]` — anything carrying `ad_id`).
 * Pure and non-destructive: rows without an ad_id or without a fetched preview
 * pass through unchanged, null/empty values are never written, and the input
 * array is not mutated. The enrichment post-pass is fail-soft by design — a
 * missing preview must never dent the section data it decorates.
 */
export function mergeAdPreviews<T extends { ad_id?: unknown }>(
  rows: T[] | undefined,
  previews: Map<string, AdPreview>,
): T[] | undefined {
  if (!rows) return rows;
  return rows.map((row) => {
    const id = typeof row.ad_id === 'string' ? row.ad_id : null;
    const p = id ? previews.get(id) : undefined;
    if (!p) return row;
    const merged: T & AdPreview = { ...row };
    if (p.preview_link) merged.preview_link = p.preview_link;
    if (p.thumbnail_url) merged.thumbnail_url = p.thumbnail_url;
    return merged;
  });
}
