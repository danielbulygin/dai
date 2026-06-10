import { Hono } from 'hono';
import { env } from '../../env.js';
import { logger } from '../../utils/logger.js';
import { runPiperDigest } from '../../digest/piper-digest.js';
import { runPiperMyMoves } from '../../digest/piper-my-moves.js';

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
/**
 * POST /api/cron/monday-prep?job=drafts|blocks&only=TL,LA
 *
 * Manual trigger for the Monday meeting-prep pipeline (also runs on the in-process
 * scheduler Mon 08:00/09:30 Berlin — this endpoint exists for testing and re-runs).
 * `job=drafts` → 3-day Fri–Sun drafts to #ada; `job=blocks` → 7-day agenda blocks
 * to #agent-office handed to Ace. `only` limits to specific client codes.
 */
cronRouter.post('/cron/monday-prep', async (c) => {
  if (!env.CRON_SECRET) return c.json({ error: 'CRON_SECRET not configured' }, 503);
  if (!cronAuthed(c)) return c.json({ error: 'Unauthorized' }, 401);

  const job = c.req.query('job');
  const only = c.req.query('only')?.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (job !== 'drafts' && job !== 'blocks') {
    return c.json({ error: 'job must be "drafts" or "blocks"' }, 400);
  }

  try {
    const { runMondayThreeDayDrafts, runMondayAgendaBlocks } = await import('../../monitoring/monday-prep.js');
    const results = job === 'drafts' ? await runMondayThreeDayDrafts(only) : await runMondayAgendaBlocks(only);
    return c.json({ status: 'done', job, results });
  } catch (err) {
    logger.error({ err, job }, 'monday-prep cron failed');
    return c.json({ error: (err as Error).message }, 500);
  }
});

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

/**
 * POST /api/cron/piper-my-moves
 *
 * Triggered by the droplet systemd timer (Mon/Wed/Fri mornings). Deterministic —
 * no LLM: fetches piper_my_moves_all() from the brain and posts the "My Real
 * Moves" parent + per-person threads to #piper as Piper.
 *
 * ?dry_run=1 → render but don't post; returns the full text in the response.
 */
cronRouter.post('/cron/piper-my-moves', async (c) => {
  if (!env.CRON_SECRET) {
    return c.json({ error: 'CRON_SECRET not configured' }, 503);
  }
  if (!cronAuthed(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const dryRun = c.req.query('dry_run') === '1';

  try {
    const result = await runPiperMyMoves({ post: !dryRun });
    return c.json({
      status: result.posted ? 'posted' : 'generated',
      channel: result.channel,
      ts: result.parentTs ?? null,
      people: result.peopleCount,
      moves: result.moveCount,
      chars: result.text.length,
      ...(dryRun ? { text: result.text } : {}),
    });
  } catch (err) {
    logger.error({ err }, 'piper-my-moves cron failed');
    return c.json({ error: (err as Error).message }, 500);
  }
});
