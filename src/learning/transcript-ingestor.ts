import Anthropic from '@anthropic-ai/sdk';
import { nanoid } from 'nanoid';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { getDb } from '../memory/db.js';
import { addLearning, searchLearnings } from '../memory/learnings.js';
import { getDaiSupabase } from '../integrations/dai-supabase.js';
import { getMeetingTranscript } from '../agents/tools/fireflies-tools.js';
import { matchMeetingPattern } from './meeting-patterns.js';

const EXTRACTION_MODEL = 'claude-sonnet-4-20250514';
const ADA_AGENT_ID = 'ada';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

interface ExtractedInsight {
  category: string;
  content: string;
  confidence: number;
  account_code?: string;
}

export async function ingestNewTranscripts(): Promise<number> {
  logger.info('Starting transcript ingestion for media buying insights');

  // Get last ingestion date
  const lastIngested = getLastIngestionDate();
  const since = lastIngested ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Fetch meetings since last ingestion
  const supabase = getDaiSupabase();
  const { data: meetings, error } = await supabase
    .from('meetings')
    .select('id, title, date, speakers, short_summary')
    .gt('date', since)
    .order('date', { ascending: true });

  if (error) {
    logger.error({ error }, 'Failed to fetch meetings for ingestion');
    return 0;
  }

  if (!meetings || meetings.length === 0) {
    logger.debug('No new meetings to ingest');
    return 0;
  }

  // Filter out already-ingested meetings
  const ingestedIds = getIngestedMeetingIds();
  const newMeetings = meetings.filter((m) => !ingestedIds.has(m.id));

  if (newMeetings.length === 0) {
    logger.debug('All meetings already ingested');
    return 0;
  }

  let totalInsights = 0;

  for (const meeting of newMeetings) {
    const pattern = matchMeetingPattern(
      meeting.title ?? '',
      meeting.speakers ?? [],
      meeting.short_summary ?? undefined,
    );

    if (!pattern) {
      // Log as skipped — no matching pattern
      logIngestion(meeting.id, meeting.title, null, 0);
      continue;
    }

    try {
      const insights = await extractInsightsFromMeeting(meeting, pattern);
      const deduped = await deduplicateInsights(insights);

      for (const insight of deduped) {
        addLearning({
          agent_id: ADA_AGENT_ID,
          category: insight.category,
          content: insight.account_code
            ? `[${insight.account_code}] ${insight.content}`
            : insight.content,
          confidence: insight.confidence,
        });
      }

      logIngestion(meeting.id, meeting.title, pattern.id, deduped.length);
      totalInsights += deduped.length;

      logger.info(
        { meetingId: meeting.id, title: meeting.title, pattern: pattern.id, insights: deduped.length },
        'Ingested meeting transcript',
      );
    } catch (err) {
      logger.error(
        { error: err, meetingId: meeting.id },
        'Failed to ingest meeting transcript, continuing',
      );
      // Log as attempted with 0 insights so we don't retry
      logIngestion(meeting.id, meeting.title, pattern.id, 0);
    }
  }

  logger.info(
    { totalInsights, meetingsProcessed: newMeetings.length },
    'Transcript ingestion complete',
  );
  return totalInsights;
}

async function extractInsightsFromMeeting(
  meeting: { id: string; title: string; speakers?: string[]; short_summary?: string },
  pattern: { extractionFocus: string; description: string },
): Promise<ExtractedInsight[]> {
  // Fetch the full transcript
  const transcriptRaw = await getMeetingTranscript({ meetingId: meeting.id });
  const transcript = JSON.parse(transcriptRaw);

  if (!Array.isArray(transcript) || transcript.length === 0) {
    logger.debug({ meetingId: meeting.id }, 'Empty transcript, skipping');
    return [];
  }

  // Format transcript for Claude
  const formattedTranscript = transcript
    .map((s: { speaker_name: string; text: string }) => `${s.speaker_name}: ${s.text}`)
    .join('\n');

  // Truncate if very long (keep under ~30k tokens worth)
  const maxChars = 80000;
  const truncated = formattedTranscript.length > maxChars
    ? formattedTranscript.slice(0, maxChars) + '\n\n[... transcript truncated]'
    : formattedTranscript;

  const response = await getClient().messages.create({
    model: EXTRACTION_MODEL,
    max_tokens: 4096,
    system: [
      'Extract media buying insights from this meeting transcript.',
      `Meeting type: ${pattern.description}`,
      `Focus on: ${pattern.extractionFocus}`,
      '',
      'For each insight, provide a JSON array of objects with:',
      '- category: one of "account_insight", "methodology", "creative", "account_profile", "optimization_pattern"',
      '- content: the insight text (specific, actionable, 1-3 sentences)',
      '- confidence: 0-1 how confident you are this is a real insight',
      '- account_code: client code if applicable (lowercase, underscore-separated), or null',
      '',
      'Only extract insights that would help a media buyer make better decisions.',
      'Do NOT extract pleasantries, scheduling, or off-topic discussion.',
      'Do NOT extract obvious or generic advice.',
      'Return ONLY a valid JSON array, no other text.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: [
          `Meeting: ${meeting.title}`,
          meeting.short_summary ? `Summary: ${meeting.short_summary}` : '',
          '',
          'Transcript:',
          truncated,
        ].filter(Boolean).join('\n'),
      },
    ],
  });

  const responseText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  try {
    const insights = JSON.parse(responseText) as ExtractedInsight[];
    return Array.isArray(insights) ? insights : [];
  } catch {
    logger.warn({ meetingId: meeting.id }, 'Failed to parse extraction response');
    return [];
  }
}

async function deduplicateInsights(insights: ExtractedInsight[]): Promise<ExtractedInsight[]> {
  const deduped: ExtractedInsight[] = [];

  for (const insight of insights) {
    // Search existing learnings for similar content
    try {
      const existing = searchLearnings(insight.content.split(' ').slice(0, 5).join(' '));
      const isDuplicate = existing.some((e) => {
        const overlap = computeOverlap(e.content, insight.content);
        return overlap > 0.6;
      });

      if (!isDuplicate) {
        deduped.push(insight);
      }
    } catch {
      // FTS search can fail on unusual queries — include the insight
      deduped.push(insight);
    }
  }

  return deduped;
}

function computeOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

// ---------------------------------------------------------------------------
// Ingestion log helpers
// ---------------------------------------------------------------------------

function getLastIngestionDate(): string | null {
  const db = getDb();
  const row = db
    .prepare('SELECT created_at FROM transcript_ingestion_log ORDER BY created_at DESC LIMIT 1')
    .get() as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

function getIngestedMeetingIds(): Set<string> {
  const db = getDb();
  const rows = db
    .prepare('SELECT meeting_id FROM transcript_ingestion_log')
    .all() as { meeting_id: string }[];
  return new Set(rows.map((r) => r.meeting_id));
}

function logIngestion(
  meetingId: string,
  meetingTitle: string | null,
  patternId: string | null,
  insightsExtracted: number,
): void {
  const db = getDb();
  try {
    db.prepare(`
      INSERT OR IGNORE INTO transcript_ingestion_log (id, meeting_id, meeting_title, pattern_id, insights_extracted)
      VALUES (?, ?, ?, ?, ?)
    `).run(nanoid(), meetingId, meetingTitle, patternId, insightsExtracted);
  } catch (err) {
    logger.warn({ error: err, meetingId }, 'Failed to log ingestion');
  }
}
