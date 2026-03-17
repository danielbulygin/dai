/**
 * Test the meeting pipeline on real meetings.
 * Usage: pnpm tsx scripts/test-pipeline.ts [--classify-only] [meetingId...]
 */

import { getDaiSupabase } from '../src/integrations/dai-supabase.js';
import { classifyMeeting } from '../src/pipeline/classifier.js';
import { isInternalEmail } from '../src/config/client-domains.js';
import { processMeeting } from '../src/pipeline/index.js';

const args = process.argv.slice(2);
const classifyOnly = args.includes('--classify-only');
const meetingIds = args.filter((a) => !a.startsWith('--'));

async function run(): Promise<void> {
  const supabase = getDaiSupabase();

  // If no IDs provided, pick 3 recent diverse meetings
  let ids = meetingIds;
  if (ids.length === 0) {
    const { data } = await supabase
      .from('meetings')
      .select('id, title, date')
      .is('pipeline_status', null)
      .order('date', { ascending: false })
      .limit(5);

    ids = (data ?? []).map((m: { id: string }) => m.id);
    console.log(`No IDs provided, using ${ids.length} recent meetings\n`);
  }

  for (const id of ids) {
    const { data: meeting } = await supabase
      .from('meetings')
      .select('id, title, date, speakers, participant_emails, short_summary, organizer_email, full_transcript')
      .eq('id', id)
      .single();

    if (!meeting) {
      console.log(`Not found: ${id}`);
      continue;
    }

    console.log(`=== ${meeting.title} (${(meeting.date as string)?.slice(0, 10)}) ===`);

    // Debug emails
    const rawEmails = (meeting.participant_emails ?? []) as string[];
    const nonInternal = rawEmails.map((e) => e.trim()).filter((e) => e && !isInternalEmail(e));
    if (rawEmails.length > 0) {
      console.log(`Emails: ${rawEmails.length} total, ${nonInternal.length} non-internal`);
      if (nonInternal.length > 0) console.log('  Non-internal:', nonInternal);
    }

    // Always classify
    const classification = classifyMeeting(meeting);
    console.log('Classification:', JSON.stringify(classification, null, 2));
    console.log(`Transcript length: ${(meeting.full_transcript as string)?.length ?? 0} chars`);

    if (!classifyOnly) {
      console.log('\nRunning full pipeline...');
      // Reset pipeline_status so we can re-run
      await supabase.from('meetings').update({ pipeline_status: null }).eq('id', id);
      await processMeeting(id);
      console.log('Done.\n');

      // Show what was stored
      const { data: extraction } = await supabase
        .from('call_extractions')
        .select('client_code, meeting_type, is_external, deep_extracted, model_used, input_tokens, output_tokens')
        .eq('meeting_id', id)
        .single();

      if (extraction) {
        console.log('Stored extraction:', JSON.stringify(extraction, null, 2));
      }
    }

    console.log();
  }
}

run().catch(console.error);
