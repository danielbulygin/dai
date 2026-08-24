import { Hono } from 'hono';
import { env } from '../../env.js';
import { logger } from '../../utils/logger.js';
import { getSupabase } from '../../integrations/supabase.js';
import { runColdAudit } from '../../audit/cold-audit.js';
import { isTinkersSeamConfigured, redactSecrets, reportAuditFailed, runBridgedColdAudit } from '../../audit/tinkers-bridge.js';

export const auditTriggerRouter = new Hono();

/**
 * POST /api/audit/trigger — the Tinkers → engine seam.
 *
 * Tinkers `/api/ada/goal` fires this (fire-and-forget) the moment a lead sets
 * their goal after connecting: `{ userId }` + `X-Ada-Secret` header. We answer
 * 202 immediately and run the cold audit async; on completion runColdAudit
 * sets `ada_leads.audit_token` so the journey's "full audit" rung unlocks.
 *
 * Auth: own shared secret (AUDIT_TRIGGER_SECRET) — mounted BEFORE the global
 * X-API-Key middleware, mirroring the cron/Notion-webhook pattern.
 * Idempotency: a lead whose audit_token is already set (or with an audit
 * currently running) is NOT re-audited — goal re-saves must not double-spend.
 *
 * The Tinkers MONOREPO (separate database) sends the same call with
 * `{ userId: <organizationId>, auditId, source: 'tinkers' }`. That body takes
 * the bridge path (tinkers-bridge.ts): context comes from Tinkers over the HMAC
 * seam, and so does idempotency — none of the ada_leads/magic_audits reads
 * below can resolve a monorepo org. Everything else about the shape (same
 * secret, 202-then-async) is identical.
 */
auditTriggerRouter.post('/audit/trigger', async (c) => {
  if (!env.AUDIT_TRIGGER_SECRET) return c.json({ error: 'AUDIT_TRIGGER_SECRET not configured' }, 503);
  if (c.req.header('X-Ada-Secret') !== env.AUDIT_TRIGGER_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let userId: string | undefined;
  let tinkersAuditId: string | undefined;
  try {
    const body = (await c.req.json()) as { userId?: string; auditId?: string; source?: string };
    userId = typeof body.userId === 'string' && body.userId.trim() ? body.userId.trim() : undefined;
    if (body.source === 'tinkers' && typeof body.auditId === 'string' && body.auditId.trim()) {
      tinkersAuditId = body.auditId.trim();
    }
  } catch {
    /* fall through to 400 */
  }
  if (!userId) return c.json({ error: 'userId (uuid) required' }, 400);

  // Bridge path — a monorepo organization id, not a legacy lead's user id.
  if (tinkersAuditId) {
    if (!isTinkersSeamConfigured()) {
      return c.json({ error: 'TINKERS_BASE_URL / TINKERS_AUDIT_SEAM_SECRET not configured' }, 503);
    }
    const organizationId = userId;
    const auditId = tinkersAuditId;
    void runBridgedColdAudit({ organizationId, auditId })
      .then((r) =>
        r.status === 'complete'
          ? logger.info({ organizationId, auditId: r.auditId, costUsd: r.costUsd }, 'bridged cold audit complete')
          : logger.info({ organizationId, reason: r.reason }, 'bridged cold audit skipped'),
      )
      // Redacted, not raw: a Graph failure on this path can quote the request
      // URL, and that URL carries the customer's access token.
      .catch(async (err) => {
        logger.error(
          { err: redactSecrets(err instanceof Error ? err.message : 'unknown error'), organizationId, auditId: tinkersAuditId },
          'bridged cold audit failed',
        );
        // The row must leave RUNNING: without this the lead's page said
        // "being written now" forever over a generation that had given up.
        await reportAuditFailed(auditId);
      });

    return c.json({ status: 'accepted' }, 202);
  }

  // Idempotency: don't restart an audit the lead already has.
  try {
    const { data: lead } = await getSupabase()
      .from('ada_leads')
      .select('audit_token')
      .eq('user_id', userId)
      .maybeSingle();
    if (lead?.audit_token) {
      return c.json({ status: 'exists', auditToken: lead.audit_token }, 200);
    }
    const { data: running } = await getSupabase()
      .from('magic_audits')
      .select('token')
      .eq('tenant_id', userId)
      .eq('status', 'running')
      .limit(1)
      .maybeSingle();
    if (running?.token) {
      return c.json({ status: 'running', auditToken: running.token }, 200);
    }
  } catch (err) {
    logger.warn({ err, userId }, 'audit-trigger idempotency check failed — proceeding');
  }

  // 202 now, audit async. Failures land in logs + the audit row's own error
  // status; the journey rung simply stays "preparing" (its honest state).
  void runColdAudit({ userId })
    .then((r) => logger.info({ userId, auditId: r.auditId, costUsd: r.costUsd }, 'cold audit complete'))
    .catch((err) => logger.error({ err, userId }, 'cold audit failed'));

  return c.json({ status: 'accepted' }, 202);
});
