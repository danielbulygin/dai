import { getSupabase } from '../integrations/supabase.js';
import { getTokenForClient } from '../integrations/meta-token.js';
import { logger } from '../utils/logger.js';
import { fetchAccountMeta, fetchColdAdDays, resolveDestinations } from './cold-fetch.js';
import { buildColdRows } from './cold-source.js';
import { runMagicAudit } from './magic-audit.js';

/**
 * runColdAudit — the self-serve (Tinkers stranger) audit entry.
 *
 * A stranger has NO warehouse rows and NO client code. This entry resolves
 * their connection token (meta-token.ts — connection ONLY, the env fallback is
 * hard-guarded off for userId lookups), pulls 180d of ad-level history live
 * from the Graph, maps it into the exact row shapes the deterministic fast
 * tier consumes (cold-source.ts), and runs the SAME runMagicAudit the agency
 * path uses — with the warehouse pulls bypassed and the connection token
 * threaded into every Graph-live section.
 *
 * Identity contract v2 (Dan 2026-07-03): the audit row carries
 * tenant_id = the auth user's uuid, client_code = NULL. On completion the
 * lead's journey rung unlocks via ada_leads.audit_token.
 */
export async function runColdAudit(args: {
  userId: string;
  maxCostUsd?: number;
  skipSections?: string[];
}): Promise<{ auditId: string; token: string; costUsd: number }> {
  const { userId } = args;

  const resolution = await getTokenForClient({ userId });
  if (!resolution) {
    throw new Error(`no usable Meta connection for user ${userId} — cold audit cannot run`);
  }
  const { token: accessToken, adAccountId } = resolution;

  const meta = await fetchAccountMeta(accessToken, adAccountId);
  logger.info(
    { userId, adAccountId, account: meta.name, source: resolution.source },
    'cold audit: connection resolved, starting Graph pull',
  );

  // The lead's stated goal = the synthetic target (no client-knowledge bundle).
  // gross_margin_pct (nullable, 0<x<100 — DDL applied 2026-07-04): when the
  // lead states it, the fatigue breakeven re-bases from 1.0× to 1 ÷ margin.
  let goalMetric: string | null = null;
  let goalValue: number | null = null;
  let grossMarginPct: number | null = null;
  try {
    const { data: lead } = await getSupabase()
      .from('ada_leads')
      .select('goal_metric, goal_value, gross_margin_pct')
      .eq('user_id', userId)
      .maybeSingle();
    goalMetric = (lead?.goal_metric as string | null) ?? null;
    goalValue = lead?.goal_value != null ? Number(lead.goal_value) : null;
    grossMarginPct = lead?.gross_margin_pct != null ? Number(lead.gross_margin_pct) : null;
  } catch (err) {
    logger.warn({ err, userId }, 'lead goal read failed (audit runs without a target anchor)');
  }

  const pull = await fetchColdAdDays(accessToken, adAccountId);
  const destinations = await resolveDestinations(accessToken, pull.adDays);
  const rows = buildColdRows({ adDays: pull.adDays, destinations });
  logger.info(
    { userId, rowCount: rows.rowCount, daysCovered: rows.daysCovered, truncated: pull.truncated, failedSlices: pull.failedSlices },
    'cold audit: Graph pull mapped',
  );
  if (rows.rowCount === 0) {
    throw new Error(`account ${adAccountId} returned no ad-level delivery history — nothing to audit`);
  }

  const result = await runMagicAudit('', {
    maxCostUsd: args.maxCostUsd,
    skipSections: args.skipSections,
    cold: {
      userId,
      accessToken,
      adAccountId,
      accountName: meta.name,
      currency: meta.currency,
      rows,
      goalMetric,
      goalValue,
      grossMarginPct,
    },
  });

  // The WS5 journey seam: the "full audit" rung links to /audit/<token> once
  // ada_leads.audit_token is set. Fail-soft — the audit itself is already saved.
  try {
    const { error } = await getSupabase()
      .from('ada_leads')
      .update({ audit_token: result.token, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
  } catch (err) {
    logger.error({ err, userId, token: result.token }, 'ada_leads.audit_token update failed — journey rung will not unlock');
  }

  return result;
}
