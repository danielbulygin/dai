import { describe, it, expect } from 'vitest';
import { parseJudgeVerdict, buildJudgePrompt, renderGeneralRubric, GENERAL_RUBRIC } from '../src/agents/sdk/eval-judge.js';

describe('eval judge — verdict parsing', () => {
  it('parses a trailing JSON verdict', () => {
    const v = parseJudgeVerdict('Looks right.\n{"verdict": "pass", "reason": "names INITIATED_CHECKOUT"}');
    expect(v.verdict).toBe('pass');
    expect(v.reason).toContain('INITIATED_CHECKOUT');
  });

  it('parses principles_violated when present', () => {
    const v = parseJudgeVerdict('Missed the benchmark.\n{"verdict":"partial","reason":"absolute count, no axis","principles_violated":["B1","D1"]}');
    expect(v.verdict).toBe('partial');
    expect(v.principles_violated).toEqual(['B1', 'D1']);
  });

  it('backward-compatible: old {verdict, reason} contract yields empty principles_violated', () => {
    const v = parseJudgeVerdict('{"verdict":"pass","reason":"fine"}');
    expect(v.verdict).toBe('pass');
    expect(v.principles_violated).toEqual([]);
  });

  it('normalizes principles_violated (uppercases, drops junk, ignores non-arrays)', () => {
    expect(parseJudgeVerdict('{"verdict":"fail","reason":"x","principles_violated":["b1"," d3 ",""]}').principles_violated).toEqual(['B1', 'D3']);
    expect(parseJudgeVerdict('{"verdict":"fail","reason":"x","principles_violated":"B1"}').principles_violated).toEqual([]);
  });

  it('parses partial / fail verdicts (case-insensitive)', () => {
    expect(parseJudgeVerdict('{"verdict":"PARTIAL","reason":"missing subcode"}').verdict).toBe('partial');
    expect(parseJudgeVerdict('reasoning…\n{"verdict":"fail","reason":"said LEAD"}').verdict).toBe('fail');
  });

  it('takes the LAST JSON object when the response echoes the rubric', () => {
    const raw = '{"verdict":"pass"} ... actually reconsidering\n{"verdict":"fail","reason":"wrong"}';
    expect(parseJudgeVerdict(raw).verdict).toBe('fail');
  });

  it('fail-safe: an unparseable reply counts as fail (a judge we can\'t read is not a pass)', () => {
    expect(parseJudgeVerdict('the answer was fine').verdict).toBe('fail');
    expect(parseJudgeVerdict('{"verdict":"maybe"}').verdict).toBe('fail');
    expect(parseJudgeVerdict('').verdict).toBe('fail');
    // fail-safe still supplies the field
    expect(parseJudgeVerdict('').principles_violated).toEqual([]);
  });

  it('buildJudgePrompt includes the question, per-question rubric, general rubric, and answer', () => {
    const p = buildJudgePrompt('Q?', 'must say X', 'the answer');
    expect(p).toContain('Q?');
    expect(p).toContain('must say X');
    expect(p).toContain('the answer');
    expect(p).toContain('verdict');
    expect(p).toContain('principles_violated');
    // general rubric principles are embedded
    expect(p).toContain('B1:');
    expect(p).toContain('D1:');
  });

  it('GENERAL_RUBRIC covers the 14 [EVAL] principles + provisional A7', () => {
    const ids = GENERAL_RUBRIC.map((p) => p.id);
    for (const id of ['A2', 'A3', 'A4', 'A8', 'B1', 'B2', 'B3', 'B4', 'B6', 'C6', 'D1', 'D3', 'D4', 'D8', 'A7']) {
      expect(ids).toContain(id);
    }
    // A7 is flagged provisional
    expect(GENERAL_RUBRIC.find((p) => p.id === 'A7')?.line).toContain('PROVISIONAL');
    expect(renderGeneralRubric()).toContain('- B1:');
  });
});
