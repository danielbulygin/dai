import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { buildColdRows, type RawAdDay } from './cold-source.js';
import type { StoreMediaCandidate } from './cold-creative-source.js';
import { runMagicAudit } from './magic-audit.js';

/**
 * The Tinkers monorepo bridge — a cold audit for an org that lives in the
 * Tinkers database, not in ours.
 *
 * The legacy cold path (cold-audit.ts) resolves everything from OUR tables:
 * ada_leads for the goal, meta_connections for the token. A monorepo org has
 * neither row, so a cold audit triggered for one dies at token resolution.
 * This bridge reads the account THROUGH Tinkers' generation API and reports
 * results BACK over the HMAC seam. We never touch the monorepo database.
 *
 * NO CREDENTIAL CROSSES THE SEAM (their ruling, 2026-08-20): Tinkers returns
 * DATA, never a Meta token — their hard rule is that the plaintext token
 * never leaves their meta package. So the reads here are:
 *   GET /api/generation/:auditId/account         → name, currency, timezone
 *   GET /api/generation/:auditId/ad-days?since&until → one ≤31-day window of
 *       ad-level daily rows (their functions die at 300s, so we slice — which
 *       is what fetchColdAdDays did against Graph anyway)
 *   GET /api/generation/:auditId/context         → the owner's own goal,
 *       margin, interview answers and picked rivals (nothing from the provider,
 *       so it answers whether or not their Meta token still does)
 *   GET /api/generation/:auditId/creatives       → per-ad landing destinations
 *   GET /api/generation/:auditId/creative-media?adIds= → the top ads' words +
 *       30-minute signed URLs onto their media store (their connect burst
 *       downloads the real files at Meta connect — full images and playable
 *       mp4s, where ads_read Graph would give us a 64px thumbnail)
 * all authorized with `Authorization: Bearer TINKERS_AUDIT_SEAM_SECRET` — the
 * same secret that signs the write-backs, one secret for the whole boundary.
 * The audit id in the path is the tenant capability: their row's own org
 * decides everything, and an unknown or expired audit is a 404.
 *
 * Sections whose reads only a connection token could serve run as `planned`
 * (TOKENLESS_SKIP_SECTIONS in magic-audit.ts) — an honest gap, not an error.
 */

const READ_TIMEOUT_MS = 60_000;
const REPORT_TIMEOUT_MS = 10_000;

const notReady = z.object({ ok: z.literal(false), reason: z.string() });

const accountSchema = z.union([
  z.object({
    ok: z.literal(true),
    account: z.object({
      externalId: z.string().min(1),
      name: z.string().nullish(),
      currency: z.string().nullish(),
      timezone: z.string().nullish(),
    }),
  }),
  notReady,
]);

const adDaysSchema = z.union([
  z.object({ ok: z.literal(true), rows: z.array(z.unknown()), partial: z.boolean() }),
  notReady,
]);

const creativesSchema = z.union([
  z.object({
    ok: z.literal(true),
    creatives: z.array(
      z.object({
        adId: z.string(),
        adName: z.string().nullish(),
        landingUrl: z.string().nullish(),
        mediaType: z.string().nullish(),
      }),
    ),
  }),
  notReady,
]);

/** Loose on purpose, like toRawAdDay: a field their port renames costs that
 *  field, never the read. An org that never came through the funnel answers
 *  all-null, which is a domain state and not an error. */
const targetSchema = z.object({ metric: z.string(), value: z.number() });

const contextSchema = z.union([
  z.object({
    ok: z.literal(true),
    goal: targetSchema.nullish(),
    grossMarginPct: z.number().nullish(),
    interview: z
      .object({
        who_runs_ads: z.string().nullish(),
        pain_point: z.string().nullish(),
        tried: z.array(z.string()).nullish(),
        agency_fee: z.string().nullish(),
      })
      .nullish(),
    rivals: z.array(z.string()).nullish(),
    accountTarget: targetSchema.nullish(),
  }),
  notReady,
]);

const creativeMediaSchema = z.union([
  z.object({
    ok: z.literal(true),
    ads: z.array(
      z.object({
        adId: z.string(),
        body: z.string().nullish(),
        headline: z.string().nullish(),
        videoUrl: z.string().nullish(),
        imageUrl: z.string().nullish(),
        posterUrl: z.string().nullish(),
      }),
    ),
  }),
  notReady,
]);

/** The patch shape Tinkers accepts — camelCase, unlike our snake_case columns. */
export interface TinkersAuditPatch {
  sections?: unknown;
  scorecard?: unknown;
  leadInsights?: unknown;
  recognition?: unknown;
  workLog?: unknown;
  costUsd?: number;
}

export function isTinkersSeamConfigured(): boolean {
  return Boolean(env.TINKERS_BASE_URL && env.TINKERS_AUDIT_SEAM_SECRET);
}

/** Hex HMAC-SHA256 over the exact bytes we send — Tinkers verifies against its raw body. */
export function signRequest(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/**
 * Scrub anything token-shaped out of text bound for a log. We lift only an
 * error's message (never a request or response body), but an upstream message
 * can quote the URL or credential it choked on — and a Meta access token in
 * the log file is the one failure this seam must not have.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/access_token=[^&\s"']+/gi, 'access_token=[redacted]')
    .replace(/\bEAA[A-Za-z0-9_-]{4,}/g, '[redacted-token]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]');
}

const seamError = (err: unknown): string => redactSecrets(err instanceof Error ? err.message : 'unknown error');

async function postSigned(path: string, payload: unknown, timeoutMs: number): Promise<unknown> {
  const baseUrl = env.TINKERS_BASE_URL;
  const secret = env.TINKERS_AUDIT_SEAM_SECRET;
  if (!baseUrl || !secret) throw new Error('TINKERS_BASE_URL / TINKERS_AUDIT_SEAM_SECRET not configured');

  const body = JSON.stringify(payload);
  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tinkers-signature-256': signRequest(body, secret),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`${path} returned ${resp.status}`);
  return resp.json();
}

/** One authorized GET against Tinkers' generation seam. The Bearer secret
 *  authenticates us; the audit id in the path is the tenant capability. */
async function getGeneration(path: string): Promise<unknown> {
  const baseUrl = env.TINKERS_BASE_URL;
  const secret = env.TINKERS_AUDIT_SEAM_SECRET;
  if (!baseUrl || !secret) throw new Error('TINKERS_BASE_URL / TINKERS_AUDIT_SEAM_SECRET not configured');
  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`${path.replace(/\?.*$/, '')} returned ${resp.status}`);
  return resp.json();
}

function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, what: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${what} response did not match the contract: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
}

const isoDaysAgo = (asOf: string, days: number): string => {
  const d = new Date(`${asOf}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

/** Tinkers' normalized insight row → the raw Graph row shape buildColdRows
 *  consumes. Loose on purpose: their port ships on its own schedule, so a
 *  field this mapper cannot place costs that field, never the row. */
export function toRawAdDay(row: unknown): RawAdDay | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const adId = typeof r.entityId === 'string' && r.entityId ? r.entityId : null;
  const date = typeof r.date === 'string' && r.date ? r.date : null;
  if (!adId || !date) return null;

  type RawAction = { action_type?: string; value?: string | number };
  const actionList = (v: unknown): RawAction[] =>
    Array.isArray(v)
      ? v.flatMap((a) => {
          if (!a || typeof a !== 'object') return [];
          const t = (a as { type?: unknown }).type;
          const val = (a as { value?: unknown }).value;
          return typeof t === 'string' && typeof val === 'number' ? [{ action_type: t, value: val }] : [];
        })
      : [];

  const actions = actionList(r.actions);
  // The hook rate derives from the video_view action; their port lifts it into
  // `videoPlays` and some adapter versions may drop it from the list — put it
  // back so a video ad reads as one.
  const videoPlays = typeof r.videoPlays === 'number' ? r.videoPlays : 0;
  if (videoPlays > 0 && !actions.some((a) => a.action_type === 'video_view')) {
    actions.push({ action_type: 'video_view', value: videoPlays });
  }

  const thruplays = typeof r.thruplays === 'number' ? r.thruplays : 0;

  return {
    ad_id: adId,
    ad_name: typeof r.entityName === 'string' ? r.entityName : undefined,
    adset_id: typeof r.adsetId === 'string' ? r.adsetId : undefined,
    date_start: date,
    date_stop: typeof r.dateStop === 'string' && r.dateStop ? r.dateStop : date,
    spend: typeof r.spend === 'number' ? r.spend : 0,
    impressions: typeof r.impressions === 'number' ? r.impressions : 0,
    clicks: typeof r.clicks === 'number' ? r.clicks : 0,
    frequency: typeof r.frequency === 'number' ? r.frequency : undefined,
    actions,
    action_values: actionList(r.actionValues),
    // cold-source reads thruplays off this list by the video_view type (the
    // type Meta itself uses inside video_thruplay_watched_actions).
    video_thruplay_watched_actions: thruplays > 0 ? [{ action_type: 'video_view', value: thruplays }] : [],
  };
}

/** 180 days of ad-level daily rows, one ≤31-day window per request — their
 *  functions stop at 300 seconds and a window past the cap is REFUSED, so the
 *  slicing is the contract, not an optimization. A failed slice costs that
 *  slice (failedSlices), never the audit — fetchColdAdDays' own posture. */
export async function fetchTinkersAdDays(
  auditId: string,
  opts: { days?: number; sliceDays?: number; maxRows?: number; asOf?: string } = {},
): Promise<{ adDays: RawAdDay[]; truncated: boolean; failedSlices: number }> {
  const days = opts.days ?? 180;
  const sliceDays = opts.sliceDays ?? 30;
  const maxRows = opts.maxRows ?? 150_000;
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);

  const adDays: RawAdDay[] = [];
  let truncated = false;
  let failedSlices = 0;

  for (let offset = 0; offset < days && !truncated; offset += sliceDays) {
    const until = isoDaysAgo(asOf, offset);
    const since = isoDaysAgo(asOf, Math.min(offset + sliceDays - 1, days));
    try {
      const raw = await getGeneration(`/api/generation/${auditId}/ad-days?since=${since}&until=${until}`);
      const page = parseOrThrow(adDaysSchema, raw, 'ad-days');
      if (!page.ok) throw new Error(`ad-days window refused: ${page.reason}`);
      for (const row of page.rows) {
        const mapped = toRawAdDay(row);
        if (!mapped) continue;
        if (adDays.length >= maxRows) {
          truncated = true;
          break;
        }
        adDays.push(mapped);
      }
    } catch (err) {
      failedSlices += 1;
      logger.warn({ err: seamError(err), auditId, since, until }, 'tinkers ad-day window failed (audit continues on partial window)');
    }
  }

  if (truncated) {
    logger.error({ auditId, rows: adDays.length, maxRows }, 'tinkers pull hit row cap — aggregates incomplete');
  }
  return { adDays, truncated, failedSlices };
}

/** What the owner has already TOLD us, in the shape the cold knowledge bundle
 *  takes. `goalSource` records which of the two answers we are citing, because
 *  "you set this at signup" and "you set this on the ad account" are different
 *  sentences about the same number. */
export interface TinkersLeadContext {
  goalMetric: string | null;
  goalValue: number | null;
  goalSource: 'signup' | 'account' | null;
  grossMarginPct: number | null;
  interview: {
    who_runs_ads: string | null;
    pain_point: string | null;
    tried: string[];
    agency_fee: string | null;
  } | null;
  /** The handles their rival picker queued. Read and logged; no section on the
   *  tokenless path consumes them yet. */
  rivals: string[];
}

/**
 * The context read, CONTAINED. This endpoint ships on Tinkers' own schedule, so
 * a 404, a not-ready answer, a contract change or an outage must all cost the
 * same thing: the target we would have cited, and nothing else. An audit that
 * dies because it could not read an optional answer is a worse report than one
 * that honestly says no target has been set.
 */
export async function fetchTinkersLeadContext(auditId: string): Promise<TinkersLeadContext | null> {
  try {
    const raw = await getGeneration(`/api/generation/${auditId}/context`);
    const page = parseOrThrow(contextSchema, raw, 'context');
    if (!page.ok) {
      logger.warn({ auditId, reason: page.reason }, 'tinkers context read not ready (the audit runs without a stated target)');
      return null;
    }
    // The funnel answer is the owner's own words; the account target is the same
    // number mirrored onto the account they picked. Prefer what they typed.
    const goal = page.goal ?? page.accountTarget ?? null;
    const goalSource = page.goal ? 'signup' : page.accountTarget ? 'account' : null;
    const iv = page.interview;
    const interview = iv
      ? {
          who_runs_ads: iv.who_runs_ads ?? null,
          pain_point: iv.pain_point ?? null,
          tried: iv.tried ?? [],
          agency_fee: iv.agency_fee ?? null,
        }
      : null;
    return {
      goalMetric: goal?.metric ?? null,
      goalValue: goal?.value ?? null,
      goalSource,
      grossMarginPct: page.grossMarginPct ?? null,
      interview,
      rivals: page.rivals ?? [],
    };
  } catch (err) {
    logger.warn({ err: seamError(err), auditId }, 'tinkers context read failed (the audit runs without a stated target)');
    return null;
  }
}

/** Landing destinations from their creatives read — the same map
 *  resolveDestinations built from live Graph creatives. Fail-soft: no
 *  destinations degrades the landing section to unresolved, never the audit. */
export async function fetchTinkersDestinations(
  auditId: string,
): Promise<Record<string, { market: string | null; path: string | null }>> {
  const out: Record<string, { market: string | null; path: string | null }> = {};
  try {
    const raw = await getGeneration(`/api/generation/${auditId}/creatives`);
    const page = parseOrThrow(creativesSchema, raw, 'creatives');
    if (!page.ok) {
      logger.warn({ auditId, reason: page.reason }, 'tinkers creatives read not ready (landing section degrades)');
      return out;
    }
    for (const c of page.creatives) {
      const url = c.landingUrl;
      if (!url || !/^https?:\/\//.test(url)) continue;
      try {
        out[c.adId] = { market: null, path: new URL(url).pathname };
      } catch {
        /* malformed url — leave unresolved */
      }
    }
  } catch (err) {
    logger.warn({ err: seamError(err), auditId }, 'tinkers creatives read failed (landing section degrades)');
  }
  return out;
}

/** The top ads' words + signed media URLs from their store, for the creative
 *  read. Fail-soft: an audit without media still runs — the section reports
 *  those ads unresolved, which is its normal degradation. */
export async function fetchTinkersStoreMedia(
  auditId: string,
  adIds: string[],
): Promise<Map<string, StoreMediaCandidate> | null> {
  if (adIds.length === 0) return null;
  try {
    const raw = await getGeneration(`/api/generation/${auditId}/creative-media?adIds=${adIds.join(',')}`);
    const page = parseOrThrow(creativeMediaSchema, raw, 'creative-media');
    if (!page.ok) {
      logger.warn({ auditId, reason: page.reason }, 'tinkers creative-media not ready (creative read degrades)');
      return null;
    }
    const out = new Map<string, StoreMediaCandidate>();
    for (const ad of page.ads) {
      out.set(ad.adId, {
        body: ad.body ?? null,
        title: ad.headline ?? null,
        video_url: ad.videoUrl ?? null,
        image_url: ad.imageUrl ?? null,
        poster_url: ad.posterUrl ?? null,
      });
    }
    return out;
  } catch (err) {
    logger.warn({ err: seamError(err), auditId }, 'tinkers creative-media read failed (creative read degrades)');
    return null;
  }
}

/**
 * Post one content update. Under contract v1.1 EVERY content payload is a
 * partial, including the last one — completion is a separate, contentless
 * message (reportAuditFinalize), which keeps the finalize call small enough to
 * clear any body cap no matter how fat the report got.
 *
 * Fail-soft by design: Tinkers' own sweep reconciles a report that never
 * lands, so a failed post must never take down an audit that actually ran.
 */
export async function reportAuditUpdate(auditId: string, patch: TinkersAuditPatch): Promise<void> {
  try {
    const resp = await postReport({ auditId, partial: true, ...patch });
    if (resp?.recorded === false) {
      logger.warn({ auditId }, 'tinkers partial update not recorded — the next update or the sweep carries it');
    }
  } catch (err) {
    logger.warn({ err: seamError(err), auditId }, 'tinkers audit update failed (audit continues)');
  }
}

/**
 * Seal the audit: Tinkers flips it COMPLETE and emails the lead from the row it
 * already stored. Carries no content on purpose.
 */
export async function reportAuditFinalize(auditId: string): Promise<void> {
  try {
    const resp = await postReport({ auditId, finalize: true });
    if (resp?.recorded === false) {
      // Tinkers only accepts content writes while the audit is RUNNING, so a
      // finalize that timed out on our side but LANDED on theirs answers
      // recorded:false on the retry — with the audit complete and its email
      // already sent. This line may never read as "generation failed".
      logger.warn(
        { auditId },
        'final report not recorded by tinkers (audit may already be sealed) — the sweep reconciles if not',
      );
    }
  } catch (err) {
    logger.warn({ err: seamError(err), auditId }, 'tinkers audit finalize failed (the sweep reconciles)');
  }
}

async function postReport(body: Record<string, unknown>): Promise<{ received?: boolean; recorded?: boolean }> {
  return (await postSigned('/api/webhooks/audit-complete', body, REPORT_TIMEOUT_MS)) as {
    received?: boolean;
    recorded?: boolean;
  };
}

/**
 * Deep-scrub every string INSIDE a payload, not just the log line about it.
 *
 * Section errors carry raw `err.message` from whatever threw, and every Graph
 * URL in the orchestrator interpolates the access token inline — so one future
 * `throw new Error(url)` in any section runner would publish a live customer
 * token to a page anyone with the link can read. This sits where the token is
 * known, so that class of bug cannot reach the wire even once.
 */
function redactPayload<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'string' ? redactSecrets(v) : v))) as T;
}

/** Our snake_case row patch → the seam's camelCase contract. Keys that are ours alone (status) are dropped. */
export function toTinkersPatch(patch: Record<string, unknown>): TinkersAuditPatch {
  const out: TinkersAuditPatch = {};
  if ('sections' in patch) out.sections = redactPayload(patch.sections);
  if ('scorecard' in patch) out.scorecard = redactPayload(patch.scorecard);
  if ('lead_insights' in patch) out.leadInsights = redactPayload(patch.lead_insights);
  if ('recognition' in patch) out.recognition = redactPayload(patch.recognition);
  if ('work_log' in patch) out.workLog = redactPayload(patch.work_log);
  if (typeof patch.cost_usd === 'number') out.costUsd = patch.cost_usd;
  return out;
}

/** The keys Tinkers stores as report content. A payload with none of them says nothing. */
const CONTENT_KEYS = ['sections', 'scorecard', 'leadInsights', 'recognition', 'workLog'] as const;

export function hasReportContent(patch: TinkersAuditPatch): boolean {
  return CONTENT_KEYS.some((k) => patch[k] !== undefined);
}

export type BridgedColdAuditResult =
  | { status: 'complete'; auditId: string; token: string; costUsd: number }
  | { status: 'skipped'; reason: string };

/**
 * Orgs with an audit running in THIS process. The trigger is fire-and-forget
 * from Tinkers, and Tinkers' own idempotency answer cannot see an audit that
 * started a second ago — so without this, a double-click costs two Graph pulls,
 * two LLM bills, and two streams of interleaved partials into one row.
 */
const running = new Set<string>();

/**
 * runBridgedColdAudit — the monorepo twin of runColdAudit.
 *
 * Same machinery (fetchAccountMeta → fetchColdAdDays → buildColdRows →
 * runMagicAudit), different context source and different reporting target.
 * There is no ada_leads row on this path, so the audit_token write the legacy
 * entry does is deliberately absent — the Tinkers audit row is the journey.
 */
export async function runBridgedColdAudit(args: {
  organizationId: string;
  /** The Tinkers audit row's id — the read capability AND the write-back key. */
  auditId: string;
  maxCostUsd?: number;
  skipSections?: string[];
}): Promise<BridgedColdAuditResult> {
  const { organizationId } = args;

  if (running.has(organizationId)) {
    logger.info({ organizationId }, 'bridged cold audit already running for this org — ignoring the second trigger');
    return { status: 'skipped', reason: 'already_running' };
  }
  running.add(organizationId);
  try {
    return await runBridged(args);
  } finally {
    running.delete(organizationId);
  }
}

/** Top spenders over the last 30 days — the ads whose media is worth asking
 *  Tinkers for. Mirrors rankTopAds' aggregation over the mapped raw rows. */
export function topSpendingAdIds(adDays: RawAdDay[], asOf: string, cap = 12): string[] {
  const cut30 = isoDaysAgo(asOf, 30);
  const spendByAd = new Map<string, number>();
  for (const r of adDays) {
    const adId = r.ad_id ? String(r.ad_id) : '';
    const date = (r.date_start ?? '').slice(0, 10);
    if (!adId || !date || date < cut30) continue;
    const spend = typeof r.spend === 'number' ? r.spend : parseFloat(String(r.spend ?? '0')) || 0;
    spendByAd.set(adId, (spendByAd.get(adId) ?? 0) + spend);
  }
  return [...spendByAd.entries()]
    .filter(([, spend]) => spend > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([id]) => id);
}

async function runBridged(args: {
  organizationId: string;
  auditId: string;
  maxCostUsd?: number;
  skipSections?: string[];
}): Promise<BridgedColdAuditResult> {
  const { organizationId, auditId } = args;

  // The account read doubles as the audit's validity check: an unknown,
  // revoked or expired audit id is their 404, and an org with no usable
  // connection is an honest not-ready reason. No context means no audit —
  // refuse loudly rather than run a blind one.
  const accountRaw = await getGeneration(`/api/generation/${auditId}/account`);
  const account = parseOrThrow(accountSchema, accountRaw, 'account');
  if (!account.ok) {
    throw new Error(`tinkers account read refused for audit ${auditId}: ${account.reason}`);
  }

  const adAccountId = account.account.externalId;
  logger.info(
    { organizationId, auditId, adAccountId, account: account.account.name },
    'bridged cold audit: account resolved, starting tinkers pull',
  );

  // What the owner already told us. Contained: no context means no target to
  // cite, never a failed audit.
  const leadContext = await fetchTinkersLeadContext(auditId);
  logger.info(
    {
      organizationId,
      auditId,
      goalMetric: leadContext?.goalMetric ?? null,
      goalSource: leadContext?.goalSource ?? null,
      hasMargin: leadContext?.grossMarginPct != null,
      interviewAnswers: leadContext?.interview
        ? Object.values(leadContext.interview).filter((v) => (Array.isArray(v) ? v.length > 0 : !!v)).length
        : 0,
      rivals: leadContext?.rivals.length ?? 0,
    },
    'bridged cold audit: owner context resolved',
  );

  const asOf = new Date().toISOString().slice(0, 10);
  const pull = await fetchTinkersAdDays(auditId, { asOf });
  const destinations = await fetchTinkersDestinations(auditId);
  const rows = buildColdRows({ adDays: pull.adDays, destinations });
  logger.info(
    {
      organizationId,
      auditId,
      rowCount: rows.rowCount,
      daysCovered: rows.daysCovered,
      truncated: pull.truncated,
      failedSlices: pull.failedSlices,
    },
    'bridged cold audit: tinkers pull mapped',
  );
  if (rows.rowCount === 0) {
    throw new Error(`account ${adAccountId} returned no ad-level delivery history — nothing to audit`);
  }

  // The creative read's media: their store's signed URLs for the top spenders.
  const storeMedia = await fetchTinkersStoreMedia(auditId, topSpendingAdIds(pull.adDays, asOf));

  // Reports are chained, never parallel: two in-flight posts can land out of
  // order, and a stale sections snapshot arriving last would undo real progress
  // on the page that polls them.
  let reportChain: Promise<void> = Promise.resolve();
  const chain = (step: () => Promise<void>): Promise<void> => {
    reportChain = reportChain.then(step);
    return reportChain;
  };

  const reportInOrder = (patch: Record<string, unknown>, final: boolean): Promise<void> =>
    chain(async () => {
      const mapped = toTinkersPatch(patch);
      if (!final) {
        // A cost-only patch (the orchestrator's status write) says nothing
        // Tinkers stores — posting it earns a recorded:false warning per run.
        if (!hasReportContent(mapped)) {
          logger.debug({ auditId }, 'skipping a contentless partial');
          return;
        }
        await reportAuditUpdate(auditId, mapped);
        return;
      }

      // Contract v1.1: the last content payload is a partial like every other,
      // and completion is the tiny finalize message after it.
      await reportAuditUpdate(auditId, mapped);
      if (patch.status === 'error') {
        // Finalizing here would flip their row COMPLETE and burn the one-ever
        // "I found something" email on a broken report. Leaving it RUNNING lets
        // their 24h fallback rail treat the lead honestly.
        logger.warn({ auditId, organizationId }, 'audit ended with section errors — not finalizing the tinkers audit');
        return;
      }
      await reportAuditFinalize(auditId);
    });

  const result = await runMagicAudit('', {
    maxCostUsd: args.maxCostUsd,
    skipSections: args.skipSections,
    onRowUpdate: (patch, { final }) => reportInOrder(patch, final),
    cold: {
      userId: organizationId,
      // No credential crosses the seam — the tokenless path (see the header).
      accessToken: null,
      adAccountId,
      accountName: account.account.name ?? null,
      currency: account.account.currency ?? 'EUR',
      rows,
      // Whatever the owner has told us by now: the goal they typed into the
      // funnel (or the target on the account they picked), their margin, and
      // their interview answers. All of it optional. Nothing told to us means
      // the audit runs on its honest 1.0× breakeven default and says plainly
      // that no target has been set, exactly like a goal-less legacy lead.
      goalMetric: leadContext?.goalMetric ?? null,
      goalValue: leadContext?.goalValue ?? null,
      goalSource: leadContext?.goalSource ?? null,
      grossMarginPct: leadContext?.grossMarginPct ?? null,
      interview: leadContext?.interview ?? null,
      storeMedia,
    },
  });

  return { status: 'complete', auditId, token: result.token, costUsd: result.costUsd };
}
