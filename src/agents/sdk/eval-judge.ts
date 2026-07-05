/**
 * Eval judge (Ada 2.0 Phase 1) — turns the capture-and-compare eval harness into
 * a judged one. The harness runs Ada against the golden questions; this grades
 * each response against the question's `expect` rubric with an LLM judge, so a
 * change to prompts / wiring / the loop gets a pass|partial|fail verdict instead
 * of a human eyeballing diffs. (Invariant #7: eval-first — every dead-end becomes
 * a golden case; the judge is what makes the net automatic.)
 *
 * Two rubric layers feed the judge:
 *   1. The per-question `expect` (what THIS answer must contain).
 *   2. A compact GENERAL RUBRIC — the [EVAL]-tagged principles from the Ada
 *      quality bar (docs/ada-quality-bar-2026-06-21.md). These are the
 *      methodology standards every answer is held to. When the answer clearly
 *      violates one, the judge names its principle ID in `principles_violated`.
 *
 * Pure helpers here (prompt + verdict parsing) so they unit-test without a live
 * call; the Anthropic call + harness wiring live in scripts/eval-ada.ts.
 */

export type Verdict = 'pass' | 'partial' | 'fail';
export interface JudgeVerdict {
  verdict: Verdict;
  reason: string;
  /**
   * Principle IDs (e.g. 'B1', 'D1') the answer clearly violated, from the
   * GENERAL RUBRIC below. Empty when none apply or the reply omits the field
   * (backward-compatible — the old {verdict, reason} contract still parses).
   */
  principles_violated: string[];
}

/**
 * The GENERAL RUBRIC — the 14 [EVAL] principles from the Ada quality bar, each
 * one crisp gradeable line. Source of truth: docs/ada-quality-bar-2026-06-21.md
 * (bmad repo). A7 is included as a PROVISIONAL soft note (tagged [EVAL] in the
 * doc's summary table but [BEHAVIOR] inline — flagged so the judge treats it
 * as advisory, not a hard violation). The whole rubric is PROVISIONAL until Dan
 * ratifies the quality bar.
 */
export const GENERAL_RUBRIC: Array<{ id: string; line: string }> = [
  { id: 'A2', line: 'Surface metrics are symptoms — hunt the root CAUSE and name the mechanism; never stop at a correlation.' },
  { id: 'A3', line: 'Walk the funnel as a chain of rates and find the FIRST broken link; each rate normalized to its right denominator.' },
  { id: 'A4', line: 'Isolate by altitude and owner — breadth (account/campaign/ad set/ad) tells the layer, timing tells the cause; run the cross-account "is it us or the market" check when relevant.' },
  { id: 'A8', line: 'Impossible or contradictory numbers (negative rates, more purchases than checkouts) are data BUGS to flag and reconcile, never findings to report as truth.' },
  { id: 'B1', line: 'Ratios over absolutes, ALWAYS benchmarked, and name the axis on every superlative (higher/lower than what, by how much, vs which base).' },
  { id: 'B2', line: 'Respect the metric-altitude ladder (in-platform ROAS < blended/Triple Whale < net profit/contribution margin) and validate Meta against the source of truth before trusting it.' },
  { id: 'B3', line: 'Contribution-margin thinking — for thin-margin e-comm, judge spend on margin-vs-opex, not ROAS in isolation.' },
  { id: 'B4', line: 'Optimize to the real economics, not the headline KPI; never optimize a metric that is itself a function of the result.' },
  { id: 'B6', line: 'Scope the window to the decision; never average across units with different targets.' },
  { id: 'C6', line: 'Explain WHY mechanistically — every move or finding carries a "because".' },
  { id: 'D1', line: 'Bottom line first, then the honest explanation, then ONE concrete next action.' },
  { id: 'D3', line: 'Never speak a guess as fact (especially to a client) — verify first; state uncertainty as uncertainty, not as a confident claim.' },
  { id: 'D4', line: 'Intellectual honesty — admit a wrong premise and refine the learning; the written record and source of truth outrank memory.' },
  { id: 'D8', line: 'Right presentation altitude — clean, anticipates the next question; cost-of-analysis (token/model efficiency) is part of the bar.' },
  // PROVISIONAL — advisory only (see doc note above).
  { id: 'A7', line: '[PROVISIONAL] Best-vs-worst-thirds: if the lift is uniform/diffused across all segments the cause is exogenous (demand/weather/weekend), not anything in the account.' },
];

/** Render the GENERAL RUBRIC as a compact block for the judge prompt. */
export function renderGeneralRubric(): string {
  return GENERAL_RUBRIC.map((p) => `- ${p.id}: ${p.line}`).join('\n');
}

/** The judge's instruction — grade the answer against the rubric, reply with trailing JSON. */
export function buildJudgePrompt(question: string, expect: string, response: string): string {
  return [
    'You are a strict QA judge for an internal marketing-ops AI agent ("Ada").',
    'Grade the ANSWER against the RUBRIC of what a correct answer must contain.',
    'Be strict: "partial" if it misses or fudges any required element; "fail" if it is wrong,',
    'hedges a real capability, or claims success it cannot have. Ignore style; judge substance.',
    '',
    `QUESTION:\n${question}`,
    '',
    `RUBRIC (what a correct answer must do for THIS question):\n${expect}`,
    '',
    'GENERAL RUBRIC (the methodology standards every Ada answer is held to — PROVISIONAL).',
    'Only judge principles that are actually RELEVANT to this question; ignore ones that do not apply.',
    'List in principles_violated the IDs of any principle the answer CLEARLY violates:',
    renderGeneralRubric(),
    '',
    `ANSWER TO GRADE:\n${response}`,
    '',
    'Reply with AT MOST two sentences of reasoning, then a JSON object on the last line:',
    '{"verdict": "pass" | "partial" | "fail", "reason": "<short>", "principles_violated": ["<id>", ...]}',
    'principles_violated lists ONLY the GENERAL RUBRIC ids clearly violated (use [] if none).',
    'The JSON line is mandatory — never omit it, whatever the reasoning.',
  ].join('\n');
}

/**
 * Parse the judge's reply into a verdict. Reads the LAST {...} object (the
 * trailing-JSON convention). Fail-safe: an unparseable reply counts as 'fail'
 * (a judge we can't read is not a pass). `principles_violated` defaults to []
 * when absent or malformed (backward-compatible with the old contract).
 */
export function parseJudgeVerdict(raw: string): JudgeVerdict {
  const start = raw.lastIndexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      const v = String(o.verdict ?? '').toLowerCase();
      if (v === 'pass' || v === 'partial' || v === 'fail') {
        return {
          verdict: v as Verdict,
          reason: String(o.reason ?? ''),
          principles_violated: normalizePrinciples(o.principles_violated),
        };
      }
    } catch {
      // fall through to fail-safe
    }
  }
  return { verdict: 'fail', reason: `unparseable judge reply: ${raw.slice(0, 120)}`, principles_violated: [] };
}

/** Coerce the judge's principles_violated field into a clean string[] (defensive). */
function normalizePrinciples(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => String(x).trim().toUpperCase())
    .filter((x) => x.length > 0 && x.length <= 4);
}
