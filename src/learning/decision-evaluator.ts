import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { getPendingDecisions, recordOutcome, type Decision } from '../memory/decisions.js';
import { addLearning } from '../memory/learnings.js';
import { getClientPerformance } from '../agents/tools/supabase-tools.js';

const EVAL_MODEL = 'claude-sonnet-4-20250514';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

export async function evaluatePendingDecisions(): Promise<number> {
  const pending = getPendingDecisions(3);

  if (pending.length === 0) {
    logger.debug('No pending decisions to evaluate');
    return 0;
  }

  logger.info({ count: pending.length }, 'Evaluating pending decisions');
  let evaluated = 0;

  for (const decision of pending) {
    try {
      await evaluateDecision(decision);
      evaluated++;
    } catch (err) {
      logger.error(
        { error: err, decisionId: decision.id },
        'Failed to evaluate decision, continuing',
      );
    }
  }

  logger.info({ evaluated, total: pending.length }, 'Decision evaluation complete');
  return evaluated;
}

async function evaluateDecision(decision: Decision): Promise<void> {
  // Fetch current performance for the account
  const currentDataRaw = await getClientPerformance({
    clientCode: decision.account_code,
    days: 7,
  });

  const currentData = JSON.parse(currentDataRaw);
  if (currentData.error) {
    logger.warn(
      { decisionId: decision.id, error: currentData.error },
      'Could not fetch current performance for decision evaluation',
    );
    return;
  }

  const snapshotMetrics = decision.metrics_snapshot
    ? JSON.parse(decision.metrics_snapshot)
    : null;

  const response = await getClient().messages.create({
    model: EVAL_MODEL,
    max_tokens: 1024,
    system: [
      'You are evaluating a media buying decision made a few days ago.',
      'Compare the metrics at the time of the decision with current metrics.',
      'Assess whether the decision was correct.',
      '',
      'Respond with valid JSON only:',
      '{',
      '  "outcome": "good" | "neutral" | "bad",',
      '  "summary": "Brief explanation of why (1-2 sentences)",',
      '  "key_metric_changes": { "metric_name": "before → after" }',
      '}',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: [
          `Decision: ${decision.decision_type} on "${decision.target}" for ${decision.account_code}`,
          `Rationale: ${decision.rationale}`,
          `Made: ${decision.created_at}`,
          '',
          `Metrics at time of decision: ${snapshotMetrics ? JSON.stringify(snapshotMetrics) : 'Not recorded'}`,
          '',
          `Current performance (last 7 days): ${JSON.stringify(currentData)}`,
        ].join('\n'),
      },
    ],
  });

  const responseText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  let evaluation: { outcome: string; summary: string; key_metric_changes?: Record<string, string> };
  try {
    evaluation = JSON.parse(responseText);
  } catch {
    logger.warn({ decisionId: decision.id, response: responseText }, 'Failed to parse evaluation response');
    return;
  }

  // Record the outcome
  recordOutcome(decision.id, evaluation.outcome, {
    summary: evaluation.summary,
    key_metric_changes: evaluation.key_metric_changes ?? {},
    current_data_sample: Array.isArray(currentData) ? currentData.slice(0, 3) : currentData,
  });

  // Create a learning from this outcome
  const learningContent = [
    `${decision.decision_type.toUpperCase()} decision on "${decision.target}" for ${decision.account_code}: ${evaluation.outcome}.`,
    evaluation.summary,
    decision.rationale ? `Original rationale: ${decision.rationale}` : '',
  ].filter(Boolean).join(' ');

  const confidence = evaluation.outcome === 'good' ? 0.7
    : evaluation.outcome === 'bad' ? 0.6
    : 0.4;

  addLearning({
    agent_id: decision.agent_id,
    category: 'decision_outcome',
    content: learningContent,
    confidence,
    source_session_id: decision.session_id,
  });

  logger.info(
    { decisionId: decision.id, outcome: evaluation.outcome, target: decision.target },
    'Decision evaluated and learning created',
  );
}
