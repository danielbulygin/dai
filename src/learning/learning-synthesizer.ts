import Anthropic from '@anthropic-ai/sdk';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import {
  getLearnings,
  deleteLearning,
  updateLearningConfidence,
  addLearning,
  type Learning,
} from '../memory/learnings.js';
import { aggregateTeamLearnings } from './team-learnings.js';

const SYNTHESIS_MODEL = 'claude-opus-4-6';
const ADA_AGENT_ID = 'ada';
const BATCH_SIZE = 50;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

interface SynthesisResult {
  merge_pairs: Array<{ keep_id: string; remove_id: string; merged_content: string }>;
  deprecate_ids: string[];
  confidence_updates: Array<{ id: string; new_confidence: number; reason: string }>;
}

export async function synthesizeLearnings(): Promise<void> {
  logger.info('Starting learning synthesis for Ada');

  // Fetch all Ada learnings
  const allLearnings = getLearnings(ADA_AGENT_ID, undefined, 1000);

  if (allLearnings.length < 10) {
    logger.debug({ count: allLearnings.length }, 'Too few learnings to synthesize');
    // Still run team aggregation
    await runTeamAggregation();
    return;
  }

  // Group by category
  const categories = groupByCategory(allLearnings);

  let totalMerged = 0;
  let totalDeprecated = 0;
  let totalUpdated = 0;

  for (const [category, learnings] of categories) {
    if (learnings.length < 3) continue;

    try {
      // Process in batches to keep prompt manageable
      for (let i = 0; i < learnings.length; i += BATCH_SIZE) {
        const batch = learnings.slice(i, i + BATCH_SIZE);
        const result = await synthesizeBatch(category, batch);

        // Execute merges
        for (const merge of result.merge_pairs) {
          try {
            const kept = allLearnings.find((l) => l.id === merge.keep_id);
            if (!kept) continue;

            // Delete the duplicate and update the kept one
            deleteLearning(merge.remove_id);
            // Update content of kept learning by deleting and re-adding with merged content
            deleteLearning(merge.keep_id);
            addLearning({
              agent_id: ADA_AGENT_ID,
              category,
              content: merge.merged_content,
              confidence: kept.confidence,
              source_session_id: kept.source_session_id,
            });
            totalMerged++;
          } catch (err) {
            logger.warn({ error: err, merge }, 'Failed to execute merge');
          }
        }

        // Execute deprecations
        for (const id of result.deprecate_ids) {
          try {
            deleteLearning(id);
            totalDeprecated++;
          } catch (err) {
            logger.warn({ error: err, learningId: id }, 'Failed to deprecate learning');
          }
        }

        // Execute confidence updates
        for (const update of result.confidence_updates) {
          try {
            updateLearningConfidence(update.id, update.new_confidence);
            totalUpdated++;
          } catch (err) {
            logger.warn({ error: err, update }, 'Failed to update confidence');
          }
        }
      }
    } catch (err) {
      logger.error(
        { error: err, category },
        'Failed to synthesize category, continuing',
      );
    }
  }

  logger.info(
    { totalMerged, totalDeprecated, totalUpdated, originalCount: allLearnings.length },
    'Learning synthesis complete',
  );

  // Run team learning aggregation
  await runTeamAggregation();
}

async function synthesizeBatch(
  category: string,
  learnings: Learning[],
): Promise<SynthesisResult> {
  const learningsList = learnings
    .map((l) => `[${l.id}] (conf: ${l.confidence}, applied: ${l.applied_count}) ${l.content}`)
    .join('\n');

  const response = await getClient().messages.create({
    model: SYNTHESIS_MODEL,
    max_tokens: 4096,
    system: [
      'Review these media buyer learnings and identify opportunities to clean up.',
      '',
      'For each group of learnings:',
      '1. Merge duplicates — keep the one with higher confidence/applied_count, combine their content',
      '2. Deprecate learnings that are too vague to be actionable (e.g., "this approach worked well")',
      '3. Suggest confidence adjustments: boost frequently-applied learnings, reduce stale ones',
      '',
      'Respond with valid JSON only:',
      '{',
      '  "merge_pairs": [{ "keep_id": "...", "remove_id": "...", "merged_content": "improved text" }],',
      '  "deprecate_ids": ["ids of vague/useless learnings to remove"],',
      '  "confidence_updates": [{ "id": "...", "new_confidence": 0.8, "reason": "..." }]',
      '}',
      '',
      'Be conservative — only merge clear duplicates, only deprecate truly vague learnings.',
      'If nothing needs changing, return empty arrays.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: `Category: ${category}\n\nLearnings:\n${learningsList}`,
      },
    ],
  });

  const responseText = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  try {
    return JSON.parse(responseText) as SynthesisResult;
  } catch {
    logger.warn({ category }, 'Failed to parse synthesis response');
    return { merge_pairs: [], deprecate_ids: [], confidence_updates: [] };
  }
}

async function runTeamAggregation(): Promise<void> {
  try {
    await aggregateTeamLearnings();
  } catch (err) {
    logger.error({ error: err }, 'Team learning aggregation failed');
  }
}

function groupByCategory(learnings: Learning[]): Map<string, Learning[]> {
  const groups = new Map<string, Learning[]>();
  for (const l of learnings) {
    const existing = groups.get(l.category);
    if (existing) {
      existing.push(l);
    } else {
      groups.set(l.category, [l]);
    }
  }
  return groups;
}
