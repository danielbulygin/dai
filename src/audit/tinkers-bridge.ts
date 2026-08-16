import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { fetchAccountMeta, fetchColdAdDays, resolveDestinations } from './cold-fetch.js';
import { buildColdRows } from './cold-source.js';
import { runMagicAudit } from './magic-audit.js';

/**
 * The Tinkers monorepo bridge — a cold audit for an org that lives in the
 * Tinkers database, not in ours.
 *
 * The legacy cold path (cold-audit.ts) resolves everything from OUR tables:
 * ada_leads for the goal, meta_connections for the token. A monorepo org has
 * neither row, so a cold audit triggered for one dies at token resolution.
 * This bridge fetches that context FROM Tinkers over an HMAC seam and reports
 * results BACK the same way. We never touch the monorepo database.
 *
 * The access token Tinkers hands us is in-memory for the run only: never
 * logged, never persisted, never echoed back.
 */

const CONTEXT_TIMEOUT_MS = 15_000;
const REPORT_TIMEOUT_MS = 10_000;

const contextSchema = z.union([
  z.object({
    ok: z.literal(true),
    auditId: z.string().min(1),
    adAccountId: z.string().min(1),
    accessToken: z.string().min(1),
    currency: z.string().nullish(),
    accountName: z.string().nullish(),
    goalMetric: z.string().nullish(),
    goalValue: z.number().nullish(),
    grossMarginPct: z.number().nullish(),
  }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);

export type TinkersAuditContext = z.infer<typeof contextSchema>;

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

/**
 * Ask Tinkers for everything the audit needs. Tinkers also answers idempotency
 * here: `already_complete` means an audit for this org is already done or
 * running on their side, so there is nothing for us to do.
 */
export async function fetchAuditContext(organizationId: string): Promise<TinkersAuditContext> {
  const raw = await postSigned('/api/webhooks/audit-context', { organizationId }, CONTEXT_TIMEOUT_MS);
  const parsed = contextSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`audit-context response did not match the contract: ${parsed.error.issues[0]?.message}`);
  }
  return parsed.data;
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

async function runBridged(args: {
  organizationId: string;
  maxCostUsd?: number;
  skipSections?: string[];
}): Promise<BridgedColdAuditResult> {
  const { organizationId } = args;

  const context = await fetchAuditContext(organizationId);
  if (!context.ok) {
    if (context.reason === 'already_complete') {
      logger.info({ organizationId }, 'tinkers audit already complete — nothing to run');
      return { status: 'skipped', reason: context.reason };
    }
    // No context means no audit: refuse loudly rather than run a blind one.
    throw new Error(`tinkers audit context refused for org ${organizationId}: ${context.reason}`);
  }

  const { auditId, accessToken, adAccountId } = context;
  const meta = await fetchAccountMeta(accessToken, adAccountId);
  logger.info(
    { organizationId, auditId, adAccountId, account: meta.name },
    'bridged cold audit: context resolved, starting Graph pull',
  );

  const pull = await fetchColdAdDays(accessToken, adAccountId);
  const destinations = await resolveDestinations(accessToken, pull.adDays);
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
    'bridged cold audit: Graph pull mapped',
  );
  if (rows.rowCount === 0) {
    throw new Error(`account ${adAccountId} returned no ad-level delivery history — nothing to audit`);
  }

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
      accessToken,
      adAccountId,
      accountName: meta.name ?? context.accountName ?? null,
      currency: meta.currency ?? context.currency ?? 'EUR',
      rows,
      goalMetric: context.goalMetric ?? null,
      goalValue: context.goalValue ?? null,
      grossMarginPct: context.grossMarginPct ?? null,
    },
  });

  return { status: 'complete', auditId, token: result.token, costUsd: result.costUsd };
}
