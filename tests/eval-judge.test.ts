import { describe, it, expect } from 'vitest';
import { parseJudgeVerdict, buildJudgePrompt } from '../src/agents/sdk/eval-judge.js';

describe('eval judge — verdict parsing', () => {
  it('parses a trailing JSON verdict', () => {
    const v = parseJudgeVerdict('Looks right.\n{"verdict": "pass", "reason": "names INITIATED_CHECKOUT"}');
    expect(v.verdict).toBe('pass');
    expect(v.reason).toContain('INITIATED_CHECKOUT');
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
  });

  it('buildJudgePrompt includes the question, rubric, and answer', () => {
    const p = buildJudgePrompt('Q?', 'must say X', 'the answer');
    expect(p).toContain('Q?');
    expect(p).toContain('must say X');
    expect(p).toContain('the answer');
    expect(p).toContain('verdict');
  });
});
