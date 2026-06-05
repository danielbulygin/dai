/**
 * Launch-state helpers — ground truth for Ada's launch pipeline.
 *
 * Shared by:
 *  - slack/launch-approval.ts (deterministic text-approval routing)
 *  - agents/runner.ts (DB-truth injection into launch-thread prompts)
 *  - agents/hooks/launch-claim-guard.ts (claim verification)
 *
 * Part of the 2026-06-05 fabricated-launch hardening: anything that needs to
 * know "what launches are pending/launched in this thread" reads the bmad
 * `launch_batches` table through here instead of trusting conversation text.
 */
import { getSupabase } from "../integrations/supabase.js";
import { logger } from "../utils/logger.js";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export interface BatchState {
  batch_id: string;
  client_code: string;
  status: string;
  mode: string;
  adset_id: string | null;
  ad_ids: string[] | null;
  created_at: string;
  launched_at: string | null;
}

/** Extract every batch-looking UUID mentioned across the given texts (deduped, order-preserving). */
export function extractBatchIds(texts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(UUID_RE)) {
      const id = m[0].toLowerCase();
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}

/** Fetch live launch_batches state for the given batch ids. Returns [] on any error. */
export async function getBatchStates(batchIds: string[]): Promise<BatchState[]> {
  if (batchIds.length === 0) return [];
  try {
    const { data, error } = await getSupabase()
      .from("launch_batches")
      .select("batch_id,client_code,status,mode,adset_id,ad_ids,created_at,launched_at")
      .in("batch_id", batchIds);
    if (error) {
      logger.warn({ error }, "launch-state: launch_batches query errored");
      return [];
    }
    return (data ?? []) as BatchState[];
  } catch (err) {
    logger.warn({ err }, "launch-state: launch_batches query failed");
    return [];
  }
}

/** Convenience: batches from the texts that are still pending, in mention order. */
export async function getPendingBatchesFromTexts(texts: string[]): Promise<BatchState[]> {
  const ids = extractBatchIds(texts);
  if (ids.length === 0) return [];
  const states = await getBatchStates(ids);
  const byId = new Map(states.map((s) => [s.batch_id.toLowerCase(), s]));
  return ids
    .map((id) => byId.get(id))
    .filter((s): s is BatchState => !!s && s.status === "pending");
}
