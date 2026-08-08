/**
 * The macro why — decomposing a creep (Loop 1, the Monday brief's second half).
 *
 * Design: docs/factory/day-2026-08-08/macro-why-design.md (tinkers repo).
 *
 * WHY THIS EXISTS: `macro-vitals` can say "CPM £19.72, +32% vs early May,
 * climbing ~4%/week for 6 weeks". Daniel's next question is always the same
 * one — "was it the creative, new product categories, ads with high daily
 * frequency struggling to find new audiences…". A macro line without that
 * answer is a thermometer, not a media buyer.
 *
 * THE KEY IDEA: a macro why is a DECOMPOSITION, not a diagnosis-guess. An
 * account aggregate moving between two windows splits exactly into
 *   mix    — delivery moved toward different components, and
 *   within — the same components got worse (or better),
 * and the split is an identity, not a model:
 *
 *   R = Σ shareᵢ · rateᵢ
 *   ΔR = Σ (Δshareᵢ · rate_baseᵢ)   +   Σ (share_curᵢ · Δrateᵢ)
 *        └──────── mix ────────┘       └──────── within ───────┘
 *
 * The components we can name from the warehouse: campaigns (always), product
 * categories (where the client's config carries parsing rules — PL), ad sets
 * (the audience unit, where frequency lives) and creatives-by-age.
 *
 * WHEN IT RUNS: only for VOICED vitals and chords (the triggered-analysis
 * principle — a steady account must not pay for the extra read), and it
 * decomposes the SAME delta the creep was measured on: the pulse's current
 * window against its PINNED baseline window. Both ranges are passed in by the
 * caller; recomputing them here would risk explaining a different move than
 * the one on the page.
 *
 * WHERE THE NUMBERS COME FROM, and why:
 *   · components (CPM, CTR, reach-per-spend) ← campaign_daily. It carries the
 *     campaign NAME the category rules match on, and a reach figure Meta
 *     deduplicated inside the campaign;
 *   · frequency carriers ← adset_daily, for the same reason: a per-ad-set
 *     frequency pooled out of AD rows divides by a sum of ad-level reach,
 *     which double-counts people and would understate every ad set into
 *     silence (measured on PL: 1.1–2.0 pooled from ads, where the real ad-set
 *     figures are the ones adset_daily reports);
 *   · creatives ← ad_daily, the only table with ad names and first-spend days.
 * When campaign_daily or adset_daily is empty the module falls back to pooling
 * ad rows and says nothing it cannot support.
 *
 * HONESTY RULES, straight from the design:
 *   · components under 5% share in BOTH windows fold into "other";
 *   · a decomposition needs both windows populated — missing baseline detail
 *     says so by name ("component detail starts May 12") instead of guessing;
 *   · when most of today's delivery sits in components that did not exist in
 *     the baseline, mix and within are NOT quoted as if they separated cleanly
 *     — the account changed shape and the line says that instead;
 *   · account frequency is not additive across ad sets, so it is never split
 *     into fake exact shares. The carriers are NAMED; and when no ad set is
 *     above the bar while the ACCOUNT is, that is arithmetic proof of overlap
 *     between audiences, which is what the line then says;
 *   · ad-level reach double-counts people, so a sum of it is never quoted as
 *     "reach" — only per-component reach-per-spend CHANGES and per-entity
 *     frequency are said out loud;
 *   · what the named components do not carry is stated plainly as a remainder.
 *
 * Everything from `decomposeRate` to `composeMacroWhy` is pure — rows in,
 * sentences out. All I/O lives in the four `fetch*` helpers and
 * `attachMacroWhys` (what macro-vitals calls).
 */

import { getSupabase } from '../integrations/supabase.js';
import { logger } from '../utils/logger.js';
import type { Chord, MacroReads, RenderedPulse, VitalName } from './macro-vitals.js';

// ---------------------------------------------------------------------------
// Constants — the design doc's numbers, in one place
// ---------------------------------------------------------------------------

/** Under this share of the denominator in BOTH windows, a component is noise. */
export const SMALL_COMPONENT_SHARE = 0.05;
/** A delta smaller than this (relative to baseline) is not worth attributing. */
export const MIN_ATTRIBUTABLE_DELTA = 0.005;
/** Worth naming as the top contributor of its kind. */
const MIN_NAMED_CONTRIBUTION = 0.05;
/** Below this, a mix or within term is not worth a sentence of its own. */
const MIN_VOICED_TERM = 0.15;
/** Above this share of today's delivery in components that did not exist in
 *  the baseline, the account changed shape and mix/within stop separating. */
export const SHAPE_CHANGE_SHARE = 0.3;
/** Above this pooled frequency an ad set is showing the same people again. */
export const CARRIER_FREQUENCY = 2.5;
/** An ad set below this impression share cannot be "carrying" anything. */
export const CARRIER_MIN_IMPRESSION_SHARE = 0.01;
/** Reach per currency unit falling more than this is a tightening pool… */
export const STRAIN_REACH_DROP = 0.2;
/** …but only when the budget held still — otherwise it is just less money. */
export const STRAIN_SPEND_HELD = 0.25;
/** A genuinely new creative "took spend" when it took this much of a day. */
export const NEW_CREATIVE_DAY_SHARE = 0.01;
/** How long after its first spend a new creative can still land at 1%/day. */
export const NEW_CREATIVE_LANDING_DAYS = 7;
/** The concentration read: how few creatives carry this much of the spend. */
export const CONCENTRATION_TARGET = 0.8;
/** Days of stillness that make a roster stale enough to name as the lever. */
const STALE_REFRESH_DAYS = 21;
/** Component names are truncated to this in prose. */
export const NAME_MAX = 40;

// ---------------------------------------------------------------------------
// Types — the three row shapes, then the four reads
// ---------------------------------------------------------------------------

/** One `ad_daily` row: the creative read's source (names + first-spend days). */
export interface AdDailyRow {
  date: string;
  ad_id: string;
  ad_name: string | null;
  adset_id: string | null;
  campaign_id: string | null;
  spend: number;
  impressions: number;
  /** Meta's deduped reach for THAT AD. Summing it across ads double-counts. */
  reach: number | null;
  frequency: number | null;
  link_clicks: number;
  purchases: number;
}

/** One `campaign_daily` row: the component read's source. */
export interface CampaignDailyRow {
  date: string;
  campaign_id: string;
  campaign_name: string | null;
  spend: number;
  impressions: number;
  /** Deduped inside the campaign, for that day. */
  reach: number | null;
  link_clicks: number;
}

/** One `adset_daily` row: the frequency read's source. */
export interface AdsetDailyRow {
  date: string;
  adset_id: string;
  adset_name: string | null;
  impressions: number;
  /** Deduped inside the ad set, for that day. */
  reach: number | null;
}

export interface DateWindow {
  start: string;
  end: string;
}

/** The PL-style category rules, exactly the shape `client_configs` stores. */
export interface CategoryConfig {
  rules: Array<{ category: string; patterns?: string[] }>;
  defaultCategory: string;
  /** category key → display name, from config.category_targets[key].name. */
  names: Record<string, string>;
}

// --- decomposeRate ---------------------------------------------------------

export interface RateComponent {
  key: string;
  name: string;
  curNum: number;
  curDen: number;
  baseNum: number;
  baseDen: number;
}

export interface RateContribution {
  key: string;
  name: string;
  curShare: number;
  baseShare: number;
  /** null when the component had no delivery in that window. */
  curRate: number | null;
  baseRate: number | null;
  /** Contribution to the delta, in the rate's own units. */
  mix: number;
  within: number;
  /** Signed fractions of the total delta (positive = pushed it the same way). */
  mixPctOfDelta: number | null;
  withinPctOfDelta: number | null;
  pctOfDelta: number | null;
}

export interface RateDecomposition {
  /** Pooled over the components handed in — NOT read from account_daily. */
  curRate: number | null;
  baseRate: number | null;
  delta: number | null;
  /** Fraction of the delta that is share movement between components. */
  mixPct: number | null;
  /** Fraction that is the same components changing. mixPct + withinPct = 1. */
  withinPct: number | null;
  /** The component that pushed the delta hardest by moving share… */
  topMix: RateContribution | null;
  /** …and the one that gave that share up (the "away from X" half). */
  counterMix: RateContribution | null;
  /** The component that pushed hardest by changing its own rate. Only ever a
   *  component with a real baseline rate — an entrant has nothing to change
   *  FROM, and saying otherwise would invent a number. */
  topWithin: RateContribution | null;
  /** What `topMix` and `topWithin` between them do NOT carry. */
  remainderPct: number | null;
  /** Current-window share sitting in components absent from the baseline. */
  entrantShare: number;
  /** Baseline share that has since gone to zero. */
  exitShare: number;
  /** entrantShare > SHAPE_CHANGE_SHARE: a different account, not a moved one. */
  shapeChanged: boolean;
  /** The biggest entrant, for the shape-change sentence. */
  topEntrant: RateContribution | null;
  /** The biggest component that ran in BOTH windows — the like-for-like read. */
  survivor: RateContribution | null;
  /** Every component after the fold-in, current-share descending. */
  components: RateContribution[];
  /** How many components were folded into "other". */
  folded: number;
  /** False when the delta is too small (or the windows too empty) to attribute. */
  readable: boolean;
}

// --- frequencyCarriers -----------------------------------------------------

export interface AdsetWindow {
  key: string;
  name: string;
  curImpressions: number;
  curReach: number;
  baseImpressions: number;
  baseReach: number;
}

export interface FrequencyCarrier {
  key: string;
  name: string;
  curFrequency: number;
  baseFrequency: number | null;
  /** Share of the CURRENT window's impressions. Impressions ARE additive. */
  impressionShare: number;
}

export interface FrequencyCarrierRead {
  carriers: FrequencyCarrier[];
  /** The carriers' combined impression share. Never a combined reach. */
  impressionShare: number;
  /** Ad sets with a readable current-window frequency. */
  readable: number;
  /** Ad sets that delivered at all, per window — fragmentation, in one number. */
  entitiesCurrent: number;
  entitiesBaseline: number;
  /** The highest per-ad-set frequency in the window, carrier or not. */
  top: FrequencyCarrier | null;
  /** Above the bar but launched after the baseline — cannot be called rising. */
  newAboveThreshold: number;
}

// --- audienceStrain --------------------------------------------------------

export interface ComponentWindow {
  key: string;
  name: string;
  curSpend: number;
  curReach: number;
  baseSpend: number;
  baseReach: number;
}

export interface StrainedComponent {
  key: string;
  name: string;
  curReachPerCurrency: number;
  baseReachPerCurrency: number;
  /** Relative change in reach per currency unit (negative = pool tightening). */
  reachPerSpendPct: number;
  /** Relative change in spend — inside ±STRAIN_SPEND_HELD by construction. */
  spendPct: number;
  curSpend: number;
}

export interface AudienceStrainRead {
  strained: StrainedComponent[];
  /** Components with both windows populated enough to test. */
  checked: number;
}

// --- creativeRefreshRead ---------------------------------------------------

export interface CreativeCarrier {
  name: string;
  spend: number;
  share: number;
  /** Days from the creative's first-ever spend to the window's end. */
  ageDays: number | null;
}

export interface CreativeRefreshRead {
  /** Days since a genuinely new creative last took ≥1% of a day's spend. */
  daysSinceNewCreative: number | null;
  lastNewCreativeDate: string | null;
  lastNewCreativeName: string | null;
  /** How few creatives carry CONCENTRATION_TARGET of current-window spend. */
  carrierCount: number;
  carrierSharePct: number;
  carriers: CreativeCarrier[];
  medianAgeDays: number | null;
  /** Creatives with spend in the current window. */
  totalCreatives: number;
  /** The oldest day on file — ages and "new" are floored by it, and said so. */
  historyStart: string | null;
  /** True when a spend-carrying creative predates the history: age is a floor. */
  ageIsFloor: boolean;
}

// --- the composed why ------------------------------------------------------

export interface MacroWhy {
  /** 1–3 sentences, numbers first, components named. */
  text: string;
  /** The one suggested move. */
  next: string;
  evidence: Record<string, unknown>;
}

export type RateMetric = 'cpm' | 'ctr' | 'reach-per-spend';
export type ComponentLabel = 'category' | 'campaign' | 'ad set' | 'creative';

export interface MacroWhyTarget {
  kind: 'vital' | 'chord';
  vital?: VitalName;
  chordId?: string;
  direction: 'up' | 'down';
  /** What the components are called in prose. */
  componentLabel: ComponentLabel;
}

export interface MacroWhyParts {
  rate?: RateDecomposition | null;
  rateMetric?: RateMetric;
  carriers?: FrequencyCarrierRead | null;
  strain?: AudienceStrainRead | null;
  refresh?: CreativeRefreshRead | null;
  /** The account's own pooled frequency, for the overlap proof. */
  accountFrequency?: { cur: number | null; base: number | null };
  /** Daily spend either side, so a reach move can be read against its budget. */
  spendContext?: { cur: number | null; base: number | null };
  /** Set when component detail does not reach back into the baseline window. */
  detailStartsAt?: string | null;
  /** The named period the baseline covers, e.g. 'early May'. */
  baselineLabel?: string;
  /** Allow the "no carrier, so it is overlap" read. Owned by the frequency
   *  line and the narrowing chord: repeating it under four bullets would be
   *  four times the words and none of the extra meaning. */
  overlapRead?: boolean;
}

// ---------------------------------------------------------------------------
// Formatting (house style: money leads, a percentage is only the meaning)
// ---------------------------------------------------------------------------

function money(value: number, currency: string, decimals = 0): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    return `${value.toFixed(decimals)} ${currency}`;
  }
}

function moneyCompact(value: number, currency: string): string {
  if (Math.abs(value) < 1000) return money(value, currency, 0);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    })
      .format(value)
      .replace('K', 'k');
  } catch {
    return `${(value / 1000).toFixed(1)}k ${currency}`;
  }
}

/** Magnitude only — direction is carried by a word ("rise", "fell"). */
function pctMag(fraction: number): string {
  const pct = Math.abs(fraction) * 100;
  return `${pct < 10 ? Math.round(pct * 10) / 10 : Math.round(pct)}%`;
}

function pctSigned(fraction: number): string {
  const pct = fraction * 100;
  let rounded = Math.abs(pct) < 10 ? Math.round(pct * 10) / 10 : Math.round(pct);
  if (Object.is(rounded, -0)) rounded = 0;
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

/** A share, as the reader says it: '41%'. */
function sharePct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function truncateName(name: string, max = NAME_MAX): string {
  return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

/** '2026-05-12' → 'May 12'. Periods are NAMED; no line says "yesterday". */
export function shortDayLabel(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${dateStr}T12:00:00Z`));
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000,
  );
}

const LABEL_PLURAL: Record<ComponentLabel, string> = {
  category: 'categories',
  campaign: 'campaigns',
  'ad set': 'ad sets',
  creative: 'creatives',
};

function rateValue(metric: RateMetric, value: number, currency: string): string {
  switch (metric) {
    case 'cpm':
      return money(value, currency, 2);
    case 'ctr':
      return `${(value * 100).toFixed(2)}%`;
    case 'reach-per-spend':
      // Never rendered as an absolute in prose: pooled reach double-counts.
      return value.toFixed(1);
  }
}

const RATE_NOUN: Record<RateMetric, string> = {
  cpm: 'CPM',
  ctr: 'CTR',
  'reach-per-spend': 'reach per currency unit',
};

// ---------------------------------------------------------------------------
// Pure core 1 — the mix/within identity
// ---------------------------------------------------------------------------

/**
 * Split a rate's move between two windows into mix and within.
 *
 * The identity (see the header) is EXACT: `mixPct + withinPct === 1` whenever
 * the delta is readable. Components that exist in only one window are handled
 * without inventing a rate for them — an entrant is charged the overall
 * BASELINE rate as its reference, which keeps the identity exact and reads
 * correctly ("share moved into something that was not there before"). When
 * entrants carry most of today's delivery the split stops being a real
 * separation, and `shapeChanged` says so rather than letting the caller quote
 * a confident 0%/100%.
 *
 * `scale` exists so CPM can be decomposed in CPM units (spend/impressions ×
 * 1000) without the caller pre-multiplying its inputs. Every percentage here
 * is scale-invariant.
 *
 * Works for any pooled ratio: CPM (spend/impressions), CTR (clicks/
 * impressions), reach per currency (reach/spend).
 */
export function decomposeRate(
  components: RateComponent[],
  opts: { scale?: number; smallShare?: number } = {},
): RateDecomposition {
  const scale = opts.scale ?? 1;
  const smallShare = opts.smallShare ?? SMALL_COMPONENT_SHARE;
  const empty: RateDecomposition = {
    curRate: null,
    baseRate: null,
    delta: null,
    mixPct: null,
    withinPct: null,
    topMix: null,
    counterMix: null,
    topWithin: null,
    remainderPct: null,
    entrantShare: 0,
    exitShare: 0,
    shapeChanged: false,
    topEntrant: null,
    survivor: null,
    components: [],
    folded: 0,
    readable: false,
  };
  if (!components.length) return empty;

  const curDenTotal = components.reduce((s, c) => s + Math.max(0, c.curDen), 0);
  const baseDenTotal = components.reduce((s, c) => s + Math.max(0, c.baseDen), 0);
  if (curDenTotal <= 0 || baseDenTotal <= 0) return empty;

  const curRate = (scale * components.reduce((s, c) => s + c.curNum, 0)) / curDenTotal;
  const baseRate = (scale * components.reduce((s, c) => s + c.baseNum, 0)) / baseDenTotal;
  const delta = curRate - baseRate;

  // Fold the noise together BEFORE attributing anything: a 2%-share campaign
  // cannot explain an account move, and five of them listed separately hide
  // the one that can.
  const isSmall = (c: RateComponent): boolean =>
    c.curDen / curDenTotal < smallShare && c.baseDen / baseDenTotal < smallShare;
  const big = components.filter((c) => !isSmall(c));
  const small = components.filter(isSmall);
  const kept: RateComponent[] = [...big];
  if (small.length) {
    kept.push({
      key: 'other',
      name: 'other',
      curNum: small.reduce((s, c) => s + c.curNum, 0),
      curDen: small.reduce((s, c) => s + c.curDen, 0),
      baseNum: small.reduce((s, c) => s + c.baseNum, 0),
      baseDen: small.reduce((s, c) => s + c.baseDen, 0),
    });
  }

  const readable =
    baseRate > 0 && delta !== 0 && Math.abs(delta) / baseRate > MIN_ATTRIBUTABLE_DELTA;

  const contributions: RateContribution[] = kept.map((c) => {
    const curShare = c.curDen > 0 ? c.curDen / curDenTotal : 0;
    const baseShare = c.baseDen > 0 ? c.baseDen / baseDenTotal : 0;
    const cur = c.curDen > 0 ? (scale * c.curNum) / c.curDen : null;
    const base = c.baseDen > 0 ? (scale * c.baseNum) / c.baseDen : null;
    // An entrant has no baseline rate of its own; the account's is the honest
    // reference, and it is what keeps the identity exact.
    const reference = base ?? baseRate;
    const mix = (curShare - baseShare) * reference;
    const within = cur !== null ? curShare * (cur - reference) : 0;
    return {
      key: c.key,
      name: c.name,
      curShare,
      baseShare,
      curRate: cur,
      baseRate: base,
      mix,
      within,
      mixPctOfDelta: readable ? mix / delta : null,
      withinPctOfDelta: readable ? within / delta : null,
      pctOfDelta: readable ? (mix + within) / delta : null,
    };
  });

  const mixTotal = contributions.reduce((s, c) => s + c.mix, 0);
  const withinTotal = contributions.reduce((s, c) => s + c.within, 0);

  const named = contributions.filter((c) => c.key !== 'other');
  const byMix = [...named].sort((a, b) => (b.mixPctOfDelta ?? 0) - (a.mixPctOfDelta ?? 0));
  // Only a component with its OWN baseline rate can be said to have changed.
  const byWithin = named
    .filter((c) => c.baseRate !== null && c.curRate !== null)
    .sort((a, b) => (b.withinPctOfDelta ?? 0) - (a.withinPctOfDelta ?? 0));

  const topMix =
    readable && (byMix[0]?.mixPctOfDelta ?? 0) > MIN_NAMED_CONTRIBUTION ? byMix[0]! : null;
  const counter = byMix[byMix.length - 1];
  const counterMix =
    readable && counter && counter !== topMix && (counter.mixPctOfDelta ?? 0) < -MIN_NAMED_CONTRIBUTION
      ? counter
      : null;
  const topWithin =
    readable && (byWithin[0]?.withinPctOfDelta ?? 0) > MIN_NAMED_CONTRIBUTION ? byWithin[0]! : null;

  const entrants = contributions.filter((c) => c.baseShare === 0 && c.curShare > 0);
  const entrantShare = entrants.reduce((s, c) => s + c.curShare, 0);
  const exitShare = contributions
    .filter((c) => c.curShare === 0 && c.baseShare > 0)
    .reduce((s, c) => s + c.baseShare, 0);
  const survivors = contributions
    .filter((c) => c.baseShare > 0 && c.curShare > 0 && c.key !== 'other')
    .sort((a, b) => b.curShare - a.curShare);

  return {
    curRate,
    baseRate,
    delta,
    mixPct: readable ? mixTotal / delta : null,
    withinPct: readable ? withinTotal / delta : null,
    topMix,
    counterMix,
    topWithin,
    remainderPct: readable
      ? 1 - (topMix?.mixPctOfDelta ?? 0) - (topWithin?.withinPctOfDelta ?? 0)
      : null,
    entrantShare,
    exitShare,
    shapeChanged: entrantShare > SHAPE_CHANGE_SHARE,
    topEntrant:
      [...entrants].filter((c) => c.key !== 'other').sort((a, b) => b.curShare - a.curShare)[0] ??
      null,
    survivor: survivors[0] ?? null,
    components: contributions.sort((a, b) => b.curShare - a.curShare),
    folded: small.length,
    readable,
  };
}

// ---------------------------------------------------------------------------
// Pure core 2 — the frequency carriers (named, never split)
// ---------------------------------------------------------------------------

/**
 * Account frequency is not additive: the same person sees several ads, so
 * "58% of the frequency rise came from ad set X" would be a fabricated number.
 * What IS true and useful: which ad sets are pooling high frequency, whether
 * they are climbing against the same pinned baseline, and how much of the
 * account's impressions they carry (impressions ARE additive).
 *
 * Frequency here is Σimpressions ÷ Σ(daily reach) — the same pooling
 * macro-vitals uses on account_daily, so the numbers are comparable: an
 * average DAILY frequency, not a window frequency.
 */
export function frequencyCarriers(adsetWindows: AdsetWindow[]): FrequencyCarrierRead {
  const totalImpressions = adsetWindows.reduce((s, a) => s + a.curImpressions, 0);
  const empty: FrequencyCarrierRead = {
    carriers: [],
    impressionShare: 0,
    readable: 0,
    entitiesCurrent: 0,
    entitiesBaseline: 0,
    top: null,
    newAboveThreshold: 0,
  };
  if (totalImpressions <= 0) return empty;

  const carriers: FrequencyCarrier[] = [];
  let readable = 0;
  let newAboveThreshold = 0;
  let top: FrequencyCarrier | null = null;

  for (const a of adsetWindows) {
    if (a.curReach <= 0 || a.curImpressions <= 0) continue;
    readable += 1;
    const share = a.curImpressions / totalImpressions;
    const curFrequency = a.curImpressions / a.curReach;
    const baseFrequency = a.baseReach > 0 ? a.baseImpressions / a.baseReach : null;
    const entity: FrequencyCarrier = {
      key: a.key,
      name: a.name,
      curFrequency,
      baseFrequency,
      impressionShare: share,
    };
    // "Highest" only counts ad sets big enough to mean anything.
    if (share >= CARRIER_MIN_IMPRESSION_SHARE && (!top || curFrequency > top.curFrequency)) {
      top = entity;
    }
    if (curFrequency <= CARRIER_FREQUENCY) continue;
    if (share < CARRIER_MIN_IMPRESSION_SHARE) continue;
    if (baseFrequency === null) {
      // Above the bar but with nothing to rise from — counted, never claimed
      // to be climbing.
      newAboveThreshold += 1;
      continue;
    }
    if (curFrequency <= baseFrequency) continue;
    carriers.push(entity);
  }

  carriers.sort((a, b) => b.impressionShare - a.impressionShare);
  return {
    carriers,
    impressionShare: carriers.reduce((s, c) => s + c.impressionShare, 0),
    readable,
    entitiesCurrent: adsetWindows.filter((a) => a.curImpressions > 0).length,
    entitiesBaseline: adsetWindows.filter((a) => a.baseImpressions > 0).length,
    top,
    newAboveThreshold,
  };
}

// ---------------------------------------------------------------------------
// Pure core 3 — new-audience strain (the pool, not the budget)
// ---------------------------------------------------------------------------

/**
 * Reach per currency unit falling INSIDE a component, while that component's
 * spend held, is the audience pool tightening — the money bought the same
 * people again. Falling reach on falling spend is just less money, which is
 * why the spend gate is there.
 */
export function audienceStrain(componentWindows: ComponentWindow[]): AudienceStrainRead {
  const strained: StrainedComponent[] = [];
  let checked = 0;
  for (const c of componentWindows) {
    if (c.curSpend <= 0 || c.baseSpend <= 0 || c.curReach <= 0 || c.baseReach <= 0) continue;
    checked += 1;
    const cur = c.curReach / c.curSpend;
    const base = c.baseReach / c.baseSpend;
    const reachPerSpendPct = cur / base - 1;
    const spendPct = c.curSpend / c.baseSpend - 1;
    if (reachPerSpendPct >= -STRAIN_REACH_DROP) continue;
    if (Math.abs(spendPct) > STRAIN_SPEND_HELD) continue;
    strained.push({
      key: c.key,
      name: c.name,
      curReachPerCurrency: cur,
      baseReachPerCurrency: base,
      reachPerSpendPct,
      spendPct,
      curSpend: c.curSpend,
    });
  }
  strained.sort((a, b) => b.curSpend - a.curSpend);
  return { strained, checked };
}

// ---------------------------------------------------------------------------
// Pure core 4 — the creative refresh read
// ---------------------------------------------------------------------------

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Two readings of the creative roster, both from spend dates alone:
 *
 *  1. REFRESH — days since a genuinely new creative last took ≥1% of a day's
 *     account spend. "Genuinely new" means its first-ever spend day is inside
 *     the fetched history: an ad already spending on the first day on file is
 *     older than we can see, and is never called new. A creative that only
 *     trickles on day one still counts at its first spend date as long as it
 *     reached 1% of a day within NEW_CREATIVE_LANDING_DAYS — a launch that
 *     takes a few days to get budget is still a launch.
 *  2. CONCENTRATION — how few creatives carry 80% of the current window's
 *     spend, and their median age. Pooled by ad NAME, the same convention the
 *     intraday pulse uses: one creative split across five ad sets is one
 *     creative, not five.
 */
export function creativeRefreshRead(
  adRows: AdDailyRow[],
  currentWindow: DateWindow,
): CreativeRefreshRead {
  const empty: CreativeRefreshRead = {
    daysSinceNewCreative: null,
    lastNewCreativeDate: null,
    lastNewCreativeName: null,
    carrierCount: 0,
    carrierSharePct: 0,
    carriers: [],
    medianAgeDays: null,
    totalCreatives: 0,
    historyStart: null,
    ageIsFloor: false,
  };
  const spending = adRows.filter((r) => r.spend > 0);
  if (!spending.length) return empty;

  const historyStart = spending.reduce((min, r) => (r.date < min ? r.date : min), spending[0]!.date);

  // Account spend per day, and each ad's first-ever spend date.
  const dailySpend = new Map<string, number>();
  const firstSpendByAd = new Map<string, string>();
  const nameByAd = new Map<string, string>();
  const rowsByAd = new Map<string, AdDailyRow[]>();
  for (const r of spending) {
    dailySpend.set(r.date, (dailySpend.get(r.date) ?? 0) + r.spend);
    const prev = firstSpendByAd.get(r.ad_id);
    if (!prev || r.date < prev) firstSpendByAd.set(r.ad_id, r.date);
    if (!nameByAd.has(r.ad_id)) nameByAd.set(r.ad_id, r.ad_name ?? r.ad_id);
    const list = rowsByAd.get(r.ad_id);
    if (list) list.push(r);
    else rowsByAd.set(r.ad_id, [r]);
  }

  // 1. The refresh read.
  let lastNewCreativeDate: string | null = null;
  let lastNewCreativeName: string | null = null;
  for (const [adId, first] of firstSpendByAd) {
    if (first <= historyStart) continue; // already running before the history
    if (first > currentWindow.end) continue;
    if (lastNewCreativeDate && first <= lastNewCreativeDate) continue;
    const landedBy = new Date(
      Date.parse(`${first}T12:00:00Z`) + NEW_CREATIVE_LANDING_DAYS * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const took = (rowsByAd.get(adId) ?? []).some(
      (r) =>
        r.date <= landedBy &&
        r.date <= currentWindow.end &&
        r.spend >= NEW_CREATIVE_DAY_SHARE * (dailySpend.get(r.date) ?? 0),
    );
    if (!took) continue;
    lastNewCreativeDate = first;
    lastNewCreativeName = nameByAd.get(adId) ?? adId;
  }

  // 2. The concentration read, pooled by creative name.
  const windowRows = spending.filter(
    (r) => r.date >= currentWindow.start && r.date <= currentWindow.end,
  );
  const byName = new Map<string, { spend: number; firstSpend: string }>();
  for (const r of windowRows) {
    const name = r.ad_name ?? r.ad_id;
    const first = firstSpendByAd.get(r.ad_id) ?? r.date;
    const cur = byName.get(name);
    if (cur) {
      cur.spend += r.spend;
      if (first < cur.firstSpend) cur.firstSpend = first;
    } else {
      byName.set(name, { spend: r.spend, firstSpend: first });
    }
  }
  const windowSpend = [...byName.values()].reduce((s, v) => s + v.spend, 0);
  const ranked = [...byName.entries()].sort((a, b) => b[1].spend - a[1].spend);

  const carriers: CreativeCarrier[] = [];
  let cumulative = 0;
  let ageIsFloor = false;
  for (const [name, v] of ranked) {
    if (windowSpend <= 0) break;
    carriers.push({
      name,
      spend: v.spend,
      share: v.spend / windowSpend,
      ageDays: daysBetween(v.firstSpend, currentWindow.end),
    });
    if (v.firstSpend <= historyStart) ageIsFloor = true;
    cumulative += v.spend;
    if (cumulative / windowSpend >= CONCENTRATION_TARGET) break;
  }

  const ages = carriers.map((c) => c.ageDays).filter((a): a is number => a !== null);

  return {
    daysSinceNewCreative: lastNewCreativeDate
      ? daysBetween(lastNewCreativeDate, currentWindow.end)
      : null,
    lastNewCreativeDate,
    lastNewCreativeName,
    carrierCount: carriers.length,
    carrierSharePct: windowSpend > 0 ? cumulative / windowSpend : 0,
    carriers,
    medianAgeDays: median(ages),
    totalCreatives: byName.size,
    historyStart,
    ageIsFloor,
  };
}

// ---------------------------------------------------------------------------
// Pure core 5 — component sets (campaigns always, categories where configured)
// ---------------------------------------------------------------------------

/**
 * The brief's own category semantics, to the letter (composeCategoryLines):
 * first rule whose pattern is a SUBSTRING of the campaign name wins, otherwise
 * the configured default. Two surfaces disagreeing about which campaign is a
 * "Juice" would be worse than having no categories at all.
 */
export function categorize(campaignName: string, config: CategoryConfig): string {
  for (const rule of config.rules) {
    if ((rule.patterns ?? []).some((p) => campaignName.includes(p))) return rule.category;
  }
  return config.defaultCategory;
}

export interface Sums {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
}

function emptySums(): Sums {
  return { spend: 0, impressions: 0, reach: 0, clicks: 0 };
}

export interface ComponentSet {
  label: 'category' | 'campaign';
  entries: Array<{ key: string; name: string; cur: Sums; base: Sums }>;
}

/**
 * Pool campaign-days into the components the vital is best explained by.
 * A campaign with no name on file is named by its id rather than dropped —
 * dropping it would silently shrink the account the decomposition claims to
 * explain.
 */
export function buildComponentSet(
  rows: CampaignDailyRow[],
  current: DateWindow,
  baseline: DateWindow,
  by: 'category' | 'campaign',
  category?: CategoryConfig | null,
): ComponentSet {
  const entries = new Map<string, { key: string; name: string; cur: Sums; base: Sums }>();
  for (const r of rows) {
    const inCur = r.date >= current.start && r.date <= current.end;
    const inBase = r.date >= baseline.start && r.date <= baseline.end;
    if (!inCur && !inBase) continue;
    const campaignName = r.campaign_name ?? r.campaign_id;
    const id =
      by === 'category' && category
        ? (() => {
            const cat = categorize(campaignName, category);
            return { key: cat, name: category.names[cat] ?? cat };
          })()
        : { key: r.campaign_id, name: truncateName(campaignName) };
    let entry = entries.get(id.key);
    if (!entry) {
      entry = { key: id.key, name: id.name, cur: emptySums(), base: emptySums() };
      entries.set(id.key, entry);
    }
    const sums = inCur ? entry.cur : entry.base;
    sums.spend += r.spend;
    sums.impressions += r.impressions;
    sums.reach += r.reach ?? 0;
    sums.clicks += r.link_clicks;
  }
  return { label: by, entries: [...entries.values()] };
}

/** Ad-set windows for the frequency read, from adset_daily's deduped reach. */
export function buildAdsetWindows(
  rows: AdsetDailyRow[],
  current: DateWindow,
  baseline: DateWindow,
): AdsetWindow[] {
  const out = new Map<string, AdsetWindow>();
  for (const r of rows) {
    const inCur = r.date >= current.start && r.date <= current.end;
    const inBase = r.date >= baseline.start && r.date <= baseline.end;
    if (!inCur && !inBase) continue;
    let entry = out.get(r.adset_id);
    if (!entry) {
      entry = {
        key: r.adset_id,
        name: r.adset_name ?? r.adset_id,
        curImpressions: 0,
        curReach: 0,
        baseImpressions: 0,
        baseReach: 0,
      };
      out.set(r.adset_id, entry);
    }
    if (inCur) {
      entry.curImpressions += r.impressions;
      entry.curReach += r.reach ?? 0;
    } else {
      entry.baseImpressions += r.impressions;
      entry.baseReach += r.reach ?? 0;
    }
  }
  return [...out.values()];
}

/**
 * campaign_daily is the component source; when it is empty (an account the
 * warehouse only fills at ad level) the ad rows stand in. The reach they carry
 * is a SUM of ad-level reach and double-counts people, so it is only ever used
 * as a ratio whose CHANGE is quoted — never as a count.
 */
export function campaignRowsFromAdRows(
  adRows: AdDailyRow[],
  campaignNames: Map<string, string>,
): CampaignDailyRow[] {
  const byKey = new Map<string, CampaignDailyRow>();
  for (const r of adRows) {
    if (!r.campaign_id) continue;
    const key = `${r.date}|${r.campaign_id}`;
    let row = byKey.get(key);
    if (!row) {
      row = {
        date: r.date,
        campaign_id: r.campaign_id,
        campaign_name: campaignNames.get(r.campaign_id) ?? null,
        spend: 0,
        impressions: 0,
        reach: 0,
        link_clicks: 0,
      };
      byKey.set(key, row);
    }
    row.spend += r.spend;
    row.impressions += r.impressions;
    row.reach = (row.reach ?? 0) + (r.reach ?? 0);
    row.link_clicks += r.link_clicks;
  }
  return [...byKey.values()];
}

/** The same stand-in for ad sets: pooled ad reach understates frequency, so
 *  this fallback can only ever be conservative — it never invents a carrier. */
export function adsetRowsFromAdRows(adRows: AdDailyRow[]): AdsetDailyRow[] {
  const byKey = new Map<string, AdsetDailyRow>();
  for (const r of adRows) {
    if (!r.adset_id) continue;
    const key = `${r.date}|${r.adset_id}`;
    let row = byKey.get(key);
    if (!row) {
      row = { date: r.date, adset_id: r.adset_id, adset_name: null, impressions: 0, reach: 0 };
      byKey.set(key, row);
    }
    row.impressions += r.impressions;
    row.reach = (row.reach ?? 0) + (r.reach ?? 0);
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Pure core 6 — the voice
// ---------------------------------------------------------------------------

type NameFn = (c: { key: string; name: string }) => string;

function shapeSentence(d: RateDecomposition, metric: RateMetric, currency: string, label: ComponentLabel, nameOf: NameFn): string | null {
  if (!d.shapeChanged || d.baseRate === null) return null;
  const noun = RATE_NOUN[metric];
  const top = d.topEntrant;
  const entrantBit =
    top && top.curRate !== null
      ? ` (biggest: ${nameOf(top)} on ${sharePct(top.curShare)} of delivery at ${rateValue(metric, top.curRate, currency)} ${noun}, against the account's ${rateValue(metric, d.baseRate, currency)} in the baseline window)`
      : '';
  return `${sharePct(d.entrantShare)} of delivery now sits in ${LABEL_PLURAL[label]} that had none in the baseline window${entrantBit}, so this is an account that changed shape and mix cannot be told from within cleanly.`;
}

function survivorSentence(d: RateDecomposition, metric: RateMetric, currency: string, label: ComponentLabel, nameOf: NameFn): string | null {
  const s = d.survivor;
  if (!s || s.curRate === null || s.baseRate === null) return null;
  const rel = s.baseRate > 0 ? s.curRate / s.baseRate - 1 : null;
  if (rel === null || Math.abs(rel) < 0.05) {
    return `Like for like, the one ${label} running in both windows (${nameOf(s)}) held at ${rateValue(metric, s.curRate, currency)} ${RATE_NOUN[metric]}.`;
  }
  return `Like for like, ${nameOf(s)} — running in both windows — went ${rateValue(metric, s.baseRate, currency)} → ${rateValue(metric, s.curRate, currency)} ${RATE_NOUN[metric]} (${pctSigned(rel)}) on ${sharePct(s.curShare)} of delivery.`;
}

/**
 * "toward" or "away from", by the component's OWN share move — never assumed.
 * A CPM fall is just as often delivery leaving an expensive campaign as it is
 * delivery arriving at a cheap one, and calling the first one "toward" would
 * be a sentence that says the opposite of what happened.
 */
function shareMove(c: RateContribution, metric: RateMetric, currency: string, nameOf: NameFn): string {
  const gained = c.curShare > c.baseShare;
  const rate = gained ? (c.curRate ?? c.baseRate) : (c.baseRate ?? c.curRate);
  const rateBit = rate !== null ? ` (${rateValue(metric, rate, currency)})` : '';
  return `${gained ? 'toward' : 'away from'} ${nameOf(c)}${rateBit} at ${sharePct(c.baseShare)} → ${sharePct(c.curShare)}`;
}

function mixSentence(d: RateDecomposition, metric: RateMetric, currency: string, label: ComponentLabel, nameOf: NameFn): string | null {
  if (!d.readable || d.mixPct === null) return null;
  if (Math.abs(d.mixPct) < MIN_VOICED_TERM) return null;
  const noun = RATE_NOUN[metric];
  const move = (d.delta ?? 0) > 0 ? 'rise' : 'fall';
  // A negative mix term means the split pushed the OTHER way. Saying "83% of
  // the fall is within" when the number is −83% would invert the finding, so
  // the sign gets its own sentence rather than being rounded away.
  if (d.mixPct < 0) {
    return `The ${label} split worked against the ${noun} ${move} (mix ${pctSigned(d.mixPct)} of it) — where delivery went would have pushed ${noun} the other way.`;
  }
  const top = d.topMix;
  if (!top) return null;
  const offset = d.counterMix
    ? `, offset by the move ${shareMove(d.counterMix, metric, currency, nameOf)}`
    : '';
  return `${pctMag(d.mixPct)} of the ${noun} ${move} is mix: delivery moved ${shareMove(top, metric, currency, nameOf)} of the ${label} split${offset}.`;
}

function withinSentence(d: RateDecomposition, metric: RateMetric, currency: string, label: ComponentLabel, nameOf: NameFn): string | null {
  if (!d.readable || d.withinPct === null) return null;
  if (Math.abs(d.withinPct) < MIN_VOICED_TERM) return null;
  const noun = RATE_NOUN[metric];
  const move = (d.delta ?? 0) > 0 ? 'rise' : 'fall';
  if (d.withinPct < 0) {
    return `The components' own ${noun}s pushed back against the ${move} (${pctSigned(d.withinPct)} of it), so the delivery split carries more than the whole move on its own.`;
  }
  const top = d.topWithin;
  if (!top || top.curRate === null || top.baseRate === null) {
    return `${pctMag(d.withinPct)} of the ${noun} ${move} is within-component — no single ${label} carries it, the same ones moved across the board.`;
  }
  const rel = top.baseRate > 0 ? top.curRate / top.baseRate - 1 : null;
  const relBit = rel !== null ? ` (${pctSigned(rel)})` : '';
  return `${pctMag(d.withinPct)} of the ${noun} ${move} is within-component: ${nameOf(top)} itself went ${rateValue(metric, top.baseRate, currency)} → ${rateValue(metric, top.curRate, currency)}${relBit} on ${sharePct(top.curShare)} of delivery.`;
}

/**
 * What the named components do not carry. Deliberately silent once the terms
 * offset each other past the whole move (|remainder| > 1): at that point the
 * number is arithmetic residue, not a finding, and the mix/within sentences
 * have already said that the components pull against each other.
 */
function remainderSentence(d: RateDecomposition, label: ComponentLabel): string | null {
  if (!d.readable || d.remainderPct === null || d.shapeChanged) return null;
  if (Math.abs(d.remainderPct) > 1) return null;
  if (d.remainderPct > 0.25) {
    return `The remaining ${pctMag(d.remainderPct)} is spread across the other ${LABEL_PLURAL[label]} — no single one to point at.`;
  }
  if (d.remainderPct < -0.1) {
    return `Other ${LABEL_PLURAL[label]} pushed back by ${pctMag(d.remainderPct)}, so the two named above carry more than the whole move on their own.`;
  }
  return null;
}

function carrierSentence(
  read: FrequencyCarrierRead,
  accountFrequency?: { cur: number | null; base: number | null },
  allowOverlapRead = true,
): string | null {
  if (read.carriers.length) {
    const n = read.carriers.length;
    const lowest = Math.min(...read.carriers.map((c) => c.curFrequency));
    const top = read.carriers[0]!;
    const extra =
      read.newAboveThreshold > 0
        ? ` ${read.newAboveThreshold} more ${read.newAboveThreshold === 1 ? 'sits' : 'sit'} above ${CARRIER_FREQUENCY.toFixed(1)} but started after the baseline, so they cannot be called rising.`
        : '';
    return (
      `Frequency is carried by ${n} ad set${n === 1 ? '' : 's'}, all above ${lowest.toFixed(1)} daily and climbing against the baseline, together ${sharePct(read.impressionShare)} of impressions ` +
      `(worst: "${truncateName(top.name)}" at ${top.curFrequency.toFixed(2)} from ${top.baseFrequency!.toFixed(2)}).${extra}`
    );
  }

  // No carrier, but the account is above the bar: that is not a shrug, it is
  // arithmetic. Impressions are additive and reach is not, so an account
  // frequency above EVERY ad set's own figure can only mean those ad sets are
  // reaching the same people — overlap, not per-ad-set fatigue.
  const acct = accountFrequency?.cur ?? null;
  if (!allowOverlapRead || !read.top || acct === null) return null;
  if (acct <= read.top.curFrequency) return null;
  const fragmentation =
    read.entitiesBaseline > 0
      ? `${read.entitiesCurrent} ad sets delivered against ${read.entitiesBaseline} in the baseline window`
      : `${read.entitiesCurrent} ad sets delivered in the window`;
  return (
    `No single ad set is above ${CARRIER_FREQUENCY.toFixed(1)} daily — the highest is "${truncateName(read.top.name)}" at ${read.top.curFrequency.toFixed(2)} on ${sharePct(read.top.impressionShare)} of impressions — yet the account pools ${acct.toFixed(2)}, ` +
    `which is only arithmetically possible if the ad sets are reaching the same people: ${fragmentation}, and their audiences overlap.`
  );
}

function strainSentence(read: AudienceStrainRead, currency: string, label: ComponentLabel, nameOf: NameFn): string | null {
  if (!read.strained.length) return null;
  const bits = read.strained
    .slice(0, 2)
    .map(
      (s) =>
        `${nameOf(s)} ${pctSigned(s.reachPerSpendPct)} reach per unit spent on ${moneyCompact(s.curSpend, currency)} (spend ${pctSigned(s.spendPct)})`,
    );
  return `The pool is tightening inside the ${LABEL_PLURAL[label]}, not just account-wide: ${bits.join('; ')} — the audience, not the budget.`;
}

function budgetSentence(spend: { cur: number | null; base: number | null } | undefined, currency: string, strain: AudienceStrainRead | null | undefined): string | null {
  if (!spend || spend.cur === null || spend.base === null || spend.base <= 0) return null;
  const rel = spend.cur / spend.base - 1;
  if (Math.abs(rel) <= STRAIN_SPEND_HELD) return null;
  const checked = strain?.checked ?? 0;
  return `This tracks the budget, not the audience: spend went ${moneyCompact(spend.base, currency)}/day → ${moneyCompact(spend.cur, currency)}/day (${pctSigned(rel)}), and of the ${checked} component${checked === 1 ? '' : 's'} readable in both windows none lost more than ${pctMag(STRAIN_REACH_DROP)} of its reach per unit spent while holding its budget.`;
}

function refreshSentence(read: CreativeRefreshRead, currency: string): string | null {
  if (!read.carrierCount) return null;
  const spend = read.carriers.reduce((s, c) => s + c.spend, 0);
  const age =
    read.medianAgeDays !== null
      ? `, median age ${Math.round(read.medianAgeDays)} days${read.ageIsFloor ? ' or more (some were already running before the history on file)' : ''}`
      : '';
  const refresh =
    read.daysSinceNewCreative === null
      ? ' Nothing genuinely new has taken 1% of a day since the history on file starts.'
      : read.daysSinceNewCreative > 14
        ? ` Nothing new has taken 1% of a day's spend in ${read.daysSinceNewCreative} days.`
        : ` The newest creative to take 1% of a day landed ${read.daysSinceNewCreative} days ago ("${truncateName(read.lastNewCreativeName ?? '')}").`;
  return `${read.carrierCount} of ${read.totalCreatives} creative${read.totalCreatives === 1 ? '' : 's'} carry ${sharePct(read.carrierSharePct)} of the window's ${moneyCompact(spend, currency)}${age}.${refresh}`;
}

/**
 * The why under one macro line: 1–3 sentences and one suggested move.
 *
 * Voice rules enforced here: currency amounts lead every money quantity,
 * components are NAMED, the part that is not attributed is said out loud, and
 * no line uses a relative day-word ("yesterday", "today") — a Monday block is
 * read on Tuesday too.
 *
 * `categoryNames` optionally renames components at compose time (key → label),
 * for callers that resolved their display names later than their keys.
 *
 * Returns null when nothing could be decomposed: no why is better than a
 * confident one built on nothing.
 */
export function composeMacroWhy(
  target: MacroWhyTarget,
  parts: MacroWhyParts,
  currency: string,
  categoryNames?: Record<string, string>,
): MacroWhy | null {
  const label = target.componentLabel;
  const nameOf: NameFn = (c) => categoryNames?.[c.key] ?? c.name;
  const sentences: string[] = [];
  const evidence: Record<string, unknown> = {
    target: target.kind === 'chord' ? `chord:${target.chordId}` : target.vital,
    component: label,
  };

  if (parts.detailStartsAt) {
    // The design's honesty rule: no baseline detail, no decomposition — say
    // where the detail begins instead of quietly comparing against nothing.
    return {
      text: `Component detail starts ${shortDayLabel(parts.detailStartsAt)}; before that the warehouse holds account-level rows only, so this move cannot be split by ${label}.`,
      next: `no call from the split yet — the ${label} decomposition becomes readable once the baseline window sits inside the detail history`,
      evidence: { ...evidence, detail_starts_at: parts.detailStartsAt },
    };
  }

  const rate = parts.rate;
  const metric = parts.rateMetric ?? 'cpm';
  const quotesRate = Boolean(rate?.readable) && metric !== 'reach-per-spend';

  // 1. The rate decomposition (CPM, CTR) — or the honest "different account".
  if (rate && quotesRate) {
    if (rate.shapeChanged) {
      const shape = shapeSentence(rate, metric, currency, label, nameOf);
      const survivor = survivorSentence(rate, metric, currency, label, nameOf);
      if (shape) sentences.push(shape);
      if (survivor) sentences.push(survivor);
    } else {
      const mixLed = (rate.mixPct ?? 0) >= (rate.withinPct ?? 0);
      const first = mixLed
        ? mixSentence(rate, metric, currency, label, nameOf)
        : withinSentence(rate, metric, currency, label, nameOf);
      const second = mixLed
        ? withinSentence(rate, metric, currency, label, nameOf)
        : mixSentence(rate, metric, currency, label, nameOf);
      if (first) sentences.push(first);
      if (second) sentences.push(second);
    }
    evidence.rate = {
      metric,
      cur: rate.curRate,
      base: rate.baseRate,
      mix_pct: rate.mixPct,
      within_pct: rate.withinPct,
      remainder_pct: rate.remainderPct,
      entrant_share: rate.entrantShare,
      shape_changed: rate.shapeChanged,
      top_mix: rate.topMix ? { name: nameOf(rate.topMix), pct: rate.topMix.mixPctOfDelta } : null,
      top_within: rate.topWithin
        ? { name: nameOf(rate.topWithin), pct: rate.topWithin.withinPctOfDelta }
        : null,
      folded: rate.folded,
    };
  }

  // 2. Frequency carriers (or the overlap proof when there are none).
  const carriers = parts.carriers;
  const carrierLine = carriers
    ? carrierSentence(carriers, parts.accountFrequency, parts.overlapRead ?? true)
    : null;
  if (carrierLine) {
    sentences.push(carrierLine);
    evidence.carriers = {
      count: carriers!.carriers.length,
      impression_share: carriers!.impressionShare,
      entities_current: carriers!.entitiesCurrent,
      entities_baseline: carriers!.entitiesBaseline,
      named: carriers!.carriers.slice(0, 3).map((c) => ({
        name: c.name,
        frequency: c.curFrequency,
        baseline: c.baseFrequency,
        impression_share: c.impressionShare,
      })),
      top: carriers!.top ? { name: carriers!.top.name, frequency: carriers!.top.curFrequency } : null,
      new_above_threshold: carriers!.newAboveThreshold,
    };
  }

  // 3. Audience strain — or, when the budget itself moved, that instead.
  const strain = parts.strain;
  const strainLine = strain ? strainSentence(strain, currency, label, nameOf) : null;
  if (strainLine) {
    sentences.push(strainLine);
    evidence.strain = strain!.strained.slice(0, 3).map((s) => ({
      name: nameOf(s),
      reach_per_spend_pct: s.reachPerSpendPct,
      spend_pct: s.spendPct,
      cur_spend: s.curSpend,
    }));
  } else if (strain && parts.spendContext) {
    const budget = budgetSentence(parts.spendContext, currency, strain);
    if (budget) {
      sentences.push(budget);
      evidence.spend = parts.spendContext;
    }
  }

  // 4. The creative roster.
  const refresh = parts.refresh;
  const refreshLine = refresh ? refreshSentence(refresh, currency) : null;
  if (refreshLine) {
    sentences.push(refreshLine);
    evidence.refresh = {
      days_since_new_creative: refresh!.daysSinceNewCreative,
      carrier_count: refresh!.carrierCount,
      carrier_share: refresh!.carrierSharePct,
      median_age_days: refresh!.medianAgeDays,
      total_creatives: refresh!.totalCreatives,
    };
  }

  // 5. The honest remainder, if there is still room for it.
  const remainder = rate && quotesRate ? remainderSentence(rate, label) : null;
  if (remainder && sentences.length < 3) sentences.push(remainder);

  if (!sentences.length) return null;

  return {
    text: sentences.slice(0, 3).join(' '),
    next: suggestMove(target, parts, currency, nameOf),
    evidence,
  };
}

/** One move, and only one — the reader must never end asking "so what?". */
function suggestMove(
  target: MacroWhyTarget,
  parts: MacroWhyParts,
  currency: string,
  nameOf: NameFn,
): string {
  const { rate, carriers, strain, refresh } = parts;
  const label = target.componentLabel;
  const fatigue = (carriers?.carriers.length ?? 0) > 0;
  const stale =
    !!refresh &&
    refresh.carrierCount > 0 &&
    (refresh.daysSinceNewCreative === null || refresh.daysSinceNewCreative > STALE_REFRESH_DAYS);
  const overlap =
    !fatigue &&
    (parts.overlapRead ?? true) &&
    !!carriers?.top &&
    (parts.accountFrequency?.cur ?? 0) > carriers.top.curFrequency &&
    carriers.entitiesCurrent > carriers.entitiesBaseline;
  const spend = parts.spendContext;
  const spendMoved =
    !!spend &&
    spend.cur !== null &&
    spend.base !== null &&
    spend.base > 0 &&
    Math.abs(spend.cur / spend.base - 1) > STRAIN_SPEND_HELD;

  if (fatigue && stale) {
    return `the lever is a creative refresh in "${truncateName(carriers!.carriers[0]!.name)}", not a budget change — the same people are seeing the same ads`;
  }
  if (fatigue) {
    return `widen or split "${truncateName(carriers!.carriers[0]!.name)}" before adding budget — more spend into that pool buys frequency, not people`;
  }
  if (overlap) {
    return `the lever is consolidation, not budget — ${carriers!.entitiesCurrent} ad sets competing for one audience is what is driving the repeat exposure, so merge or exclude before adding more`;
  }
  if (strain?.strained.length) {
    const s = strain.strained[0]!;
    return `${nameOf(s)} is the constraint: widen its targeting or refresh its creative and hold the ${moneyCompact(s.curSpend, currency)} rather than raising it`;
  }
  if (target.vital === 'reach' && spendMoved && spend?.cur !== null && spend?.base !== null) {
    return `read this against the budget, not the baseline level — at ${moneyCompact(spend!.cur!, currency)}/day against ${moneyCompact(spend!.base!, currency)}/day the footprint is bought, so judge it on cost per result`;
  }
  if (rate?.readable && rate.shapeChanged) {
    return `judge this against the new shape, not the old baseline — set a target for ${rate.topEntrant ? nameOf(rate.topEntrant) : `the new ${LABEL_PLURAL[label]}`} before reading the account average again`;
  }
  if (rate?.readable && rate.topMix && (rate.mixPct ?? 0) >= 0.5) {
    return `the lever is the ${nameOf(rate.topMix)} mix, not the total budget — decide whether that shift is wanted before topping anything up`;
  }
  if (rate?.readable && (rate.withinPct ?? 0) > 0.5 && !rate.topWithin) {
    return `nothing in the mix to fix — this is the auction moving, so hold budgets and judge the account on cost per result`;
  }
  if (rate?.readable && rate.topWithin) {
    return `dig into ${nameOf(rate.topWithin)} specifically — it moved on its own, so the fix is inside it, not in the account total`;
  }
  if (stale && refresh) {
    return `line up a genuinely new creative — the roster carrying spend is ${refresh.medianAgeDays !== null ? `${Math.round(refresh.medianAgeDays)} days old on median` : 'old'} and nothing new has taken real spend`;
  }
  return `no single ${label} carries this — hold, and re-read it against the same baseline next week`;
}

// ---------------------------------------------------------------------------
// Orchestration (pure) — from rows to a why per pulse item
// ---------------------------------------------------------------------------

export interface MacroWhyContext {
  adRows: AdDailyRow[];
  campaignRows: CampaignDailyRow[];
  adsetRows: AdsetDailyRow[];
  category?: CategoryConfig | null;
  currentWindow: DateWindow;
  baselineWindow: DateWindow;
  currency: string;
  /** Account-level figures the pulse already computed, for the honest reads. */
  accountFrequency?: { cur: number | null; base: number | null };
  spendContext?: { cur: number | null; base: number | null };
}

function inWindow(date: string, w: DateWindow): boolean {
  return date >= w.start && date <= w.end;
}

/**
 * Categories when the client configures them AND they actually split the
 * account (one bucket explains nothing); campaigns otherwise. This is the
 * design's "categories where category_parsing rules exist — PL" rule with the
 * degenerate case removed.
 */
function rateComponents(ctx: MacroWhyContext): { set: ComponentSet; label: 'category' | 'campaign' } {
  if (ctx.category?.rules?.length) {
    const cats = buildComponentSet(
      ctx.campaignRows,
      ctx.currentWindow,
      ctx.baselineWindow,
      'category',
      ctx.category,
    );
    if (cats.entries.length > 1) return { set: cats, label: 'category' };
  }
  return {
    set: buildComponentSet(ctx.campaignRows, ctx.currentWindow, ctx.baselineWindow, 'campaign'),
    label: 'campaign',
  };
}

/**
 * The why for one voiced vital or chord. Pure: everything it needs is in ctx,
 * which is what lets the tests run the whole path without a database.
 */
export function macroWhyFor(
  item: { kind: 'vital' | 'chord'; vital?: VitalName; chordId?: string; direction: 'up' | 'down' },
  ctx: MacroWhyContext,
): MacroWhy | null {
  if (!ctx.campaignRows.length && !ctx.adRows.length) return null;

  // The design's honesty rule: a decomposition needs BOTH windows populated.
  const hasBaselineDetail = ctx.campaignRows.some(
    (r) => inWindow(r.date, ctx.baselineWindow) && r.spend > 0,
  );
  const detailStartsAt = hasBaselineDetail
    ? null
    : ctx.campaignRows.concat().sort((a, b) => a.date.localeCompare(b.date))[0]?.date ??
      ctx.adRows.concat().sort((a, b) => a.date.localeCompare(b.date))[0]?.date ??
      null;

  const { set, label } = rateComponents(ctx);
  const strainComponents: ComponentWindow[] = set.entries.map((e) => ({
    key: e.key,
    name: e.name,
    curSpend: e.cur.spend,
    curReach: e.cur.reach,
    baseSpend: e.base.spend,
    baseReach: e.base.reach,
  }));

  const cpm = (): RateDecomposition =>
    decomposeRate(
      set.entries.map((e) => ({
        key: e.key,
        name: e.name,
        curNum: e.cur.spend,
        curDen: e.cur.impressions,
        baseNum: e.base.spend,
        baseDen: e.base.impressions,
      })),
      { scale: 1000 },
    );
  const ctr = (): RateDecomposition =>
    decomposeRate(
      set.entries.map((e) => ({
        key: e.key,
        name: e.name,
        curNum: e.cur.clicks,
        curDen: e.cur.impressions,
        baseNum: e.base.clicks,
        baseDen: e.base.impressions,
      })),
    );
  const freq = (): FrequencyCarrierRead =>
    frequencyCarriers(buildAdsetWindows(ctx.adsetRows, ctx.currentWindow, ctx.baselineWindow));
  const strain = (): AudienceStrainRead => audienceStrain(strainComponents);
  const refresh = (): CreativeRefreshRead => creativeRefreshRead(ctx.adRows, ctx.currentWindow);

  const shared = {
    detailStartsAt,
    accountFrequency: ctx.accountFrequency,
    spendContext: ctx.spendContext,
  };
  const base = { direction: item.direction, componentLabel: label } as const;

  if (item.kind === 'chord') {
    switch (item.chordId) {
      case 'top-of-funnel-narrowing':
        return composeMacroWhy(
          { kind: 'chord', chordId: item.chordId, ...base },
          { ...shared, rate: cpm(), rateMetric: 'cpm', carriers: freq(), strain: strain(), refresh: refresh() },
          ctx.currency,
        );
      case 'healthy-expansion':
        return composeMacroWhy(
          { kind: 'chord', chordId: item.chordId, ...base },
          { ...shared, rate: cpm(), rateMetric: 'cpm', strain: strain(), refresh: refresh() },
          ctx.currency,
        );
      case 'auction-inflation':
      default:
        return composeMacroWhy(
          { kind: 'chord', chordId: item.chordId ?? 'unknown', ...base },
          { ...shared, rate: cpm(), rateMetric: 'cpm' },
          ctx.currency,
        );
    }
  }

  // One read per line, deliberately: the price lines get the mix/within split,
  // the audience lines get the audience reads. Every bullet repeating the same
  // sentence would be four times the words and none of the extra meaning.
  switch (item.vital) {
    case 'cpm':
      return composeMacroWhy(
        { kind: 'vital', vital: 'cpm', ...base },
        { ...shared, rate: cpm(), rateMetric: 'cpm' },
        ctx.currency,
      );
    case 'ctr':
      return composeMacroWhy(
        { kind: 'vital', vital: 'ctr', ...base },
        { ...shared, rate: ctr(), rateMetric: 'ctr' },
        ctx.currency,
      );
    case 'frequency':
      return composeMacroWhy(
        { kind: 'vital', vital: 'frequency', ...base, componentLabel: 'ad set' },
        { ...shared, carriers: freq(), refresh: refresh() },
        ctx.currency,
      );
    case 'reach':
      return composeMacroWhy(
        { kind: 'vital', vital: 'reach', ...base },
        {
          ...shared,
          rateMetric: 'reach-per-spend',
          strain: strain(),
          carriers: freq(),
          overlapRead: false,
        },
        ctx.currency,
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Data access — every read paged (PostgREST caps at 1000 rows, silently)
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function paged(
  table: string,
  columns: string,
  clientId: string,
  since: string,
  until: string,
  orderBy: string,
): Promise<Record<string, unknown>[]> {
  const pageSize = 1000;
  const raw: Record<string, unknown>[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await getSupabase()
      .from(table)
      .select(columns)
      .eq('client_id', clientId)
      .gte('date', since)
      .lte('date', until)
      .order('date', { ascending: true })
      .order(orderBy, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${table} why fetch failed: ${error.message}`);
    raw.push(...((data ?? []) as unknown as Record<string, unknown>[]));
    if (!data || data.length < pageSize) break;
  }
  return raw;
}

/**
 * The brief's `fetchAdDaily` pattern with the columns a decomposition needs
 * (reach, which the brief does not select). Full span, because a creative's
 * first-spend date is only true if it is looked for across all the history.
 */
export async function fetchAdRows(
  clientId: string,
  since: string,
  until: string,
): Promise<AdDailyRow[]> {
  const raw = await paged(
    'ad_daily',
    'date, ad_id, ad_name, adset_id, campaign_id, spend, impressions, reach, frequency, link_clicks, purchases',
    clientId,
    since,
    until,
    'ad_id',
  );
  return raw.map((r) => ({
    date: String(r.date),
    ad_id: String(r.ad_id),
    ad_name: r.ad_name ? String(r.ad_name) : null,
    adset_id: r.adset_id ? String(r.adset_id) : null,
    campaign_id: r.campaign_id ? String(r.campaign_id) : null,
    spend: num(r.spend),
    impressions: num(r.impressions),
    reach: numOrNull(r.reach),
    frequency: numOrNull(r.frequency),
    link_clicks: num(r.link_clicks),
    purchases: num(r.purchases),
  }));
}

/** campaign_daily: the component source AND the campaign_name lookup in one. */
export async function fetchCampaignRows(
  clientId: string,
  since: string,
  until: string,
): Promise<CampaignDailyRow[]> {
  const raw = await paged(
    'campaign_daily',
    'date, campaign_id, campaign_name, spend, impressions, reach, link_clicks',
    clientId,
    since,
    until,
    'campaign_id',
  );
  return raw
    .filter((r) => r.campaign_id)
    .map((r) => ({
      date: String(r.date),
      campaign_id: String(r.campaign_id),
      campaign_name: r.campaign_name ? String(r.campaign_name) : null,
      spend: num(r.spend),
      impressions: num(r.impressions),
      reach: numOrNull(r.reach),
      link_clicks: num(r.link_clicks),
    }));
}

/** adset_daily, the two windows only — the frequency read needs nothing else. */
export async function fetchAdsetRows(
  clientId: string,
  windows: DateWindow[],
): Promise<AdsetDailyRow[]> {
  const out: AdsetDailyRow[] = [];
  for (const w of windows) {
    const raw = await paged(
      'adset_daily',
      'date, adset_id, adset_name, impressions, reach',
      clientId,
      w.start,
      w.end,
      'adset_id',
    );
    for (const r of raw) {
      if (!r.adset_id) continue;
      out.push({
        date: String(r.date),
        adset_id: String(r.adset_id),
        adset_name: r.adset_name ? String(r.adset_name) : null,
        impressions: num(r.impressions),
        reach: numOrNull(r.reach),
      });
    }
  }
  return out;
}

/**
 * The client's category rules, in the shape this module wants.
 *
 * Read here rather than imported from the brief on purpose: the brief already
 * imports macro-vitals, which imports this file, and a runtime cycle across
 * the three would be a fragile way to save five lines.
 */
export async function fetchCategoryConfig(clientCode: string): Promise<CategoryConfig | null> {
  const { data } = await getSupabase()
    .from('client_configs')
    .select('config')
    .eq('client_code', clientCode)
    .maybeSingle();
  const config = (data?.config ?? null) as {
    category_parsing?: {
      rules?: Array<{ category: string; patterns?: string[] }>;
      default_category?: string;
    };
    category_targets?: Record<string, { name?: string }>;
  } | null;
  const rules = config?.category_parsing?.rules;
  if (!rules?.length) return null;
  const names: Record<string, string> = {};
  for (const [key, value] of Object.entries(config?.category_targets ?? {})) {
    if (value?.name) names[key] = value.name;
  }
  return {
    rules,
    defaultCategory: config?.category_parsing?.default_category ?? 'default',
    names,
  };
}

// ---------------------------------------------------------------------------
// Entry point — what macro-vitals calls after it has rendered the pulse
// ---------------------------------------------------------------------------

/**
 * Attach a why (and its one move) to every voiced item in a rendered pulse.
 *
 * Mutates `rendered.items` in place; the caller recomposes the lines. Returns
 * how many whys were attached.
 *
 * FAIL-OPEN, twice over: the caller only invokes this when something is
 * actually voiced (a steady account must not pay for the extra reads), and
 * `attachMacroWhysSafely` swallows any failure — the macro block reaching the
 * reader outranks its explanation.
 */
export async function attachMacroWhys(p: {
  client: { id: string; code: string };
  reads: MacroReads;
  chords: Chord[];
  rendered: RenderedPulse;
  currency: string;
}): Promise<number> {
  const { client, reads, rendered, currency } = p;
  const explainable = rendered.items.filter((i) => i.kind !== 'closure');
  if (!explainable.length) return 0;

  const currentWindow = { start: reads.currentWindow.start, end: reads.currentWindow.end };
  const baselineWindow = { start: reads.baselineWindow.start, end: reads.baselineWindow.end };
  const since =
    baselineWindow.start < currentWindow.start ? baselineWindow.start : currentWindow.start;
  const until = currentWindow.end;

  const [adRows, campaignRows, adsetRowsRaw, category] = await Promise.all([
    fetchAdRows(client.id, since, until),
    fetchCampaignRows(client.id, since, until).catch(() => [] as CampaignDailyRow[]),
    fetchAdsetRows(client.id, [baselineWindow, currentWindow]).catch(() => [] as AdsetDailyRow[]),
    fetchCategoryConfig(client.code).catch(() => null),
  ]);

  const frequencyRead = reads.vitals.find((v) => v.vital === 'frequency');
  const ctx: MacroWhyContext = {
    adRows,
    // Warehouse gaps degrade the read, they never stop it.
    campaignRows: campaignRows.length ? campaignRows : campaignRowsFromAdRows(adRows, new Map()),
    adsetRows: adsetRowsRaw.length ? adsetRowsRaw : adsetRowsFromAdRows(adRows),
    category,
    currentWindow,
    baselineWindow,
    currency,
    accountFrequency: { cur: frequencyRead?.level ?? null, base: frequencyRead?.baseline ?? null },
    spendContext: { cur: reads.spend.level, base: reads.spend.baseline },
  };

  let attached = 0;
  for (const item of explainable) {
    const read = item.vital ? reads.vitals.find((v) => v.vital === item.vital) : undefined;
    const direction: 'up' | 'down' = read?.direction === 'down' ? 'down' : 'up';
    const why = macroWhyFor(
      {
        kind: item.kind === 'chord' ? 'chord' : 'vital',
        vital: item.vital,
        chordId: item.chordId,
        direction,
      },
      ctx,
    );
    if (why) {
      item.why = why;
      attached += 1;
    }
  }
  return attached;
}

/** The same call with its failure swallowed — what macro-vitals actually uses. */
export async function attachMacroWhysSafely(p: {
  client: { id: string; code: string };
  reads: MacroReads;
  chords: Chord[];
  rendered: RenderedPulse;
  currency: string;
}): Promise<number> {
  try {
    return await attachMacroWhys(p);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), code: p.client.code },
      'macro why skipped — the pulse posts without its decomposition',
    );
    return 0;
  }
}
