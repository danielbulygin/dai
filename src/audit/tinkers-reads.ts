import { z } from 'zod';
import type { AdsetConfigLite } from './report-pack.js';
import type {
  ActivityEvent,
  AdSetNamePromise,
  DemoInsightRow,
  GeoInsightRow,
  PixelLite,
  PlacementInsightRow,
  SegmentSpendRow,
  TargetingSpecLite,
} from './report-pack-extra.js';

/**
 * The generation seam's SHAPES, and the pure mapping from them into the input
 * types the report engines already consume.
 *
 * It lives apart from tinkers-bridge.ts for two reasons. The bridge imports
 * magic-audit (it starts the run), so magic-audit cannot import the bridge back
 * — the section runners get their reads INJECTED, and this is the module both
 * halves can agree on. And a mapper is pure: a wire shape turning into a
 * `PlacementInsightRow` is unit-testable off a fixture, which is the only way
 * to know that a field their port renamed cost that field rather than the
 * section.
 *
 * Every reader here is LOOSE on purpose, the same posture as `toRawAdDay`: their
 * API ships on its own schedule, so a field this module cannot place costs that
 * field and never the read. What is NOT loose is the three-way answer below.
 * "Not deployed", "cannot read" and "the read failed" are different sentences,
 * and collapsing them is how a section ends up claiming an account has no pixel
 * when nobody ever asked.
 */

/**
 * One read's outcome.
 *
 * `not_deployed` is a 404 on the path: their endpoint is not live yet, which is
 * the state of the world while these endpoints ship, and the consuming section
 * must stay `planned` exactly as it was before this wave.
 * `unsupported` is their own `ok: false` reason — the read exists and could not
 * be served for this account, which is a skip carrying the reason as data.
 * `failed` is anything else (a 500, a dead socket, a contract we cannot parse),
 * which is the honest error a failed pull has always been.
 */
export type TinkersRead<T> =
  | { state: 'ok'; data: T; partial: boolean }
  | { state: 'not_deployed' }
  | { state: 'unsupported'; reason: string }
  | { state: 'failed'; reason: string };

/** Every outcome that is not an answer. The one `seamGapFor` takes. */
export type TinkersReadGap = Exclude<TinkersRead<unknown>, { state: 'ok' }>;

/** The reads a bridged run injects into the orchestrator. */
export interface TinkersSeamReads {
  adSets(): Promise<TinkersRead<SeamAdSet[]>>;
  adSetInsights(query: {
    since: string;
    until: string;
    granularity: 'total' | 'weekly';
  }): Promise<TinkersRead<unknown[]>>;
  breakdown(query: {
    dimension: 'placement' | 'age_gender' | 'country' | 'user_segment';
    since: string;
    until: string;
  }): Promise<TinkersRead<unknown[]>>;
  activity(query: { since: string; until: string }): Promise<TinkersRead<unknown[]>>;
  targeting(): Promise<TinkersRead<SeamTargeting>>;
  pixels(): Promise<TinkersRead<unknown[]>>;
}

export interface SeamAdSet {
  adsetId: string;
  name: string | null;
  effectiveStatus: string | null;
  optimizationGoal: string | null;
  promotedObjectEventType: string | null;
  campaignId: string | null;
}

export interface SeamTargeting {
  adSets: unknown[];
  audiences: unknown[];
}

// ---------------------------------------------------------------------------
// Wire schemas. Rows stay `unknown` and go through the readers below: a strict
// row schema would refuse a whole page because one field was renamed.
// ---------------------------------------------------------------------------

const notReady = z.object({ ok: z.literal(false), reason: z.string() });
const partialField = { partial: z.boolean().nullish() };

export const adSetsSchema = z.union([
  z.object({
    ok: z.literal(true),
    adSets: z.array(
      z.object({
        adsetId: z.string().min(1),
        name: z.string().nullish(),
        effectiveStatus: z.string().nullish(),
        optimizationGoal: z.string().nullish(),
        promotedObjectEventType: z.string().nullish(),
        campaignId: z.string().nullish(),
      }),
    ),
    ...partialField,
  }),
  notReady,
]);

export const insightRowsSchema = z.union([
  z.object({ ok: z.literal(true), rows: z.array(z.unknown()), ...partialField }),
  notReady,
]);

export const activitySchema = z.union([
  z.object({ ok: z.literal(true), changes: z.array(z.unknown()), ...partialField }),
  notReady,
]);

export const targetingSchema = z.union([
  z.object({
    ok: z.literal(true),
    adSets: z.array(z.unknown()),
    audiences: z.array(z.unknown()).nullish(),
    ...partialField,
  }),
  notReady,
]);

export const pixelsSchema = z.union([
  z.object({ ok: z.literal(true), pixels: z.array(z.unknown()), ...partialField }),
  notReady,
]);

// ---------------------------------------------------------------------------
// Primitive readers
// ---------------------------------------------------------------------------

const numOf = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

interface SeamAction {
  type: string;
  value: number;
}

function actionsOf(value: unknown): SeamAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const a = rec(entry);
    return typeof a.type === 'string' ? [{ type: a.type, value: numOf(a.value) }] : [];
  });
}

/** First matching action type, the port's own `pickAction` order. */
function pickAction(actions: SeamAction[], types: readonly string[]): number {
  for (const t of types) {
    const hit = actions.find((a) => a.type === t);
    if (hit) return hit.value;
  }
  return 0;
}

const PURCHASE_TYPES = ['omni_purchase', 'purchase'];
const LEAD_TYPES = ['lead'];

/** The figures every breakdown row contributes, whatever it is split by. */
interface RowMetrics {
  spend: number;
  impressions: number;
  purchases: number;
  purchase_value: number;
  leads: number;
}

function metricsOf(row: unknown): RowMetrics {
  const r = rec(row);
  const actions = actionsOf(r.actions);
  return {
    spend: numOf(r.spend),
    impressions: numOf(r.impressions),
    purchases: pickAction(actions, PURCHASE_TYPES),
    purchase_value: pickAction(actionsOf(r.actionValues), PURCHASE_TYPES),
    leads: pickAction(actions, LEAD_TYPES),
  };
}

/**
 * One part of a composite breakdown, BY NAME. The port sends
 * `[{dimension,value}]` in query order rather than a joined string, so a
 * consumer reads the dimension it wants and never counts on position.
 */
function partOf(row: unknown, dimension: string): string | null {
  const parts = rec(row).breakdownParts;
  if (!Array.isArray(parts)) return null;
  for (const entry of parts) {
    const p = rec(entry);
    if (p.dimension === dimension) return strOrNull(p.value);
  }
  return null;
}

const segmentValueOf = (row: unknown): string | null => strOrNull(rec(row).breakdownValue);

// ---------------------------------------------------------------------------
// Breakdown mappers
// ---------------------------------------------------------------------------

/** `dimension=placement` rows: publisher platform crossed with position. */
export function toPlacementRows(rows: readonly unknown[]): PlacementInsightRow[] {
  return rows.map((row) => ({
    publisher_platform: partOf(row, 'publisher_platform') ?? 'unknown',
    platform_position: partOf(row, 'platform_position') ?? 'unknown',
    ...metricsOf(row),
  }));
}

/** `dimension=age_gender` rows. */
export function toDemoRows(rows: readonly unknown[]): DemoInsightRow[] {
  return rows.map((row) => ({
    age: partOf(row, 'age') ?? 'unknown',
    gender: partOf(row, 'gender') ?? 'unknown',
    ...metricsOf(row),
  }));
}

/** `dimension=country` rows — one column, so the segment rides `breakdownValue`. */
export function toGeoRows(rows: readonly unknown[]): GeoInsightRow[] {
  return rows.map((row) => ({ country: segmentValueOf(row) ?? 'unknown', ...metricsOf(row) }));
}

/**
 * `dimension=user_segment` rows. The key is carried VERBATIM, `unknown`
 * included: Meta answers unknown for every impression on an account that
 * defines no segments, and turning that into a nicer word here would hide the
 * one finding the section exists to make.
 */
export function toSegmentRows(rows: readonly unknown[]): SegmentSpendRow[] {
  return rows.map((row) => ({ key: segmentValueOf(row) ?? 'unknown', ...metricsOf(row) }));
}

// ---------------------------------------------------------------------------
// Ad-set mappers
// ---------------------------------------------------------------------------

export function toAdsetConfigs(adSets: readonly SeamAdSet[]): AdsetConfigLite[] {
  return adSets.map((a) => ({
    adset_id: a.adsetId,
    adset_name: a.name ?? a.adsetId,
    optimization_goal: a.optimizationGoal,
    custom_event_type: a.promotedObjectEventType,
    effective_status: a.effectiveStatus,
  }));
}

/** Ad-set-level insight rows summed to one spend figure per ad set. */
export function toAdsetSpend(rows: readonly unknown[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const id = strOrNull(rec(row).entityId);
    if (!id) continue;
    out.set(id, (out.get(id) ?? 0) + numOf(rec(row).spend));
  }
  return out;
}

/**
 * The action types an ad set's CONFIGURED event is counted under. The learning
 * bar is about the event Meta is optimizing for, so counting purchases on an ad
 * set told to find leads would grade the wrong number.
 *
 * A config this map cannot place answers null, and the caller then falls back to
 * the account's own conversion count rather than inventing an event.
 */
export function optimizationActionTypes(config: {
  optimization_goal: string | null;
  custom_event_type: string | null;
}): string[] | null {
  const event = (config.custom_event_type ?? '').toUpperCase();
  const byEvent: Record<string, string[]> = {
    PURCHASE: PURCHASE_TYPES,
    LEAD: LEAD_TYPES,
    COMPLETE_REGISTRATION: ['complete_registration', 'omni_complete_registration'],
    ADD_TO_CART: ['add_to_cart', 'omni_add_to_cart'],
    INITIATED_CHECKOUT: ['initiate_checkout', 'omni_initiated_checkout'],
    CONTENT_VIEW: ['view_content', 'omni_view_content'],
    SEARCH: ['search', 'omni_search'],
    SUBSCRIBE: ['subscribe'],
    START_TRIAL: ['start_trial'],
  };
  const byEventTypes = byEvent[event];
  if (byEventTypes) return byEventTypes;
  const goal = (config.optimization_goal ?? '').toUpperCase();
  const byGoal: Record<string, string[]> = {
    LEAD_GENERATION: LEAD_TYPES,
    QUALITY_LEAD: LEAD_TYPES,
    LINK_CLICKS: ['link_click'],
    LANDING_PAGE_VIEWS: ['landing_page_view'],
    THRUPLAY: ['video_view'],
  };
  return byGoal[goal] ?? null;
}

/**
 * Weekly events per ad set, off the provider's OWN weekly buckets.
 *
 * The rate is each ad set's own average over the buckets it actually has, not a
 * division by a fixed four: an ad set that only ran in one of the weeks would
 * otherwise report a quarter of its real weekly rate and be filed as starved
 * for signal it never lacked.
 */
export function toAdsetWeeklyEvents(
  rows: readonly unknown[],
  configs: readonly AdsetConfigLite[],
): Map<string, number> {
  const typesById = new Map<string, string[] | null>();
  for (const c of configs) typesById.set(c.adset_id, optimizationActionTypes(c));

  const totals = new Map<string, { events: number; buckets: Set<string> }>();
  for (const row of rows) {
    const r = rec(row);
    const id = strOrNull(r.entityId);
    if (!id) continue;
    const actions = actionsOf(r.actions);
    const types = typesById.get(id);
    const events = types
      ? pickAction(actions, types)
      : pickAction(actions, PURCHASE_TYPES) || pickAction(actions, LEAD_TYPES);
    const agg = totals.get(id) ?? { events: 0, buckets: new Set<string>() };
    agg.events += events;
    const bucket = strOrNull(r.date) ?? strOrNull(r.dateStop);
    if (bucket) agg.buckets.add(bucket);
    totals.set(id, agg);
  }

  const out = new Map<string, number>();
  for (const [id, agg] of totals) out.set(id, agg.events / Math.max(1, agg.buckets.size));
  return out;
}

// ---------------------------------------------------------------------------
// Targeting
// ---------------------------------------------------------------------------

export interface ClassifiedAdSet {
  adsetId: string;
  adsetName: string | null;
  targetingClass: string;
  signals: {
    advantageAudience: boolean | null;
    hasInterestTargeting: boolean;
    includedAudiences: Array<{ id: string; name: string | null; subtype: string | null }>;
    excludedAudiences: Array<{ id: string; name: string | null; subtype: string | null }>;
    geoCountries: string[];
    ageMin: number | null;
    ageMax: number | null;
    genders: string[] | null;
  };
}

function namedAudiences(value: unknown): Array<{ id: string; name: string | null; subtype: string | null }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const a = rec(entry);
    const id = strOrNull(a.id);
    return id ? [{ id, name: strOrNull(a.name), subtype: strOrNull(a.subtype) }] : [];
  });
}

export function readClassifiedAdSets(rows: readonly unknown[]): ClassifiedAdSet[] {
  return rows.flatMap((row) => {
    const r = rec(row);
    const id = strOrNull(r.adsetId);
    if (!id) return [];
    const s = rec(r.signals);
    const genders = Array.isArray(s.genders)
      ? s.genders.filter((g): g is string => typeof g === 'string')
      : null;
    return [
      {
        adsetId: id,
        adsetName: strOrNull(r.adsetName),
        targetingClass: strOrNull(r.targetingClass) ?? 'broad',
        signals: {
          advantageAudience: boolOrNull(s.advantageAudience),
          hasInterestTargeting: s.hasInterestTargeting === true,
          includedAudiences: namedAudiences(s.includedAudiences),
          excludedAudiences: namedAudiences(s.excludedAudiences),
          geoCountries: Array.isArray(s.geoCountries)
            ? s.geoCountries.filter((c): c is string => typeof c === 'string')
            : [],
          ageMin: typeof s.ageMin === 'number' ? s.ageMin : null,
          ageMax: typeof s.ageMax === 'number' ? s.ageMax : null,
          genders,
        },
      },
    ];
  });
}

/**
 * Their class, projected onto the flags OUR classifier reads, so both engines
 * land on the same word.
 *
 * The projection goes class → flags rather than flags → class deliberately.
 * Their side holds the account's own audience list and therefore knows a
 * lookalike from a saved audience it could not place; ours would read the flags
 * and file an unplaceable audience as retargeting, which is exactly the guess
 * the audience list exists to prevent.
 */
export function toTargetingSpecs(adSets: readonly ClassifiedAdSet[]): TargetingSpecLite[] {
  return adSets.map((a) => {
    const cls = a.targetingClass;
    const genders = a.signals.genders;
    return {
      adset_id: a.adsetId,
      adset_name: a.adsetName ?? a.adsetId,
      effective_status: null,
      advantage_audience: cls === 'advantage_plus',
      has_custom_audiences: cls === 'retargeting' || cls === 'lookalike',
      has_lookalikes: cls === 'lookalike',
      has_interests: cls === 'interest',
      age_min: a.signals.ageMin,
      age_max: a.signals.ageMax,
      genders: genders === null || genders.length === 0 ? null : genders.length === 1 ? genders[0] ?? null : 'all',
    };
  });
}

/** The account's saved audiences, as the name check needs them. */
export function readAudiences(rows: readonly unknown[]): Array<{ id: string; name: string | null }> {
  return rows.flatMap((row) => {
    const a = rec(row);
    const id = strOrNull(a.id);
    return id ? [{ id, name: strOrNull(a.name) }] : [];
  });
}

/** What a class contains, in the words the promise check states it in. */
const CLASS_WORD: Record<string, string> = {
  advantage_plus: 'Advantage+ audience, where Meta picks who sees it',
  retargeting: 'a saved audience of people who already met the business',
  lookalike: 'a lookalike audience',
  interest: 'hand-picked interests',
  broad: 'no audience and no interests at all',
};

const NAME_CLAIMS: Array<{ claim: string; re: RegExp; satisfiedBy: (cls: string) => boolean }> = [
  {
    claim: 'a lookalike',
    re: /\b(lookalike|look-alike|lal|lla)\b/i,
    satisfiedBy: (cls) => cls === 'lookalike',
  },
  {
    claim: 'retargeting',
    re: /\b(retarget\w*|remarket\w*|rtg|warm)\b/i,
    satisfiedBy: (cls) => cls === 'retargeting',
  },
  {
    claim: 'broad targeting',
    re: /\b(broad|open targeting|no.?targeting)\b/i,
    satisfiedBy: (cls) => cls === 'broad' || cls === 'advantage_plus',
  },
  {
    claim: 'interest targeting',
    re: /\b(interests?|behaviou?rs?)\b/i,
    satisfiedBy: (cls) => cls === 'interest',
  },
];

/** Audience names short enough to appear inside an ad set name by accident. */
const MIN_AUDIENCE_NAME_MATCH = 5;

/**
 * What each ad set's NAME claims, against what its spec contains.
 *
 * Only a name that makes a checkable claim is judged, and only for the claim it
 * actually makes: an ad set called "LAL 1% purchasers" targeting no lookalike is
 * a finding, and an ad set called "Q3 test 4" claims nothing and is not. The
 * verdict never says the name is wrong about the world, only that the name and
 * the spec disagree, because either one of them could be the stale half.
 */
export function readNamePromises(
  adSets: readonly ClassifiedAdSet[],
  audiences: readonly { id: string; name: string | null }[],
): AdSetNamePromise[] {
  const out: AdSetNamePromise[] = [];
  for (const a of adSets) {
    const name = a.adsetName;
    if (!name) continue;
    const contains = CLASS_WORD[a.targetingClass] ?? a.targetingClass;

    for (const rule of NAME_CLAIMS) {
      if (!rule.re.test(name) || rule.satisfiedBy(a.targetingClass)) continue;
      out.push({
        adset_id: a.adsetId,
        adset_name: name,
        claim: rule.claim,
        targeting_class: a.targetingClass,
        detail: `"${name}" reads as ${rule.claim}, and its live targeting holds ${contains}.`,
      });
      break;
    }

    // A name pointing at one of the account's OWN saved audiences that the ad
    // set does not include. The audience list is what makes this checkable:
    // without it, a name is only words.
    const included = new Set(a.signals.includedAudiences.map((x) => x.id));
    const namedElsewhere = audiences.find(
      (aud) =>
        !included.has(aud.id) &&
        typeof aud.name === 'string' &&
        aud.name.trim().length >= MIN_AUDIENCE_NAME_MATCH &&
        name.toLowerCase().includes(aud.name.trim().toLowerCase()),
    );
    if (namedElsewhere && !out.some((p) => p.adset_id === a.adsetId)) {
      out.push({
        adset_id: a.adsetId,
        adset_name: name,
        claim: `the audience "${namedElsewhere.name}"`,
        targeting_class: a.targetingClass,
        detail: `"${name}" names the saved audience "${namedElsewhere.name}", which this ad set does not target. Its live targeting holds ${contains}.`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Activity + pixels
// ---------------------------------------------------------------------------

/**
 * The port's normalized change rows, in the shape the activity engine reads.
 *
 * `providerEventType` is Meta's own event name and is what the categoriser was
 * written against, so it is the field that decides the bucket; the normalized
 * `kind` is the fallback for a provider with no name of its own. Nothing on this
 * seam carries the ACTOR, so those fields are null here and the section is told
 * not to claim a "who" it was never handed.
 */
export function toActivityEvents(changes: readonly unknown[]): ActivityEvent[] {
  const byKey = new Map<string, ActivityEvent>();
  for (const change of changes) {
    const c = rec(change);
    const at = strOrNull(c.at);
    if (!at) continue;
    const event: ActivityEvent = {
      event_type: strOrNull(c.providerEventType) ?? strOrNull(c.kind) ?? 'unknown',
      event_time: at,
      actor_id: null,
      actor_name: null,
      application_id: null,
      application_name: null,
      object_type: strOrNull(c.objectType),
    };
    // The key is the adapter's own stable identity, so overlapping window
    // slices cannot report one pause twice.
    byKey.set(strOrNull(c.key) ?? `${event.event_type}:${at}:${strOrNull(c.objectId) ?? ''}`, event);
  }
  return [...byKey.values()];
}

export function toPixelLites(pixels: readonly unknown[]): PixelLite[] {
  return pixels.flatMap((pixel) => {
    const p = rec(pixel);
    const id = strOrNull(p.id);
    if (!id) return [];
    const diagnostics = Array.isArray(p.diagnostics)
      ? p.diagnostics.flatMap((entry) => {
          const d = rec(entry);
          const result = strOrNull(d.result);
          return result ? [{ key: strOrNull(d.key) ?? '', title: strOrNull(d.title) ?? '', result }] : [];
        })
      : [];
    return [
      {
        id,
        name: strOrNull(p.name),
        last_fired_time: strOrNull(p.lastFiredTime),
        automatic_matching_enabled: boolOrNull(p.automaticMatchingEnabled),
        automatic_matching_fields: Array.isArray(p.automaticMatchingFields)
          ? p.automaticMatchingFields.filter((f): f is string => typeof f === 'string')
          : [],
        // Null stays null: a rate nobody measured may never become a number,
        // and their adapter already turned Meta's -1 sentinel into one.
        match_rate_approx: typeof p.matchRateApprox === 'number' ? p.matchRateApprox : null,
        diagnostics,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// What a read that could not answer does to its section
// ---------------------------------------------------------------------------

/** The section fields a read's failure state produces. */
export interface SeamGap {
  status: 'planned' | 'skipped' | 'error';
  skip_reason?: string;
  error?: string;
  data?: Record<string, unknown>;
}

/**
 * The three answers, kept apart.
 *
 * A 404 means the endpoint is not deployed yet, and the section stays `planned`
 * — the same honest gap it was before this wave, never an error on the report of
 * a customer who did nothing wrong. An `ok: false` reason means the read exists
 * and this account cannot be served: a skip, with the reason travelling as data
 * so it is diagnosable without parsing a sentence. Anything else is an error,
 * which is what a failed pull has always been.
 */
export function seamGapFor(read: TinkersReadGap, what: string): SeamGap {
  if (read.state === 'not_deployed') return { status: 'planned' };
  if (read.state === 'unsupported') {
    return {
      status: 'skipped',
      skip_reason: `We could not read ${what} for this account, so this section is left out rather than guessed at.`,
      data: { unavailable_reason: read.reason, signal: false },
    };
  }
  return { status: 'error', error: `${what} read failed: ${read.reason}` };
}

/** The one line a section adds when its read came back short. */
export function partialWarning(what: string): string {
  return `The ${what} read came back short of the whole account, so treat these figures as a floor rather than a total.`;
}
