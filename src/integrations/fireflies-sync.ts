/**
 * Scheduled Fireflies team sync — pulls ALL team meetings (not just Daniel's).
 *
 * The webhook only fires for Daniel's recordings. This job polls the
 * Fireflies API as admin (mine=false) to catch meetings recorded by
 * Nina, Vanessa, Mikel, Jewel, Manuel, etc.
 *
 * Runs every 30 min during work hours. Looks back 48h. Budget: 25 API calls.
 */

import { env } from '../env.js';
import { getDaiSupabase } from './dai-supabase.js';
import { logger } from '../utils/logger.js';

const FIREFLIES_API = 'https://api.fireflies.ai/graphql';
const REQUEST_DELAY_MS = 1500;
const API_BUDGET = 25; // per run — listing + detail fetches
const LOOKBACK_HOURS = 48;

let apiCalls = 0;

// ---------------------------------------------------------------------------
// Fireflies GraphQL client
// ---------------------------------------------------------------------------

async function firefliesQuery(
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const apiKey = env.FIREFLIES_API_KEY;
  if (!apiKey) {
    logger.warn('FIREFLIES_API_KEY not set, skipping sync');
    return null;
  }

  apiCalls++;
  if (apiCalls > API_BUDGET) {
    logger.info({ apiCalls, budget: API_BUDGET }, 'Fireflies sync: API budget exhausted');
    return null;
  }

  await sleep(REQUEST_DELAY_MS);

  const res = await fetch(FIREFLIES_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    if (res.status === 429) {
      logger.warn('Fireflies sync: rate limited (429)');
      return null;
    }
    throw new Error(`Fireflies API ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };

  if (json.errors?.length) {
    const code = json.errors[0].extensions?.code ?? '';
    if (code === 'auth_failed') {
      logger.warn('Fireflies sync: auth_failed (likely rate limit)');
      return null;
    }
    throw new Error(`Fireflies GraphQL: ${json.errors[0].message}`);
  }

  return json.data ?? null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TranscriptListItem {
  id: string;
  title: string;
  date: string; // Unix ms as string
  organizer_email: string;
}

interface MeetingDetail {
  id: string;
  title: string;
  date: string;
  duration: number;
  organizer_email: string;
  participants: string[];
  speakers: Array<{ name: string }>;
  summary: {
    keywords: string[];
    action_items: string;
    overview: string;
    shorthand_bullet: string;
    gist: string;
    short_summary: string;
  };
  sentences: Array<{
    index: number;
    speaker_name: string;
    text: string;
    raw_text: string;
    start_time: number;
    end_time: number;
  }>;
}

// ---------------------------------------------------------------------------
// Core sync logic
// ---------------------------------------------------------------------------

/**
 * Sync recent team meetings from Fireflies into the meetings table.
 * Returns the number of new meetings synced.
 */
export async function syncTeamMeetings(): Promise<number> {
  apiCalls = 0; // reset per run
  const supabase = getDaiSupabase();

  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const sinceIso = since.toISOString();

  // 1. List recent meetings from Fireflies (all team, not just mine)
  const data = await firefliesQuery(
    `query($fromDate: DateTime, $limit: Int) {
      transcripts(fromDate: $fromDate, limit: $limit) {
        id title date organizer_email
      }
    }`,
    { fromDate: sinceIso, limit: 50 },
  );

  if (!data) return 0;
  const meetings = (data.transcripts ?? []) as TranscriptListItem[];

  if (meetings.length === 0) {
    logger.debug('Fireflies sync: no meetings in lookback window');
    return 0;
  }

  // 2. Check which ones we already have
  const ids = meetings.map((m) => m.id);
  const { data: existing } = await supabase
    .from('meetings')
    .select('id')
    .in('id', ids);

  const existingIds = new Set((existing ?? []).map((r: { id: string }) => r.id));
  const newMeetings = meetings.filter((m) => !existingIds.has(m.id));

  if (newMeetings.length === 0) {
    logger.debug({ listed: meetings.length }, 'Fireflies sync: all meetings already in DB');
    return 0;
  }

  logger.info(
    { listed: meetings.length, new: newMeetings.length, existing: existingIds.size },
    'Fireflies sync: found new meetings to sync',
  );

  // 3. Fetch details and upsert each new meeting
  let synced = 0;

  for (const m of newMeetings) {
    if (apiCalls >= API_BUDGET) {
      logger.info({ synced, remaining: newMeetings.length - synced }, 'Fireflies sync: budget reached, will continue next run');
      break;
    }

    try {
      const detail = await fetchMeetingDetail(m.id);
      if (!detail) break; // budget or rate limited

      await upsertMeeting(supabase, detail);
      synced++;

      logger.debug(
        { meetingId: m.id, title: m.title, organizer: detail.organizer_email },
        'Fireflies sync: synced meeting',
      );
    } catch (err) {
      logger.error({ err, meetingId: m.id, title: m.title }, 'Fireflies sync: failed to sync meeting');
    }
  }

  // 4. Dedup (keeps Daniel's copy when multiple recordings of same meeting exist)
  if (synced > 0) {
    try {
      const { data: dedupResult } = await supabase.rpc('dedup_meetings');
      const deduped = dedupResult?.[0]?.deleted_count ?? dedupResult?.deleted_count ?? 0;
      if (deduped > 0) {
        logger.info({ deduped }, 'Fireflies sync: deduped meetings');
      }
    } catch (err) {
      logger.warn({ err }, 'Fireflies sync: dedup failed (non-fatal)');
    }
  }

  logger.info(
    { synced, apiCalls, budget: API_BUDGET },
    'Fireflies sync complete',
  );

  return synced;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchMeetingDetail(id: string): Promise<MeetingDetail | null> {
  const data = await firefliesQuery(
    `query($id: String!) {
      transcript(id: $id) {
        id title date duration organizer_email participants
        speakers { name }
        summary { keywords action_items overview shorthand_bullet gist short_summary }
        sentences { index speaker_name text raw_text start_time end_time }
      }
    }`,
    { id },
  );

  if (!data) return null;
  return data.transcript as MeetingDetail;
}

async function upsertMeeting(
  supabase: ReturnType<typeof getDaiSupabase>,
  meeting: MeetingDetail,
): Promise<void> {
  const speakers = meeting.speakers?.map((s) => s.name) ?? [];
  const summary = meeting.summary ?? ({} as MeetingDetail['summary']);
  const fullTranscript = (meeting.sentences ?? [])
    .map((s) => `${s.speaker_name}: ${s.text}`)
    .join('\n');

  const { error } = await supabase.from('meetings').upsert({
    id: meeting.id,
    title: meeting.title,
    date: meeting.date ? new Date(parseInt(meeting.date)).toISOString() : null,
    duration: meeting.duration,
    organizer_email: meeting.organizer_email,
    speakers,
    participant_emails: meeting.participants ?? [],
    short_summary: summary.short_summary ?? null,
    keywords: summary.keywords ?? [],
    action_items: summary.action_items ?? null,
    overview: summary.overview ?? null,
    notes: summary.shorthand_bullet ?? null,
    gist: summary.gist ?? null,
    full_transcript: fullTranscript || null,
  });

  if (error) throw new Error(`Upsert meeting ${meeting.id}: ${error.message}`);

  // Upsert sentences (delete + reinsert)
  const sentences = meeting.sentences ?? [];
  if (sentences.length > 0) {
    await supabase.from('meeting_sentences').delete().eq('meeting_id', meeting.id);

    for (let i = 0; i < sentences.length; i += 200) {
      const chunk = sentences.slice(i, i + 200).map((s) => ({
        meeting_id: meeting.id,
        sentence_index: s.index,
        speaker_name: s.speaker_name,
        text: s.text,
        raw_text: s.raw_text,
        start_time: s.start_time,
        end_time: s.end_time,
      }));
      await supabase.from('meeting_sentences').insert(chunk);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
