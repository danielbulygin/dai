import { nanoid } from "nanoid";
import { logger } from "../../utils/logger.js";
import { recall as memoryRecall } from "../../memory/search.js";
import { addLearning, searchLearnings } from "../../memory/learnings.js";

export async function recall(params: {
  query: string;
  agent_id?: string;
  client_code?: string;
}): Promise<{
  results: Array<{ type: string; content: string; relevance: number }>;
}> {
  try {
    const raw = memoryRecall(params.query, params.agent_id, params.client_code);

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
}): Promise<{ id: string; saved: boolean }> {
  try {
    const learning = addLearning({
      agent_id: params.agent_id,
      category: params.category,
      content: params.content,
      confidence: 0.5,
      client_code: params.client_code ?? null,
    });

    logger.debug(
      { id: learning.id, category: params.category },
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
    const raw = searchLearnings(params.topic, params.client_code);

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
