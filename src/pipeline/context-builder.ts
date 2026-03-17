/**
 * Builds extraction context for a meeting based on its classification.
 *
 * Loads client context files, recent learnings, and previous call extractions
 * so the extractor can distinguish "update to existing initiative" from "new topic."
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { searchLearnings } from '../memory/learnings.js';
import { getDaiSupabase } from '../integrations/dai-supabase.js';
import type { MeetingClassification } from './classifier.js';

export interface ExtractionContext {
  clientContext: string | null;
  recentLearnings: string | null;
  previousExtraction: string | null;
}

/**
 * Build context for the extractor based on classification.
 * All lookups are best-effort — failures return null for that section.
 */
export async function buildExtractionContext(
  classification: MeetingClassification,
): Promise<ExtractionContext> {
  const [clientContext, recentLearnings, previousExtraction] = await Promise.all([
    loadClientContext(classification.client_code),
    loadRecentLearnings(classification.client_code),
    loadPreviousExtraction(classification.client_code),
  ]);

  return { clientContext, recentLearnings, previousExtraction };
}

async function loadClientContext(clientCode: string | null): Promise<string | null> {
  if (!clientCode) return null;

  const filePath = join(process.cwd(), 'agents', 'ada', 'clients', `${clientCode}.md`);
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    logger.debug({ clientCode }, 'No client context file found');
    return null;
  }
}

async function loadRecentLearnings(clientCode: string | null): Promise<string | null> {
  if (!clientCode) return null;

  try {
    const learnings = await searchLearnings(clientCode, clientCode);
    if (!learnings || learnings.length === 0) return null;

    const top = learnings.slice(0, 10);
    return top
      .map((l: { content: string; category: string }) => `- [${l.category}] ${l.content}`)
      .join('\n');
  } catch {
    logger.debug({ clientCode }, 'Failed to load recent learnings for context');
    return null;
  }
}

async function loadPreviousExtraction(clientCode: string | null): Promise<string | null> {
  if (!clientCode) return null;

  try {
    const supabase = getDaiSupabase();
    const { data } = await supabase
      .from('call_extractions')
      .select('extraction, created_at')
      .eq('client_code', clientCode)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data?.extraction) return null;

    return JSON.stringify(data.extraction, null, 2);
  } catch {
    logger.debug({ clientCode }, 'Failed to load previous extraction');
    return null;
  }
}
