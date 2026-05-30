import { Hono } from 'hono';
import { env } from '../../env.js';
import { logger } from '../../utils/logger.js';
import { runPiperDigest } from '../../digest/piper-digest.js';

export const cronRouter = new Hono();

/**
 * Bearer auth for droplet cron endpoints. Mirrors bmad's /api/cron/* convention
 * (Authorization: Bearer ${CRON_SECRET}). Mounted before the X-API-Key middleware
 * so it uses its own secret, like the Notion webhook route.
 */
function cronAuthed(c: { req: { header: (k: string) => string | undefined } }): boolean {
  if (!env.CRON_SECRET) return false;
  const provided = c.req.header('Authorization');
  return provided === `Bearer ${env.CRON_SECRET}`;
}

/**
 * POST /api/cron/piper-digest
 *
 * Triggered by the droplet systemd timer Mon-Fri 09:00 ET. Runs the Piper agent
 * to assemble the morning digest and posts it to #piper as Piper.
 *
 * ?dry_run=1 → generate but don't post; returns the digest text in the response
 * (handy for `curl` testing before the timer goes live).
 */
cronRouter.post('/cron/piper-digest', async (c) => {
  if (!env.CRON_SECRET) {
    return c.json({ error: 'CRON_SECRET not configured' }, 503);
  }
  if (!cronAuthed(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const dryRun = c.req.query('dry_run') === '1';

  try {
    const result = await runPiperDigest({ dryRun });
    return c.json({
      status: result.posted ? 'posted' : 'generated',
      channel: result.channel,
      ts: result.ts ?? null,
      turns: result.turns,
      chars: result.digest.length,
      ...(dryRun ? { digest: result.digest } : {}),
    });
  } catch (err) {
    logger.error({ err }, 'piper-digest cron failed');
    return c.json({ error: (err as Error).message }, 500);
  }
});
