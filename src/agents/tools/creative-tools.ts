import { getDaiSupabase } from "../../integrations/dai-supabase.js";
import { getSupabase } from "../../integrations/supabase.js";
import { logger } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// get_creative_audit — returns latest audit snapshot from DAI Supabase
// ---------------------------------------------------------------------------

export async function getCreativeAudit(params: {
  clientCode: string;
}): Promise<string> {
  try {
    logger.debug({ clientCode: params.clientCode }, "Querying latest creative audit");
    const dai = getDaiSupabase();

    const { data, error } = await dai
      .from("creative_audits")
      .select("*")
      .eq("client_code", params.clientCode)
      .order("audit_date", { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return JSON.stringify({ error: `No creative audit found for client '${params.clientCode}'. Run 'pnpm creative-audit -- --client ${params.clientCode}' first.` });
      }
      logger.error({ error }, "Failed to get creative audit");
      return JSON.stringify({ error: error.message });
    }

    logger.debug({ clientCode: params.clientCode, auditDate: data.audit_date }, "Got creative audit");
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getCreativeAudit failed");
    return JSON.stringify({ error: msg });
  }
}

// ---------------------------------------------------------------------------
// get_creative_diversity_score — real-time diversity analysis
// ---------------------------------------------------------------------------

const ALL_FORMATS = Array.from({ length: 17 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`);
const ALL_ANGLES = Array.from({ length: 15 }, (_, i) => `A${String(i + 1).padStart(2, "0")}`);

function shannonEntropy(distribution: Map<string, number>, total: number): number {
  if (total === 0) return 0;
  let entropy = 0;
  for (const count of distribution.values()) {
    if (count <= 0) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function maxEntropy(categories: number): number {
  return categories > 0 ? Math.log2(categories) : 0;
}

export async function getCreativeDiversityScore(params: {
  clientCode: string;
  days?: number;
}): Promise<string> {
  try {
    const days = params.days ?? 7;
    logger.debug({ clientCode: params.clientCode, days }, "Calculating creative diversity score");

    const dai = getDaiSupabase();
    const bmad = getSupabase();

    // Step 1: Get latest audit for format/angle distribution
    const { data: audit, error: auditErr } = await dai
      .from("creative_audits")
      .select("format_distribution, angle_distribution, gap_matrix, total_spend, total_ads, audit_date")
      .eq("client_code", params.clientCode)
      .order("audit_date", { ascending: false })
      .limit(1)
      .single();

    if (auditErr || !audit) {
      return JSON.stringify({ error: `No creative audit found for '${params.clientCode}'. Run the audit first.` });
    }

    const formatDist = audit.format_distribution as Record<string, { spend_pct: number; count: number; spend: number }>;
    const angleDist = audit.angle_distribution as Record<string, { spend_pct: number; count: number; spend: number }>;
    const gapMatrix = audit.gap_matrix as { untested: string[]; underweight: string[] };

    // Step 2: Calculate format entropy
    const formatSpendMap = new Map<string, number>();
    let totalFormatSpend = 0;
    for (const [code, data] of Object.entries(formatDist)) {
      formatSpendMap.set(code, data.spend);
      totalFormatSpend += data.spend;
    }
    const formatEntropy = shannonEntropy(formatSpendMap, totalFormatSpend);
    const formatMaxEntropy = maxEntropy(ALL_FORMATS.length);
    const formatNormalized = formatMaxEntropy > 0 ? formatEntropy / formatMaxEntropy : 0;

    // Step 3: Calculate angle entropy
    const angleSpendMap = new Map<string, number>();
    let totalAngleSpend = 0;
    for (const [code, data] of Object.entries(angleDist)) {
      angleSpendMap.set(code, data.spend);
      totalAngleSpend += data.spend;
    }
    const angleEntropy = shannonEntropy(angleSpendMap, totalAngleSpend);
    const angleMaxEntropy = maxEntropy(ALL_ANGLES.length);
    const angleNormalized = angleMaxEntropy > 0 ? angleEntropy / angleMaxEntropy : 0;

    // Step 4: Concentration risk — any format or angle > 60% of spend
    const concentrationWarnings: string[] = [];
    for (const [code, data] of Object.entries(formatDist)) {
      if (data.spend_pct > 0.6) {
        concentrationWarnings.push(`Format ${code} has ${(data.spend_pct * 100).toFixed(1)}% of spend — high concentration risk`);
      }
    }
    for (const [code, data] of Object.entries(angleDist)) {
      if (data.spend_pct > 0.6) {
        concentrationWarnings.push(`Angle ${code} has ${(data.spend_pct * 100).toFixed(1)}% of spend — high concentration risk`);
      }
    }

    // Step 5: Gap count
    const totalPossibleCombos = ALL_FORMATS.length * ALL_ANGLES.length; // 255
    const untestedCount = gapMatrix.untested?.length ?? 0;
    const testedPct = totalPossibleCombos > 0
      ? ((totalPossibleCombos - untestedCount) / totalPossibleCombos)
      : 0;

    // Step 6: Composite diversity score (0-100)
    // Weighted: format entropy (30%), angle entropy (30%), low concentration (20%), coverage (20%)
    const concentrationScore = concentrationWarnings.length === 0 ? 1 : Math.max(0, 1 - concentrationWarnings.length * 0.3);
    const diversityScore = Math.round(
      (formatNormalized * 30 + angleNormalized * 30 + concentrationScore * 20 + testedPct * 20),
    );

    // Step 7: Recommended gaps — pick the most interesting untested combos
    // Prioritize: combos where the format OR angle already has some data (adjacent exploration)
    const testedFormats = new Set(Object.keys(formatDist));
    const testedAngles = new Set(Object.keys(angleDist));
    const recommendedGaps: string[] = [];
    const adjacentGaps: string[] = [];
    const farGaps: string[] = [];

    for (const combo of gapMatrix.untested ?? []) {
      const [f, a] = combo.split("×");
      const formatTested = testedFormats.has(f!);
      const angleTested = testedAngles.has(a!);
      if (formatTested && angleTested) {
        adjacentGaps.push(combo);
      } else if (formatTested || angleTested) {
        farGaps.push(combo);
      }
    }
    // Take top 5 adjacent, then fill with far gaps
    recommendedGaps.push(...adjacentGaps.slice(0, 5));
    if (recommendedGaps.length < 5) {
      recommendedGaps.push(...farGaps.slice(0, 5 - recommendedGaps.length));
    }

    const result = {
      client_code: params.clientCode,
      diversity_score: diversityScore,
      format_entropy: { raw: +formatEntropy.toFixed(3), normalized: +formatNormalized.toFixed(3), max: +formatMaxEntropy.toFixed(3) },
      angle_entropy: { raw: +angleEntropy.toFixed(3), normalized: +angleNormalized.toFixed(3), max: +angleMaxEntropy.toFixed(3) },
      concentration_warnings: concentrationWarnings,
      gap_analysis: {
        total_possible_combos: totalPossibleCombos,
        untested_count: untestedCount,
        underweight_count: gapMatrix.underweight?.length ?? 0,
        tested_pct: +(testedPct * 100).toFixed(1),
      },
      recommended_gaps: recommendedGaps,
      audit_date: audit.audit_date,
      total_ads: audit.total_ads,
      total_spend: audit.total_spend,
    };

    logger.debug({ clientCode: params.clientCode, score: diversityScore }, "Calculated diversity score");
    return JSON.stringify(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "getCreativeDiversityScore failed");
    return JSON.stringify({ error: msg });
  }
}
