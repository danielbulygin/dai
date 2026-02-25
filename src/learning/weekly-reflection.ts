import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { getRecentSessions } from '../memory/sessions.js';
import { getLearnings, addLearning } from '../memory/learnings.js';
import { getRecentDecisions } from '../memory/decisions.js';
import { getUnprocessedFeedback, getFeedbackForSession } from '../memory/feedback.js';
import { postMessage } from '../agents/tools/slack-tools.js';
import { getDb } from '../memory/db.js';

const REFLECTION_MODEL = 'claude-opus-4-6';
const ADA_AGENT_ID = 'ada';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

export async function generateWeeklyReflection(): Promise<void> {
  logger.info('Generating Ada weekly reflection');

  // Gather data
  const sessions = getRecentSessions(ADA_AGENT_ID, 50)
    .filter((s) => {
      const age = Date.now() - new Date(s.created_at).getTime();
      return age < 7 * 24 * 60 * 60 * 1000;
    });

  const decisions = getRecentDecisions(ADA_AGENT_ID, 7);

  const recentLearnings = getLearnings(ADA_AGENT_ID, undefined, 50)
    .filter((l) => {
      const age = Date.now() - new Date(l.created_at).getTime();
      return age < 7 * 24 * 60 * 60 * 1000;
    });

  // Count feedback sentiment
  let positiveFeedback = 0;
  let negativeFeedback = 0;
  for (const session of sessions) {
    const feedback = getFeedbackForSession(session.id);
    for (const f of feedback) {
      if (f.sentiment === 'positive') positiveFeedback++;
      else if (f.sentiment === 'negative') negativeFeedback++;
    }
  }

  // Transcript ingestion stats
  const ingestionStats = getIngestionStats();

  // Decision outcomes
  const evaluatedDecisions = decisions.filter((d) => d.outcome);
  const goodDecisions = evaluatedDecisions.filter((d) => d.outcome === 'good').length;
  const badDecisions = evaluatedDecisions.filter((d) => d.outcome === 'bad').length;

  const dataSummary = [
    `## Week Summary`,
    `Sessions: ${sessions.length}`,
    `Decisions made: ${decisions.length} (${evaluatedDecisions.length} evaluated: ${goodDecisions} good, ${badDecisions} bad)`,
    `New learnings: ${recentLearnings.length}`,
    `Feedback: ${positiveFeedback} positive, ${negativeFeedback} negative`,
    `Transcripts ingested: ${ingestionStats.count} meetings, ${ingestionStats.insights} insights extracted`,
    '',
    '## Recent Decisions',
    ...decisions.slice(0, 10).map((d) =>
      `- ${d.decision_type} "${d.target}" for ${d.account_code}${d.outcome ? ` → ${d.outcome}` : ' (pending)'}`,
    ),
    '',
    '## New Learnings (top 10)',
    ...recentLearnings.slice(0, 10).map((l) =>
      `- [${l.category}] (conf: ${l.confidence}) ${l.content.slice(0, 150)}`,
    ),
    '',
    '## Sessions',
    ...sessions.slice(0, 10).map((s) =>
      `- ${s.channel_id} (${s.total_turns} turns, ${s.status})${s.summary ? `: ${s.summary.slice(0, 100)}` : ''}`,
    ),
  ].join('\n');

  const response = await getClient().messages.create({
    model: REFLECTION_MODEL,
    max_tokens: 2048,
    system: [
      'You are Ada, a senior media buyer agent at Ads on Tap.',
      'Review your week and write a brief weekly report for Daniel.',
      '',
      'Cover:',
      '1. What you learned this week (top 3 new insights)',
      '2. Decision outcomes (what went right/wrong)',
      '3. Gaps in your knowledge (what you wish you knew)',
      '4. Recommendations (what Daniel should look at)',
      '',
      'Keep it under 500 words. Be direct, no fluff.',
      'Use bullet points for scannability.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: dataSummary,
      },
    ],
  });

  const reportText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  // DM Daniel
  await postMessage({
    channel: env.SLACK_OWNER_USER_ID,
    text: `:brain: *Ada's Weekly Report*\n\n${reportText}`,
  });

  // Store as a learning
  addLearning({
    agent_id: ADA_AGENT_ID,
    category: 'weekly_reflection',
    content: reportText.slice(0, 2000),
    confidence: 0.5,
  });

  logger.info(
    { sessions: sessions.length, decisions: decisions.length, learnings: recentLearnings.length },
    'Ada weekly reflection generated and sent',
  );
}

function getIngestionStats(): { count: number; insights: number } {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(insights_extracted), 0) as insights
    FROM transcript_ingestion_log
    WHERE created_at > datetime('now', '-7 days')
  `).get() as { count: number; insights: number } | undefined;
  return row ?? { count: 0, insights: 0 };
}
