/**
 * Meeting Intelligence Pipeline — orchestrator.
 *
 * classify → build context → extract → route
 */

import { getDaiSupabase } from '../integrations/dai-supabase.js';
import { logger } from '../utils/logger.js';
import { classifyMeeting, type MeetingRow } from './classifier.js';
import { buildExtractionContext } from './context-builder.js';
import { extractFromMeeting } from './extractor.js';
import { routeExtraction } from './router.js';

/**
 * Process a single meeting through the full pipeline.
 * Idempotent — skips if already processed (pipeline_status is non-null).
 */
export async function processMeeting(meetingId: string): Promise<void> {
  const supabase = getDaiSupabase();

  // Fetch meeting
  const { data: meeting, error } = await supabase
    .from('meetings')
    .select('id, title, date, speakers, participant_emails, short_summary, organizer_email, full_transcript, pipeline_status')
    .eq('id', meetingId)
    .maybeSingle();

  if (error) {
    logger.error({ error, meetingId }, 'Failed to fetch meeting for pipeline');
    return;
  }

  if (!meeting) {
    logger.warn({ meetingId }, 'Meeting not found');
    return;
  }

  // Skip already-processed meetings
  if (meeting.pipeline_status) {
    logger.debug({ meetingId, status: meeting.pipeline_status }, 'Meeting already processed, skipping');
    return;
  }

  const row = meeting as MeetingRow & { full_transcript: string; pipeline_status: string | null };

  logger.info({ meetingId, title: row.title }, 'Processing meeting through pipeline');

  // 1. Classify
  const classification = classifyMeeting(row);

  // Mark as classified
  await supabase
    .from('meetings')
    .update({ pipeline_status: 'classified' })
    .eq('id', meetingId);

  // 2. Build context
  const context = await buildExtractionContext(classification);

  // 3. Extract
  const result = await extractFromMeeting(
    { id: row.id, title: row.title, full_transcript: row.full_transcript, short_summary: row.short_summary },
    classification,
    context,
  );

  // Mark as extracted
  await supabase
    .from('meetings')
    .update({ pipeline_status: 'extracted' })
    .eq('id', meetingId);

  // 4. Route (stores, posts recap, triggers deep extraction if needed)
  const meetingDate = row.date
    ? new Date(row.date).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  await routeExtraction(
    meetingId,
    row.title ?? 'Untitled',
    meetingDate,
    classification,
    result,
  );

  logger.info(
    {
      meetingId,
      title: row.title,
      client: classification.client_code,
      type: classification.meeting_type,
      actionItems: result.extraction.action_items.length,
      mediaBuyingDepth: result.extraction.routing_signals.media_buying_depth,
    },
    'Meeting pipeline complete',
  );
}

/**
 * Process all unprocessed meetings (pipeline_status IS NULL).
 * Only looks back 7 days to avoid blasting through the entire backlog.
 * Returns the number of meetings processed.
 */
export async function processNewMeetings(): Promise<number> {
  const supabase = getDaiSupabase();

  // Only process recent meetings (7-day window) to avoid burning through
  // the entire 2000+ meeting backlog on first deploy
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: meetings, error } = await supabase
    .from('meetings')
    .select('id, title')
    .is('pipeline_status', null)
    .gt('date', since)
    .order('date', { ascending: true })
    .limit(10); // Process up to 10 per batch to avoid timeouts

  if (error) {
    logger.error({ error }, 'Failed to fetch unprocessed meetings');
    return 0;
  }

  if (!meetings || meetings.length === 0) {
    logger.debug('No unprocessed meetings found');
    return 0;
  }

  logger.info({ count: meetings.length }, 'Processing unprocessed meetings');

  let processed = 0;
  for (const meeting of meetings) {
    try {
      await processMeeting(meeting.id);
      processed++;
    } catch (err) {
      logger.error({ err, meetingId: meeting.id }, 'Failed to process meeting, continuing');
    }
  }

  logger.info({ processed, total: meetings.length }, 'Batch processing complete');
  return processed;
}
