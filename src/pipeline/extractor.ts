/**
 * Universal meeting extractor — single Sonnet call extracts for ALL agents.
 *
 * Produces structured data for:
 * - Amy: action items, decisions, sentiment, priority changes, open questions
 * - Ada: account insights, campaign decisions
 * - Maya: creative feedback
 * - Routing: media buying depth, creative content, urgency signals
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { normalizeAccountCode } from '../utils/account-codes.js';
import type { MeetingClassification } from './classifier.js';
import type { ExtractionContext } from './context-builder.js';

const EXTRACTION_MODEL = 'claude-sonnet-4-6';
const MIN_TRANSCRIPT_LENGTH = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActionItem {
  text: string;
  assignee: string | null;
  deadline: string | null;
  confidence: number;
  source_quote: string;
}

export interface Decision {
  text: string;
  rationale: string | null;
  account_code: string | null;
}

export interface AccountInsight {
  account_code: string;
  insight: string;
  category: string;
  confidence: 'high' | 'medium';
}

export interface CampaignDecision {
  account_code: string;
  decision_type: string;
  target: string;
  reasoning: string;
}

export interface CreativeFeedback {
  account_code: string | null;
  feedback: string;
  format_or_angle: string | null;
}

export interface RoutingSignals {
  has_media_buying_content: boolean;
  media_buying_depth: 'none' | 'shallow' | 'deep';
  has_creative_content: boolean;
  urgency_signals: string[];
}

export interface UniversalExtraction {
  // Amy
  action_items: ActionItem[];
  decisions: Decision[];
  sentiment: string;
  priority_changes: string[];
  open_questions: string[];
  initiative_updates: string[];

  // Ada
  account_insights: AccountInsight[];
  campaign_decisions: CampaignDecision[];

  // Maya
  creative_feedback: CreativeFeedback[];

  // Routing
  routing_signals: RoutingSignals;
}

export interface ExtractionResult {
  extraction: UniversalExtraction;
  model_used: string;
  input_tokens: number;
  output_tokens: number;
}

// ---------------------------------------------------------------------------
// Anthropic client (lazy)
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Empty extraction (for short/missing transcripts)
// ---------------------------------------------------------------------------

export function emptyExtraction(): UniversalExtraction {
  return {
    action_items: [],
    decisions: [],
    sentiment: 'neutral',
    priority_changes: [],
    open_questions: [],
    initiative_updates: [],
    account_insights: [],
    campaign_decisions: [],
    creative_feedback: [],
    routing_signals: {
      has_media_buying_content: false,
      media_buying_depth: 'none',
      has_creative_content: false,
      urgency_signals: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Main extractor
// ---------------------------------------------------------------------------

export async function extractFromMeeting(
  meeting: { id: string; title: string | null; full_transcript: string; short_summary: string | null },
  classification: MeetingClassification,
  context?: ExtractionContext,
): Promise<ExtractionResult> {
  const transcript = meeting.full_transcript;

  // Skip short/empty transcripts
  if (!transcript || transcript.length < MIN_TRANSCRIPT_LENGTH) {
    logger.info({ meetingId: meeting.id, length: transcript?.length ?? 0 }, 'Transcript too short, returning empty extraction');
    return {
      extraction: emptyExtraction(),
      model_used: EXTRACTION_MODEL,
      input_tokens: 0,
      output_tokens: 0,
    };
  }

  // Truncate very long transcripts
  const maxChars = 100_000;
  const truncated = transcript.length > maxChars
    ? transcript.slice(0, maxChars) + '\n\n[... transcript truncated]'
    : transcript;

  // Build system prompt with context
  const systemParts: string[] = [
    'You are a meeting intelligence system. Extract structured data from the transcript below.',
    '',
    `Meeting: "${meeting.title ?? 'Untitled'}"`,
    `Type: ${classification.meeting_type}`,
    classification.client_code ? `Client: ${classification.client_code} (${classification.client_name})` : 'Client: Unknown',
    classification.is_external ? 'External meeting (client participants present)' : 'Internal meeting',
    '',
  ];

  if (context?.clientContext) {
    systemParts.push('=== CLIENT CONTEXT ===', context.clientContext, '');
  }
  if (context?.recentLearnings) {
    systemParts.push('=== RECENT LEARNINGS ===', context.recentLearnings, '');
  }
  if (context?.previousExtraction) {
    systemParts.push(
      '=== PREVIOUS CALL EXTRACTION (for continuity) ===',
      context.previousExtraction,
      '',
    );
  }

  systemParts.push(
    '=== EXTRACTION SCHEMA ===',
    'Return a single JSON object with these fields:',
    '',
    '1. action_items: Array of { text, assignee (name or null), deadline (date string or null), confidence (0-1), source_quote (verbatim from transcript) }',
    '2. decisions: Array of { text, rationale (or null), account_code (or null) }',
    '3. sentiment: Overall meeting sentiment — one of "positive", "neutral", "negative", "mixed"',
    '4. priority_changes: Array of strings describing any shifts in priorities',
    '5. open_questions: Array of unresolved questions from the meeting',
    '6. initiative_updates: Array of updates to ongoing projects/initiatives',
    '',
    '7. account_insights: Array of { account_code, insight, category (one of: performance, creative, strategy, audience, budget), confidence ("high" or "medium") }',
    '8. campaign_decisions: Array of { account_code, decision_type (scale/kill/pause/restructure/test), target (campaign/adset/ad), reasoning }',
    '',
    '9. creative_feedback: Array of { account_code (or null), feedback, format_or_angle (or null) }',
    '',
    '10. routing_signals: { has_media_buying_content (bool), media_buying_depth ("none"/"shallow"/"deep"), has_creative_content (bool), urgency_signals (array of strings) }',
    '    - "deep" means detailed campaign-level discussion (specific CPAs, ad set decisions, budget changes)',
    '    - "shallow" means passing mentions of ad performance',
    '',
    'IMPORTANT:',
    '- Return ONLY valid JSON. No markdown, no backticks, no explanation.',
    '- Use lowercase underscore-separated account codes (e.g. "audibene", "ninepine").',
    '- Omit empty arrays (but always include routing_signals).',
    '- Be precise with action items — only extract clear commitments, not vague intentions.',
  );

  try {
    const response = await getClient().messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 8192,
      system: systemParts.join('\n'),
      messages: [
        {
          role: 'user',
          content: [
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

    // Strip markdown code fences if present
    const cleaned = responseText
      .replace(/^```(?:json)?\s*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();

    const raw = JSON.parse(cleaned);
    const extraction = normalizeExtraction(raw);

    return {
      extraction,
      model_used: EXTRACTION_MODEL,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    };
  } catch (err) {
    logger.error({ err, meetingId: meeting.id }, 'Extraction failed, returning empty');
    return {
      extraction: emptyExtraction(),
      model_used: EXTRACTION_MODEL,
      input_tokens: 0,
      output_tokens: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Normalize extraction (account codes, defaults)
// ---------------------------------------------------------------------------

function normalizeExtraction(raw: Record<string, unknown>): UniversalExtraction {
  const base = emptyExtraction();

  // Action items
  if (Array.isArray(raw.action_items)) {
    base.action_items = raw.action_items.map((item: Record<string, unknown>) => ({
      text: String(item.text ?? ''),
      assignee: item.assignee ? String(item.assignee) : null,
      deadline: item.deadline ? String(item.deadline) : null,
      confidence: typeof item.confidence === 'number' ? item.confidence : 0.5,
      source_quote: String(item.source_quote ?? ''),
    }));
  }

  // Decisions
  if (Array.isArray(raw.decisions)) {
    base.decisions = raw.decisions.map((d: Record<string, unknown>) => ({
      text: String(d.text ?? ''),
      rationale: d.rationale ? String(d.rationale) : null,
      account_code: d.account_code ? normalizeAccountCode(String(d.account_code)) : null,
    }));
  }

  // Sentiment
  if (typeof raw.sentiment === 'string') {
    base.sentiment = raw.sentiment;
  }

  // Simple string arrays
  if (Array.isArray(raw.priority_changes)) {
    base.priority_changes = raw.priority_changes.map(String);
  }
  if (Array.isArray(raw.open_questions)) {
    base.open_questions = raw.open_questions.map(String);
  }
  if (Array.isArray(raw.initiative_updates)) {
    base.initiative_updates = raw.initiative_updates.map(String);
  }

  // Account insights
  if (Array.isArray(raw.account_insights)) {
    base.account_insights = raw.account_insights.map((i: Record<string, unknown>) => ({
      account_code: normalizeAccountCode(String(i.account_code ?? '')),
      insight: String(i.insight ?? ''),
      category: String(i.category ?? ''),
      confidence: (i.confidence === 'high' || i.confidence === 'medium') ? i.confidence : 'medium',
    }));
  }

  // Campaign decisions
  if (Array.isArray(raw.campaign_decisions)) {
    base.campaign_decisions = raw.campaign_decisions.map((d: Record<string, unknown>) => ({
      account_code: normalizeAccountCode(String(d.account_code ?? '')),
      decision_type: String(d.decision_type ?? ''),
      target: String(d.target ?? ''),
      reasoning: String(d.reasoning ?? ''),
    }));
  }

  // Creative feedback
  if (Array.isArray(raw.creative_feedback)) {
    base.creative_feedback = raw.creative_feedback.map((f: Record<string, unknown>) => ({
      account_code: f.account_code ? normalizeAccountCode(String(f.account_code)) : null,
      feedback: String(f.feedback ?? ''),
      format_or_angle: f.format_or_angle ? String(f.format_or_angle) : null,
    }));
  }

  // Routing signals
  if (raw.routing_signals && typeof raw.routing_signals === 'object') {
    const rs = raw.routing_signals as Record<string, unknown>;
    base.routing_signals = {
      has_media_buying_content: Boolean(rs.has_media_buying_content),
      media_buying_depth: (['none', 'shallow', 'deep'].includes(String(rs.media_buying_depth))
        ? String(rs.media_buying_depth) as 'none' | 'shallow' | 'deep'
        : 'none'),
      has_creative_content: Boolean(rs.has_creative_content),
      urgency_signals: Array.isArray(rs.urgency_signals) ? rs.urgency_signals.map(String) : [],
    };
  }

  return base;
}
