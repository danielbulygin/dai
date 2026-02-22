import { logger } from "../utils/logger.js";
import {
  addLearning,
  getLearnings,
  getTopLearnings,
  type Learning,
} from "../memory/learnings.js";
import { loadAgentRegistry } from "../agents/registry.js";

const TEAM_AGENT_ID = "_team";

/**
 * Aggregate learnings across all agents and identify shared patterns.
 * Stores team-wide learnings with agent_id='_team'.
 */
export async function aggregateTeamLearnings(): Promise<void> {
  let registry: Map<string, unknown>;

  try {
    registry = loadAgentRegistry();
  } catch (error) {
    logger.error({ error }, "Failed to load agent registry for team learning aggregation");
    return;
  }

  const agentIds = Array.from(registry.keys());

  // Collect top learnings from every agent
  const allLearnings: Learning[] = [];
  for (const agentId of agentIds) {
    try {
      const top = getTopLearnings(agentId, 20);
      allLearnings.push(...top);
    } catch (error) {
      logger.warn(
        { error, agentId },
        "Failed to get learnings for agent, skipping",
      );
    }
  }

  if (allLearnings.length === 0) {
    logger.debug("No agent learnings found for team aggregation");
    return;
  }

  // Find patterns: group by category and look for similar content
  const categoryGroups = groupByCategory(allLearnings);
  let created = 0;

  for (const [category, learnings] of categoryGroups) {
    // Only create a team learning if multiple agents share learnings
    // in the same category
    const uniqueAgents = new Set(learnings.map((l) => l.agent_id));
    if (uniqueAgents.size < 2) {
      continue;
    }

    // Find content patterns using simple keyword overlap
    const patterns = findContentPatterns(learnings);

    for (const pattern of patterns) {
      // Check if we already have a similar team learning
      const existing = getTeamLearnings(100);
      const isDuplicate = existing.some(
        (e) => e.category === category && contentOverlap(e.content, pattern) > 0.7,
      );

      if (isDuplicate) {
        continue;
      }

      const sourceAgents = [...uniqueAgents].join(", ");

      addLearning({
        agent_id: TEAM_AGENT_ID,
        category,
        content: `[Team pattern from: ${sourceAgents}] ${pattern}`,
        confidence: 0.6,
      });

      created++;
    }
  }

  if (created > 0) {
    logger.info(
      { created, totalLearnings: allLearnings.length },
      "Team learning aggregation complete",
    );
  } else {
    logger.debug("No new team patterns found during aggregation");
  }
}

/**
 * Retrieve team-wide learnings (agent_id='_team').
 */
export function getTeamLearnings(limit = 20): Learning[] {
  try {
    return getLearnings(TEAM_AGENT_ID, undefined, limit);
  } catch (error) {
    logger.error({ error }, "Failed to get team learnings");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function groupByCategory(learnings: Learning[]): Map<string, Learning[]> {
  const groups = new Map<string, Learning[]>();

  for (const learning of learnings) {
    const existing = groups.get(learning.category);
    if (existing) {
      existing.push(learning);
    } else {
      groups.set(learning.category, [learning]);
    }
  }

  return groups;
}

/**
 * Simple pattern detection: extract learnings that share significant
 * keyword overlap, then return a representative content string for each
 * cluster.
 */
function findContentPatterns(learnings: Learning[]): string[] {
  if (learnings.length < 2) {
    return [];
  }

  const patterns: string[] = [];
  const used = new Set<number>();

  for (let i = 0; i < learnings.length; i++) {
    if (used.has(i)) continue;

    const cluster: Learning[] = [learnings[i]!];
    used.add(i);

    for (let j = i + 1; j < learnings.length; j++) {
      if (used.has(j)) continue;

      const overlap = contentOverlap(
        learnings[i]!.content,
        learnings[j]!.content,
      );

      if (overlap > 0.3) {
        cluster.push(learnings[j]!);
        used.add(j);
      }
    }

    // Only count as a pattern if multiple learnings are similar
    if (cluster.length >= 2) {
      // Use the highest-confidence learning as representative
      const best = cluster.reduce((a, b) =>
        a.confidence > b.confidence ? a : b,
      );
      patterns.push(best.content);
    }
  }

  return patterns;
}

/**
 * Compute a simple Jaccard-like overlap coefficient between two strings
 * based on word tokens. Returns a value between 0 and 1.
 */
function contentOverlap(a: string, b: string): number {
  const wordsA = new Set(tokenize(a));
  const wordsB = new Set(tokenize(b));

  if (wordsA.size === 0 || wordsB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) {
      intersection++;
    }
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? intersection / union : 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}
