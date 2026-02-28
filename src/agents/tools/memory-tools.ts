import { nanoid } from "nanoid";
import { logger } from "../../utils/logger.js";
import { recall as memoryRecall } from "../../memory/search.js";
import { addLearning, searchLearnings, findDuplicateLearning } from "../../memory/learnings.js";

/**
 * Normalize client_code aliases to canonical Supabase codes (snake_case).
 * Handles common abbreviations, display names, and alternate forms.
 */
const CLIENT_CODE_ALIASES: ReadonlyMap<string, string> = new Map([
  // Press London
  ["pl", "press_london"],
  ["press", "press_london"],
  ["presslondon", "press_london"],
  ["press-london", "press_london"],
  // Ninepine
  ["np", "ninepine"],
  ["nine_pine", "ninepine"],
  // Brain.fm
  ["brainfm", "brainfm"],
  ["brain.fm", "brainfm"],
  ["brain_fm", "brainfm"],
  ["bfm", "brainfm"],
  // Vi Lifestyle
  ["vi", "vi_lifestyle"],
  ["vi-lifestyle", "vi_lifestyle"],
  ["vilifestyle", "vi_lifestyle"],
  // JV Academy
  ["jva", "jva"],
  ["jv-academy", "jva"],
  ["jv_academy", "jva"],
  // Nothing's Something
  ["noso", "noso"],
  ["nothings-something", "noso"],
  ["nothings_something", "noso"],
  // Others with common aliases
  ["getgoing", "getgoing"],
  ["get-going", "getgoing"],
  ["get_going", "getgoing"],
  ["teeth_lovers", "teethlovers"],
  ["teeth-lovers", "teethlovers"],
]);

function normalizeClientCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const lower = code.toLowerCase().trim();
  return CLIENT_CODE_ALIASES.get(lower) ?? lower;
}

export async function recall(params: {
  query: string;
  agent_id?: string;
  client_code?: string;
}): Promise<{
  results: Array<{ type: string; content: string; relevance: number }>;
}> {
  try {
    const clientCode = normalizeClientCode(params.client_code);
    const raw = await memoryRecall(params.query, params.agent_id, clientCode);

    const results = raw.map((r) => ({
      type: r.source,
      content: r.content,
      // FTS rank is negative (lower = better), normalize to 0-1 relevance
      relevance: Math.max(0, Math.min(1, 1 + r.rank / 10)),
    }));

    logger.debug(
      { query: params.query, count: results.length },
      "Recall search completed",
    );

    return { results };
  } catch (error) {
    logger.error({ error, query: params.query }, "Recall search failed");
    return { results: [] };
  }
}

export async function remember(params: {
  content: string;
  category: string;
  agent_id: string;
  client_code?: string;
}): Promise<{ id: string; saved: boolean; deduplicated?: boolean }> {
  try {
    const clientCode = normalizeClientCode(params.client_code) ?? null;

    // Check for duplicate/near-duplicate learnings before inserting
    const existing = await findDuplicateLearning(
      params.agent_id,
      params.category,
      params.content,
      clientCode,
    );

    if (existing) {
      logger.debug(
        { existingId: existing.id, category: params.category },
        "Duplicate learning found, skipping insert",
      );
      return { id: existing.id, saved: true, deduplicated: true };
    }

    const learning = await addLearning({
      agent_id: params.agent_id,
      category: params.category,
      content: params.content,
      confidence: 0.5,
      client_code: clientCode,
    });

    logger.debug(
      { id: learning.id, category: params.category, clientCode },
      "Saved new memory",
    );

    return { id: learning.id, saved: true };
  } catch (error) {
    logger.error({ error, category: params.category }, "Failed to save memory");
    return { id: nanoid(), saved: false };
  }
}

export async function searchMemories(params: {
  topic: string;
  limit?: number;
  client_code?: string;
}): Promise<{
  memories: Array<{ content: string; category: string; confidence: number }>;
}> {
  try {
    const limit = params.limit ?? 10;
    const clientCode = normalizeClientCode(params.client_code);
    const raw = await searchLearnings(params.topic, clientCode);

    const memories = raw.slice(0, limit).map((l) => ({
      content: l.content,
      category: l.category,
      confidence: l.confidence,
    }));

    logger.debug(
      { topic: params.topic, count: memories.length },
      "Memory search completed",
    );

    return { memories };
  } catch (error) {
    logger.error({ error, topic: params.topic }, "Memory search failed");
    return { memories: [] };
  }
}
