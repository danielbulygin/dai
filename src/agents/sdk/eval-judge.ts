/**
 * Eval judge (Ada 2.0 Phase 1) — turns the capture-and-compare eval harness into
 * a judged one. The harness runs Ada against the golden questions; this grades
 * each response against the question's `expect` rubric with an LLM judge, so a
 * change to prompts / wiring / the loop gets a pass|partial|fail verdict instead
 * of a human eyeballing diffs. (Invariant #7: eval-first — every dead-end becomes
 * a golden case; the judge is what makes the net automatic.)
 *
 * Pure helpers here (prompt + verdict parsing) so they unit-test without a live
 * call; the Anthropic call + harness wiring live in scripts/eval-ada.ts.
 */

export type Verdict = 'pass' | 'partial' | 'fail';
export interface JudgeVerdict {
  verdict: Verdict;
  reason: string;
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
    `RUBRIC (what a correct answer must do):\n${expect}`,
    '',
    `ANSWER TO GRADE:\n${response}`,
    '',
    'Reply with one sentence of reasoning, then a JSON object on the last line:',
    '{"verdict": "pass" | "partial" | "fail", "reason": "<short>"}',
  ].join('\n');
}

/**
 * Parse the judge's reply into a verdict. Reads the LAST {...} object (the
 * trailing-JSON convention). Fail-safe: an unparseable reply counts as 'fail'
 * (a judge we can't read is not a pass).
 */
export function parseJudgeVerdict(raw: string): JudgeVerdict {
  const start = raw.lastIndexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
      const v = String(o.verdict ?? '').toLowerCase();
      if (v === 'pass' || v === 'partial' || v === 'fail') {
        return { verdict: v as Verdict, reason: String(o.reason ?? '') };
      }
    } catch {
      // fall through to fail-safe
    }
  }
  return { verdict: 'fail', reason: `unparseable judge reply: ${raw.slice(0, 120)}` };
}
