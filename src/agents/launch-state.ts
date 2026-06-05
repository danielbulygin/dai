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

/**
 * Render a system-prompt section with the LIVE DB state of the given batches.
 * Injected into launch threads so the model always has ground truth — even when
 * session context was truncated (the 2026-06-05 fabrication happened on a turn
 * with ~7.6K chars of history and no real state to consult).
 */
export function buildLaunchStateSection(states: BatchState[]): string {
  const lines = states.map((s) => {
    const extra = [
      s.adset_id ? `adset \`${s.adset_id}\`` : null,
      s.ad_ids && s.ad_ids.length > 0 ? `${s.ad_ids.length} ads` : null,
      s.launched_at ? `launched_at ${s.launched_at}` : null,
    ].filter(Boolean).join(", ");
    return `- \`${s.batch_id}\` (${s.client_code}, ${s.mode}): **${s.status}**${extra ? ` — ${extra}` : ""}`;
  });
  return [
    "## Launch batches in this thread — LIVE DATABASE STATE (authoritative)",
    ...lines,
    "",
    "This is the ground truth as of right now, read directly from `launch_batches`.",
    "If a batch shows **pending**, it has NOT been launched — no matter what the",
    "conversation above suggests. Never report a launch as done unless the batch is",
    "**launched** here or you have a `launch_ads` tool result from THIS turn.",
  ].join("\n");
}

/**
 * Batches stuck in `pending` — previewed but never launched. The backstop for
 * approved-then-dropped launches (2026-06-05: two SS batches sat pending while
 * the conversation said "launched"). Window-bounded: ignores ancient previews
 * (cancelled previews also stay `pending` by design — see launch-actions.ts).
 */
export async function getStalePendingBatches(opts?: {
  olderThanHours?: number;
  withinDays?: number;
}): Promise<BatchState[]> {
  const olderThanHours = opts?.olderThanHours ?? 24;
  const withinDays = opts?.withinDays ?? 7;
  try {
    const now = Date.now();
    const newerThan = new Date(now - withinDays * 24 * 3600_000).toISOString();
    const olderThan = new Date(now - olderThanHours * 3600_000).toISOString();
    const { data, error } = await getSupabase()
      .from("launch_batches")
      .select("batch_id,client_code,status,mode,adset_id,ad_ids,created_at,launched_at")
      .eq("status", "pending")
      // AOT = the half-hourly health check; it creates a never-launched preview
      // every 30 min by design (~300 rows/week of pure noise). Caught in the
      // 2026-06-05 dry-run QC of this sweep.
      .neq("client_code", "AOT")
      .gte("created_at", newerThan)
      .lte("created_at", olderThan)
      .order("created_at", { ascending: true });
    if (error) {
      logger.warn({ error }, "launch-state: stale-pending query errored");
      return [];
    }
    return (data ?? []) as BatchState[];
  } catch (err) {
    logger.warn({ err }, "launch-state: stale-pending query failed");
    return [];
  }
}

/**
 * Render the stale-pending digest section. Pure — used by the twice-daily
 * Ready-to-Upload check; lives here (not in monitoring/) so tests can import
 * it without dragging in the env-validated Slack stack.
 */
export function formatStaleBatchSection(stale: BatchState[], nowMs: number): string | null {
  if (stale.length === 0) return null;
  const MAX_SHOWN = 10;
  const lines = stale.slice(0, MAX_SHOWN).map((b) => {
    const ageH = Math.round((nowMs - new Date(b.created_at).getTime()) / 3600_000);
    return `  • \`${b.batch_id.slice(0, 8)}\` (${b.client_code}, ${b.mode}) — previewed ${ageH}h ago, never launched`;
  });
  if (stale.length > MAX_SHOWN) {
    lines.push(`  • _…and ${stale.length - MAX_SHOWN} more_`);
  }
  return (
    `:hourglass_flowing_sand: *${stale.length} launch preview${stale.length === 1 ? "" : "s"} stuck in \`pending\` >24h* — ` +
    `previewed but never executed. Launch, or ignore if deliberately cancelled:\n${lines.join("\n")}`
  );
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
