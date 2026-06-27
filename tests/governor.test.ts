import { describe, it, expect } from 'vitest';
import { govern } from '../src/agents/sdk/governor.js';

// The Governor is the graded judgment layer (blast × reversibility × confidence
// → UX tier) on top of the binary guard. These cases are its selfcheck — pure,
// deterministic. Mirrors the research §4.7 routing + §5 reversibility taxonomy.
describe('Governor — graded tier routing', () => {
  it('auto-heals a high-confidence, reversible, low-blast write (the JVA resolver retry)', () => {
    const v = govern({ toolName: 'mcp__ada-tools__launch_ads', confidence: 0.9 });
    expect(v.reversibility).toBe('cheap-undo'); // PAUSED objects
    expect(v.blast).toBe('low'); // one ad set
    expect(v.tier).toBe('auto-heal');
  });

  it('try-then-show at medium confidence — probe first, then confirm', () => {
    const v = govern({ toolName: 'launch_ads', confidence: 0.65 });
    expect(v.confidence).toBe('medium');
    expect(v.tier).toBe('try-then-show');
  });

  it('options at low confidence', () => {
    const v = govern({ toolName: 'launch_ads', confidence: 0.3 });
    expect(v.tier).toBe('options');
  });

  it('BLOCKS delete tools — never autonomous, even at max confidence', () => {
    const v = govern({ toolName: 'delete_learning', confidence: 0.99 });
    expect(v.reversibility).toBe('forbidden');
    expect(v.tier).toBe('blocked');
  });

  it('forces options for an irreversible-with-cost / go-live verb even at high confidence', () => {
    const v = govern({ toolName: 'unpause_adset', confidence: 0.95 });
    expect(v.reversibility).toBe('irreversible');
    expect(v.tier).toBe('options');
  });

  it('forces options for high blast regardless of confidence', () => {
    const v = govern({ toolName: 'launch_ads', confidence: 0.95, blast: 'high' });
    expect(v.tier).toBe('options');
  });

  it('irreversible spend verbs (set_budget) → options even though blast is only medium', () => {
    const v = govern({ toolName: 'set_budget', confidence: 0.95 });
    expect(v.blast).toBe('medium');
    expect(v.reversibility).toBe('irreversible');
    expect(v.tier).toBe('options'); // the irreversible rail fires first
  });

  it('a reversible BUT medium-blast (client-strategy) write never silently auto-heals — drops to try-then-show', () => {
    // launch_ads is cheap-undo; force medium blast (e.g. a probe found it touches a shared adset).
    const v = govern({ toolName: 'launch_ads', confidence: 0.95, blast: 'medium' });
    expect(v.reversibility).toBe('cheap-undo');
    expect(v.blast).toBe('medium');
    expect(v.tier).toBe('try-then-show'); // not auto-heal, despite high confidence
  });

  it('free-undo internal writes auto-heal at high confidence', () => {
    const v = govern({ toolName: 'remember', confidence: 0.9 });
    expect(v.reversibility).toBe('free-undo');
    expect(v.tier).toBe('auto-heal');
  });

  it('an UNCLASSIFIED write never silently auto-heals (conservative default)', () => {
    const v = govern({ toolName: 'some_new_write', confidence: 0.95 });
    expect(v.known).toBe(false);
    expect(v.reversibility).toBe('cheap-undo'); // conservative default
    expect(v.tier).toBe('try-then-show'); // not auto-heal
  });

  it('an explicit reversibility override wins (a probe can downgrade it)', () => {
    const v = govern({ toolName: 'launch_ads', confidence: 0.9, reversibility: 'irreversible' });
    expect(v.tier).toBe('options');
  });

  it('confidence bucketing: 0.8 = high, 0.5 = medium, 0.49 = low', () => {
    expect(govern({ toolName: 'remember', confidence: 0.8 }).confidence).toBe('high');
    expect(govern({ toolName: 'remember', confidence: 0.5 }).confidence).toBe('medium');
    expect(govern({ toolName: 'remember', confidence: 0.49 }).confidence).toBe('low');
  });
});
