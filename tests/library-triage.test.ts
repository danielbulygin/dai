import { describe, expect, it } from 'vitest';
import { extractJson, isDynamicTemplateBody, triageLibrary, type LibraryAd } from '../src/audit/library-triage.js';

const ad = (body: string, collation = 1, extra: Partial<LibraryAd> = {}): LibraryAd => ({
  is_active: true,
  collation_count: collation,
  snapshot: { body: { text: body } },
  ...extra,
});

describe('isDynamicTemplateBody', () => {
  it('detects catalog template tokens', () => {
    expect(isDynamicTemplateBody('{{product.brand}} — jetzt shoppen')).toBe(true);
    expect(isDynamicTemplateBody('Get {{product.name}} for {{product.price}}')).toBe(true);
  });
  it('leaves normal copy alone', () => {
    expect(isDynamicTemplateBody('Wir haben das beste Angebot für dich')).toBe(false);
    expect(isDynamicTemplateBody('single {braces} are not templates')).toBe(false);
    expect(isDynamicTemplateBody('')).toBe(false);
  });
});

describe('triageLibrary — catalog/dynamic handling (2026-07-01 false-positive regression)', () => {
  it('keeps template tokens OUT of top_hooks and counts their weight separately', () => {
    const t = triageLibrary([
      ad('{{product.brand}} — shop the drop', 34),
      ad('Dealerships wasting your time? Get approved today.', 38),
      ad('Real copy hook number two', 10),
    ]);
    const hooks = (t.top_hooks as Array<{ value: string; weight: number }>).map((h) => h.value);
    expect(hooks.some((h) => h.includes('{{'))).toBe(false);
    expect(hooks[0]).toContain('dealerships wasting your time');
    // 34 of 82 total weight is catalog creative → 41%
    expect(t.catalog_dynamic_weight_share_pct).toBe(41);
  });
  it('reports 0 catalog share on an account with no dynamic ads', () => {
    const t = triageLibrary([ad('plain hook', 5)]);
    expect(t.catalog_dynamic_weight_share_pct).toBe(0);
    expect((t.top_hooks as unknown[]).length).toBe(1);
  });
});

describe('extractJson', () => {
  it('parses fenced JSON', () => {
    expect(extractJson<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('extracts an object embedded in prose', () => {
    expect(extractJson<{ ok: boolean }>('Here you go: {"ok":true} — done')).toEqual({ ok: true });
  });
  it('throws on output with no JSON object', () => {
    expect(() => extractJson('no json here')).toThrow('no JSON object');
  });
  it('throws on structurally broken JSON (the SS failure class) so the repair retry can fire', () => {
    expect(() => extractJson('{"winners":["a","b" "c"]}')).toThrow();
  });
});
