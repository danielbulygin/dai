/**
 * Meeting pipeline router — stores extraction, posts recap, triggers deep extraction.
 */

import { getDaiSupabase } from '../integrations/dai-supabase.js';
import { logger } from '../utils/logger.js';
import { postMeetingRecap } from './slack-recap.js';
import { deepExtractMethodology } from './deep-extractor.js';
import type { MeetingClassification } from './classifier.js';
import type { ExtractionResult } from './extractor.js';

export async function routeExtraction(
  meetingId: string,
  meetingTitle: string,
  meetingDate: string,
  classification: MeetingClassification,
  result: ExtractionResult,
): Promise<void> {
  const supabase = getDaiSupabase();
  const extraction = result.extraction;

  // 1. Upsert call_extractions row
  const { error } = await supabase
    .from('call_extractions')
    .upsert(
      {
        meeting_id: meetingId,
        client_code: classification.client_code,
        meeting_type: classification.meeting_type,
        is_external: classification.is_external,
        classification: classification as unknown as Record<string, unknown>,
        extraction: extraction as unknown as Record<string, unknown>,
        routing_signals: extraction.routing_signals as unknown as Record<string, unknown>,
        deep_extracted: false,
        model_used: result.model_used,
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
      },
      { onConflict: 'meeting_id' },
    );

  if (error) {
    logger.error({ error, meetingId }, 'Failed to upsert call_extractions');
    return;
  }

  // 2. Update pipeline_status
  await supabase
    .from('meetings')
    .update({ pipeline_status: 'routed' })
    .eq('id', meetingId);

  // 3. Post shadow-mode Slack recap (fire-and-forget)
  postMeetingRecap(meetingId, meetingTitle, classification, extraction).catch((err) =>
    logger.error({ err, meetingId }, 'Failed to post meeting recap'),
  );

  // 4. Conditional deep extraction for media buying content
  if (extraction.routing_signals.media_buying_depth === 'deep') {
    logger.info({ meetingId }, 'Triggering deep methodology extraction');
    // Fire-and-forget — deep extraction runs async
    deepExtractMethodology(meetingId, meetingTitle, meetingDate, extraction, classification).catch((err) =>
      logger.error({ err, meetingId }, 'Deep extraction failed'),
    );
  }
}
