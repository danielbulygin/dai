/**
 * Loop 5 — the creative-coverage line (one sentence for the agency brief).
 *
 * The question it answers before any creative claim is made: "of the ads that
 * actually spent money in the window, how many has Ada actually looked at?"
 * A creative verdict drawn from 16 of 238 spending ads is not a verdict about
 * the account, it is a verdict about the 16. This line makes that gap visible
 * instead of letting the brief imply full sight.
 *
 * Source: the `creative_analysis_coverage(p_client_code, p_days)` RPC on the
 * agency warehouse (built in the bmad repo, migration 20260619170000). It
 * returns a single row; we use two of its columns — `total_spending_ads` (ads
 * with spend > 0 in the window) and `ads_analyzed` (of those, the ones with
 * completed visual analysis).
 *
 * ⚠️ KNOWN UNDER-REPORT — read before trusting the number. The bmad handover
 * (docs/ada-web-console-handover-2026-06-19.md §4 Session B) marks this RPC
 * "superseded/wrong": it resolves "analyzed" purely through the near-empty
 * global `creative_analysis` table (~130 rows), so it MISSES the two other
 * places analysis actually lives — `creatives.ai_analyzed_at` and
 * `media_library_assets.visual_status='complete'` (linked by the asset-id
 * token in the ad NAME, e.g. "BFMx3949", which alone connects ~55 of BFM's
 * spending ads). The honest union is computed in TS by the dashboard route
 * `pma/dashboard/src/app/api/clients/[id]/creative-coverage/route.ts`.
 * Consequence: this line reads LOW (BFM ~7%, PL ~6%), so `amber` is
 * effectively always true today. That is directionally honest — coverage IS
 * poor — but the true ratio is higher than what this reports. Repointing at
 * the union (or at that route) is the upgrade path; the shape below does not
 * change when it happens.
 *
 * House rules applied: the absolute numbers lead and never appear as a bare
 * percentage, and the line states what the number MEANS ("understood",
 * "not yet analyzed"). Absence is honest: no spending ads → no line at all,
 * never a fabricated "0% covered".
 *
 * Fail-open by contract: coverage is context, not the brief. Any RPC trouble
 * returns null and is logged — a coverage hiccup must never break a brief.
 *
 * The formatting half (`buildCoverageRead`) is pure and carries all the
 * decisions; `fetchCreativeCoverage` is a thin I/O wrapper around it.
 */

import { getSupabase } from '../integrations/supabase.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types + knobs
// ---------------------------------------------------------------------------

export interface CoverageRead {
  /** Spending ads with completed visual analysis. */
  analyzed: number;
  /** Ads with spend > 0 in the window (the denominator that matters). */
  spendingAds: number;
  /** analyzed / spendingAds, 0..1, rounded to 4dp. 0 when nothing spent. */
  ratio: number;
  /** The brief-ready sentence. null when there is nothing honest to say. */
  line: string | null;
  /** Coverage is thin enough to caveat any creative claim (< 95%). */
  amber: boolean;
}

/**
 * The brief speaks about yesterday and the days around it, so the coverage
 * question is "the ads spending NOW", not the RPC's own 30-day default.
 * Always passed explicitly so the window in the line matches what was asked.
 */
export const DEFAULT_COVERAGE_DAYS = 7;

/** Below this share of spending ads, creative claims need a caveat. */
export const AMBER_BELOW = 0.95;

/** Matches the dashboard route's clamp; the RPC takes a plain INT. */
const MIN_DAYS = 1;
const MAX_DAYS = 365;

/** The two columns of the RPC row this module reads. */
interface CoverageRpcRow {
  total_spending_ads: number | string | null;
  ads_analyzed: number | string | null;
}

// ---------------------------------------------------------------------------
// The pure half — every formatting and threshold decision lives here
// ---------------------------------------------------------------------------

/** Non-negative whole number, NaN/garbage/negatives collapse to 0. */
function count(value: unknown): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Turn the two raw counts into the brief-ready read.
 *
 * The zero case is deliberate: an account with no spending ads in the window
 * has no coverage gap, so it gets no line AND no amber flag. Flagging amber
 * there would put a warning on a client who simply wasn't spending.
 */
export function buildCoverageRead(
  analyzed: number,
  spendingAds: number,
  days: number = DEFAULT_COVERAGE_DAYS,
): CoverageRead {
  const ads = count(spendingAds);
  // Clamped defensively: "analyzed" is a FILTER over the same set upstream, so
  // it can never exceed the total — but a negative "not yet analyzed" in a
  // brief would be worse than a silently capped number.
  const done = Math.min(ads, count(analyzed));

  if (ads === 0) {
    return { analyzed: 0, spendingAds: 0, ratio: 0, line: null, amber: false };
  }

  const ratio = Math.round((done / ads) * 10_000) / 10_000;
  const window = `last ${days} ${Math.abs(days) === 1 ? 'day' : 'days'}`;

  const line =
    done === ads
      ? `Creative coverage: all ${ads} spending ads understood (${window})`
      : `Creative coverage: ${done} of ${ads} spending ads understood — ${ads - done} not yet analyzed`;

  // Derived from the rounded ratio so the two exported fields can never
  // disagree with each other.
  return { analyzed: done, spendingAds: ads, ratio, line, amber: ratio < AMBER_BELOW };
}

// ---------------------------------------------------------------------------
// The I/O half — thin on purpose
// ---------------------------------------------------------------------------

/**
 * Read one client's creative coverage off the warehouse.
 *
 * Returns null on any RPC trouble (fail-open — the caller drops the line and
 * the brief ships). An unknown client code is NOT trouble: the RPC answers
 * with a zero row, which becomes the honest "no line" read.
 *
 * @param clientCode  clients.code, e.g. 'BFM' or 'PL' (upper-cased by the RPC)
 * @param days        lookback window, default 7, clamped to 1..365
 */
export async function fetchCreativeCoverage(
  clientCode: string,
  days: number = DEFAULT_COVERAGE_DAYS,
): Promise<CoverageRead | null> {
  const window = Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.trunc(days) || DEFAULT_COVERAGE_DAYS));

  try {
    const { data, error } = await getSupabase().rpc('creative_analysis_coverage', {
      p_client_code: clientCode,
      p_days: window,
    });

    if (error) {
      logger.warn(
        {
          clientCode,
          days: window,
          code: error.code,
          message: error.message,
          details: error.details,
        },
        'creative coverage RPC failed — brief continues without the coverage line',
      );
      return null;
    }

    // RETURNS TABLE → PostgREST hands back an array holding the single row.
    const rows = (Array.isArray(data) ? data : [data]) as (CoverageRpcRow | null)[];
    const row = rows[0];
    if (!row) return buildCoverageRead(0, 0, window);

    return buildCoverageRead(count(row.ads_analyzed), count(row.total_spending_ads), window);
  } catch (err) {
    logger.warn(
      { clientCode, days: window, err },
      'creative coverage lookup threw — brief continues without the coverage line',
    );
    return null;
  }
}
