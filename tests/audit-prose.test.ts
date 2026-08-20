import { describe, it, expect } from 'vitest';
import {
  dedash, dedashDeep, findBannedPhrases, stripBannedSentences, scrubSectionProse, scrubInsightProse,
} from '../src/audit/prose.js';

/**
 * The deterministic half of the write-back gate: no em-dashes in customer copy
 * (house rule), and no sentence that asserts a verdict with no number behind it.
 * The LLM rewrite retry lives in the orchestrator; everything pinned here runs
 * without a model.
 */

describe('dedash', () => {
  it('a single em dash becomes a full stop and the next clause is capitalised', () => {
    expect(dedash('Spend is up 22% — the auction got pricier this month.')).toBe(
      'Spend is up 22%. The auction got pricier this month.',
    );
  });

  it('a pair of em dashes fencing an aside becomes commas', () => {
    expect(dedash('Your top ad — the one taking 41% of spend — is fatiguing.')).toBe(
      'Your top ad, the one taking 41% of spend, is fatiguing.',
    );
  });

  it('keeps a numeric en-dash range intact', () => {
    const t = '40–60% in the top 3 is workable, and 2–3 new concepts a month holds it there.';
    expect(dedash(t)).toBe(t);
  });

  it('handles a spaced en dash used as punctuation', () => {
    expect(dedash('CPL is 18.59 – that is the number to beat.')).toBe('CPL is 18.59. That is the number to beat.');
  });

  it('scrubs every sentence in a multi-sentence summary and leaves no dash behind', () => {
    const out = dedash(
      '3 ads carry 62% of assessed spend — ROAS down 31% from the first half of the run to the second. ' +
      'Right now ≈1,200 SEK/day runs on this set — that is the budget the replacements inherit.',
    );
    expect(out).not.toMatch(/[—]/);
    expect(out).toContain('the second. Right now');
    expect(out).toContain('SEK/day runs on this set. That is the budget');
  });

  it('is idempotent and leaves clean text untouched', () => {
    const clean = 'Tuesday costs 50.00 per lead against 20.00 on Monday, a 150% gap.';
    expect(dedash(clean)).toBe(clean);
    expect(dedash(dedash('A — b.'))).toBe(dedash('A — b.'));
  });
});

describe('banned phrases', () => {
  it('finds the three phrases that assert a verdict with no number', () => {
    expect(findBannedPhrases('Good news: your account is clean.')).toEqual(['your account is clean']);
    expect(findBannedPhrases('Spend is broadly tracking return, keep going.')).toEqual(['spend broadly tracking return']);
    expect(findBannedPhrases('Spend broadly tracking return.')).toEqual(['spend broadly tracking return']);
    expect(findBannedPhrases('Nothing to force here.')).toEqual(['nothing to force here']);
    expect(findBannedPhrases('Cost per lead is 18.59 against your 25.00 target.')).toEqual([]);
  });

  it('strips only the offending sentence, keeping the ones carrying numbers', () => {
    const out = stripBannedSentences(
      'Your account is clean. Cost per lead is 18.59 across 482 leads. Nothing to force here.',
    );
    expect(out).toBe('Cost per lead is 18.59 across 482 leads.');
  });

  it('can legitimately strip everything, rather than keeping filler', () => {
    expect(stripBannedSentences('Your account is clean.')).toBe('');
  });
});

describe('scrubSectionProse', () => {
  const section = {
    key: 'budget_scatter',
    summary: 'Each dot is one ad — placed by spend against cost per result.',
    next_step: 'Spend is broadly tracking return, so keep feeding the winners.',
    warnings: ['2 ads carry no mapped result — they get no dot.'],
  };

  it('reports the filler for the caller\'s one retry, and does not strip on the first pass', () => {
    const r = scrubSectionProse(section);
    expect(r.banned).toEqual(['spend broadly tracking return']);
    expect(r.section.summary).toBe('Each dot is one ad. Placed by spend against cost per result.');
    expect(r.section.next_step).toContain('broadly tracking return'); // still there, awaiting the rewrite
    expect(r.section.warnings![0]).toBe('2 ads carry no mapped result. They get no dot.');
    expect(JSON.stringify(r.section)).not.toMatch(/[—]/);
  });

  it('strips the filler sentence on the second pass', () => {
    const r = scrubSectionProse(section, { strip: true });
    expect(r.banned).toEqual(['spend broadly tracking return']);
    expect(r.section.next_step).toBe('');
  });

  it('leaves a section that was already clean byte-identical', () => {
    const clean = { key: 'x', summary: 'CPL 18.59 across 482 leads.', next_step: 'Hold the budget for two weeks.' };
    expect(scrubSectionProse(clean)).toEqual({ section: clean, banned: [] });
  });

  it('does not invent fields the section never had', () => {
    const r = scrubSectionProse({ key: 'y' } as { key: string; summary?: string });
    expect('summary' in r.section).toBe(false);
    expect(r.banned).toEqual([]);
  });
});

describe('scrubInsightProse', () => {
  it('scrubs the dashes in a headline and detail', () => {
    const i = scrubInsightProse({
      headline: 'Tuesday costs 2.5x per lead — every week',
      detail: 'Tuesdays book 2 leads on the same 100 spend — 50.00 against 20.00 on Monday.',
      severity: 'risk',
    });
    expect(i.headline).toBe('Tuesday costs 2.5x per lead. Every week');
    expect(i.detail).not.toMatch(/[—]/);
    expect(i.severity).toBe('risk');
  });
});

describe('dedashDeep', () => {
  /** A synthesis section the way the model actually returns one. */
  const section = {
    key: 'funnel_read',
    summary: 'Cost per lead is 18.59 across 482 leads.',
    data: {
      funnel_kind: 'lead_gen',
      stages: [
        { stage: 'Link clicks', value: 9000, rate_from_prev: 1 },
        { stage: 'Leads', value: 482, rate_from_prev: 5.4 },
      ],
      biggest_leak: {
        stage: 'Leads',
        read: 'Only 5.4% of clicks become a lead — the form is asking for too much before it earns the ask.',
      },
      opportunities: [
        'Cut the form to 3 fields — the drop is between the click and the lead, not before it.',
        'Nothing structural to change on the click side (1.0% link CTR).',
      ],
      winners: [
        { ad_name: 'Form-hook – A/B', spend: 5577, key_stat: 'Meta CPL 18.59', why: 'Plain promise, no jargon.' },
        {
          ad_name: 'Form-hook-B',
          spend: 2000,
          key_stat: 'hook rate 38% — the highest in the account',
          why: 'Opens on the price — the objection first, which the others bury.',
          thumbnail_url: 'https://cdn.example.com/a—b.jpg',
        },
      ],
      angle_patterns: [{ pattern: 'Price-first', evidence: 'Both top ads name the monthly figure — 12 USD — in the first line.' }],
      gaps: ['No testimonial angle — nothing in market carries a customer voice.'],
    },
  };

  const scrubbed = dedashDeep(section);
  const flat = JSON.stringify(scrubbed);

  it('leaves no em-dash in anything a reader sees, at any depth', () => {
    // The fixture's ad_name and thumbnail_url carry dashes ON PURPOSE (both are
    // join keys, exempt below). Every other string in the section is prose.
    const proseOnly = flat.replace(/"(?:ad_name|thumbnail_url)":"[^"]*"/g, '');
    expect(proseOnly).not.toMatch(/—/);
    expect(proseOnly).not.toMatch(/\s–\s/);
  });

  it('scrubs biggest_leak.read and the nested winner why', () => {
    expect(scrubbed.data.biggest_leak.read).toBe(
      'Only 5.4% of clicks become a lead. The form is asking for too much before it earns the ask.',
    );
    expect(scrubbed.data.winners[1]!.why).toBe('Opens on the price. The objection first, which the others bury.');
    expect(scrubbed.data.winners[1]!.key_stat).toBe('hook rate 38%. The highest in the account');
  });

  it('scrubs strings inside arrays of strings and arrays of objects', () => {
    expect(scrubbed.data.opportunities[0]).toBe(
      'Cut the form to 3 fields. The drop is between the click and the lead, not before it.',
    );
    expect(scrubbed.data.gaps[0]).toBe('No testimonial angle. Nothing in market carries a customer voice.');
    expect(scrubbed.data.angle_patterns[0]!.evidence).toBe(
      'Both top ads name the monthly figure, 12 USD, in the first line.',
    );
  });

  it('never rewrites an ad name — the page joins rows to sections BY name', () => {
    expect(scrubbed.data.winners[0]!.ad_name).toBe('Form-hook – A/B');
  });

  it('never rewrites a stage name, a URL, or a machine key', () => {
    expect(scrubbed.data.stages[1]!.stage).toBe('Leads');
    expect(scrubbed.data.winners[1]!.thumbnail_url).toBe('https://cdn.example.com/a—b.jpg');
    expect(scrubbed.key).toBe('funnel_read');
  });

  it('does not mutate the input, keeps non-string values, and is idempotent', () => {
    expect(section.data.biggest_leak.read).toContain('—');
    expect(scrubbed.data.stages[0]!.value).toBe(9000);
    expect(scrubbed.data.funnel_kind).toBe('lead_gen');
    expect(dedashDeep(scrubbed)).toEqual(scrubbed);
  });

  it('passes through nulls, numbers and non-plain objects untouched', () => {
    const map = new Map([['a — b', 1]]);
    const out = dedashDeep({ n: 3, nil: null, un: undefined, flag: true, map });
    expect(out).toEqual({ n: 3, nil: null, un: undefined, flag: true, map });
    expect(out.map).toBe(map);
  });

  it('reaches the nested fields of a lead insight too', () => {
    const i = scrubInsightProse({
      headline: 'Tuesday costs 2.5x per lead — every week',
      detail: 'Tuesdays book 2 leads on the same 100 spend.',
      section: 'timing_patterns',
      evidence: { note: 'Measured across 13 Tuesdays — the whole 90-day window.' },
    } as { headline: string; detail: string; section: string; evidence: { note: string } });
    expect(i.headline).toBe('Tuesday costs 2.5x per lead. Every week');
    expect(i.evidence.note).toBe('Measured across 13 Tuesdays. The whole 90-day window.');
    expect(i.section).toBe('timing_patterns');
  });
});
