/**
 * Conditional deep extraction — Opus focuses on methodology depth.
 *
 * Uses Stage 2 output (the universal extraction) as input, NOT the raw
 * transcript. Opus analyses the extracted account insights + campaign
 * decisions for methodology patterns, then sends for approval via the
 * existing insight-approval flow.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { getDaiSupabase } from '../integrations/dai-supabase.js';
import { normalizeAccountCode } from '../utils/account-codes.js';
import { sendInsightsForApproval } from '../learning/insight-approval.js';
import type { MethodologyInsight } from '../learning/methodology-extractor.js';
import type { MeetingClassification } from './classifier.js';
import type { UniversalExtraction } from './extractor.js';

const DEEP_MODEL = 'claude-opus-4-6';

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return _client;
}

export async function deepExtractMethodology(
  meetingId: string,
  meetingTitle: string,
  meetingDate: string,
  extraction: UniversalExtraction,
  classification: MeetingClassification,
): Promise<void> {
  logger.info({ meetingId, meetingTitle }, 'Starting deep methodology extraction');

  // Build input from Stage 2 output — Opus works on concentrated data
  const inputParts: string[] = [
    `Meeting: "${meetingTitle}" (${meetingDate})`,
    classification.client_code ? `Client: ${classification.client_code}` : '',
    '',
  ];

  if (extraction.account_insights.length > 0) {
    inputParts.push('=== Account Insights ===');
    for (const i of extraction.account_insights) {
      inputParts.push(`[${i.account_code}] (${i.category}, ${i.confidence}) ${i.insight}`);
    }
    inputParts.push('');
  }

  if (extraction.campaign_decisions.length > 0) {
    inputParts.push('=== Campaign Decisions ===');
    for (const d of extraction.campaign_decisions) {
      inputParts.push(`[${d.account_code}] ${d.decision_type}: ${d.target} — ${d.reasoning}`);
    }
    inputParts.push('');
  }

  if (extraction.decisions.length > 0) {
    inputParts.push('=== General Decisions ===');
    for (const d of extraction.decisions) {
      inputParts.push(`${d.text}${d.rationale ? ` — ${d.rationale}` : ''}`);
    }
    inputParts.push('');
  }

  if (extraction.creative_feedback.length > 0) {
    inputParts.push('=== Creative Feedback ===');
    for (const f of extraction.creative_feedback) {
      inputParts.push(`${f.account_code ? `[${f.account_code}] ` : ''}${f.feedback}`);
    }
    inputParts.push('');
  }

  const system = [
    'You are a senior media buying methodology analyst. Analyse the structured meeting extraction below',
    'and identify methodology insights that should be preserved for long-term learning.',
    '',
    'For each insight, classify it into one of these types:',
    '- rule: A general principle or rule of thumb for media buying',
    '- insight: An account-specific observation or learning',
    '- decision: A noteworthy decision with reasoning worth preserving',
    '- creative_pattern: A pattern about creative performance or strategy',
    '- methodology: A step or process in how the team approaches media buying',
    '',
    'Also classify durability:',
    '- durable: Lasting methodology that applies beyond this specific situation',
    '- situational: Time-bound observation specific to current conditions',
    '',
    'Return a JSON array of objects with: type, title, body (object with relevant fields), account_code (lowercase or null), category, confidence ("high"/"medium"), durability.',
    '',
    'IMPORTANT: Return ONLY valid JSON array. No markdown, no backticks.',
    'Only extract insights with real analytical depth — skip obvious or shallow observations.',
  ].join('\n');

  try {
    const response = await getClient().messages.create({
      model: DEEP_MODEL,
      max_tokens: 8192,
      system,
      messages: [{ role: 'user', content: inputParts.filter(Boolean).join('\n') }],
    });

    const responseText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    // Strip markdown fences — handle ```json\n...\n``` wrapping
    const fenceMatch = responseText.match(/```(?:json)?\s*\n([\s\S]*?)\n```/i);
    const cleaned = (fenceMatch ? fenceMatch[1] : responseText).trim();

    const raw = JSON.parse(cleaned) as Array<Record<string, unknown>>;
    if (!Array.isArray(raw) || raw.length === 0) {
      logger.info({ meetingId }, 'Deep extraction produced no insights');
      return;
    }

    // Normalize into MethodologyInsight[]
    const insights: MethodologyInsight[] = raw.map((item) => ({
      type: (['rule', 'insight', 'decision', 'creative_pattern', 'methodology'].includes(String(item.type))
        ? String(item.type) as MethodologyInsight['type']
        : 'insight'),
      title: String(item.title ?? ''),
      body: (item.body && typeof item.body === 'object' ? item.body : {}) as Record<string, unknown>,
      account_code: item.account_code ? normalizeAccountCode(String(item.account_code)) : null,
      category: item.category ? String(item.category) : null,
      confidence: (item.confidence === 'high' ? 'high' : 'medium'),
      durability: (item.durability === 'situational' ? 'situational' : 'durable'),
    }));

    // Send for approval via existing flow
    const counts = await sendInsightsForApproval(insights, meetingId, meetingTitle, meetingDate);
    logger.info(
      { meetingId, durable: counts.durable, situational: counts.situational },
      'Deep extraction sent for approval',
    );

    // Update call_extractions
    const supabase = getDaiSupabase();
    await supabase
      .from('call_extractions')
      .update({ deep_extracted: true })
      .eq('meeting_id', meetingId);

    // Update meetings pipeline_status
    await supabase
      .from('meetings')
      .update({ pipeline_status: 'deep_extracted' })
      .eq('id', meetingId);

    // Log for backward compat with transcript_ingestion_log
    await supabase
      .from('transcript_ingestion_log')
      .upsert(
        {
          id: `pipeline-${meetingId}`,
          meeting_id: meetingId,
          meeting_title: meetingTitle,
          pattern_id: 'meeting-pipeline-deep',
          insights_extracted: insights.length,
        },
        { onConflict: 'meeting_id', ignoreDuplicates: true },
      );
  } catch (err) {
    logger.error({ err, meetingId }, 'Deep methodology extraction failed');
  }
}
