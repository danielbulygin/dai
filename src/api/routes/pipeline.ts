import { Hono } from 'hono';
import { logger } from '../../utils/logger.js';

export const pipelineRouter = new Hono();

/**
 * POST /api/process-meeting
 * Body: { meetingId: string }
 *
 * Triggers pipeline processing for a single meeting.
 * Called by the Fireflies webhook for near-real-time processing.
 */
pipelineRouter.post('/process-meeting', async (c) => {
  const body = await c.req.json<{ meetingId?: string }>();

  if (!body.meetingId) {
    return c.json({ error: 'Missing meetingId' }, 400);
  }

  const { meetingId } = body;

  // Fire-and-forget — don't block the webhook response
  import('../../pipeline/index.js')
    .then(({ processMeeting }) => processMeeting(meetingId))
    .catch((err) => logger.error({ err, meetingId }, 'Pipeline processing failed'));

  return c.json({ status: 'queued', meetingId });
});
