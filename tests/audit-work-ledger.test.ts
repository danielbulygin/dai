import { describe, it, expect } from 'vitest';
import { buildWorkLedger, MAX_WORK_ROWS, type WorkLedgerInputs } from '../src/audit/work-ledger.js';
import { resolveAuditWindow } from '../src/audit/audit-window.js';
import type { AuditSection } from '../src/audit/magic-audit.js';

/**
 * The work ledger is what the page shows instead of hiding the work. Its one
 * rule is that a row exists only when the work behind it happened, so most of
 * these tests are about what it REFUSES to claim.
 */

const section = (key: string, over: Partial<AuditSection> = {}): AuditSection => ({
  key,
  title: key,
  status: 'complete',
  ...over,
});

const LIVE = resolveAuditWindow({ asOf: '2026-08-20', lastSpendDate: '2026-08-19' });
const DORMANT = resolveAuditWindow({ asOf: '2026-08-20', lastSpendDate: '2026-07-20' });

const base = (over: Partial<WorkLedgerInputs> = {}): WorkLedgerInputs => ({
  sections: {},
  window: LIVE,
  adsRead: 42,
  daysRead: 183,
  coreDaysCovered: 30,
  retiredAdsFound: 0,
  insightsRanked: 0,
  scorecardDimensions: 0,
  ...over,
});

const lines = (inp: WorkLedgerInputs): string[] => buildWorkLedger(inp).map((r) => r.line);

describe('buildWorkLedger', () => {
  it('leads with what it read, in ads and in days', () => {
    expect(buildWorkLedger(base())[0]).toEqual({ n: 42, line: 'Read 42 ads across 183 days of delivery history' });
  });

  it('names the anchored window in the line about it', () => {
    expect(lines(base({ window: DORMANT }))[1]).toBe(
      "Measured the 30 days ending 20 Jul, the account's last active month, day by day",
    );
    expect(lines(base())[1]).toBe('Measured the last 30 days of delivery day by day');
  });

  it('counts finding the ads that earned before as work, when there were any', () => {
    expect(lines(base({ retiredAdsFound: 6 }))).toContain('Found 6 ads that earned earlier and are not running now');
    expect(lines(base({ retiredAdsFound: 0 })).some((l) => l.includes('earned earlier'))).toBe(false);
  });

  it('claims the landing page only when a page was actually opened', () => {
    const opened = { message_match: section('message_match', { data: { page: { url: 'https://x.test/lp' } } }) };
    expect(lines(base({ sections: opened }))).toContain('Opened your landing page and read what it promises');

    const skipped = { message_match: section('message_match', { status: 'skipped', skip_reason: 'no destination' }) };
    expect(lines(base({ sections: skipped })).some((l) => l.includes('landing page'))).toBe(false);

    const pageless = { message_match: section('message_match', { data: { page: null } }) };
    expect(lines(base({ sections: pageless })).some((l) => l.includes('landing page'))).toBe(false);
  });

  it('takes nothing from a section that errored', () => {
    const errored = {
      creative_fatigue: section('creative_fatigue', { status: 'error', error: 'pull failed', data: { assessed_ads: 9 } }),
    };
    expect(lines(base({ sections: errored })).some((l) => l.includes('fatigue'))).toBe(false);
  });

  it('reports the creatives it watched, and falls back to the copy it read', () => {
    const watched = {
      creative_analysis: section('creative_analysis', {
        data: { creatives_analyzed: 8, media_resolution: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
      }),
    };
    expect(lines(base({ sections: watched }))).toContain('Watched 8 creatives frame by frame');
    expect(lines(base({ sections: watched })).some((l) => l.includes('Read the copy'))).toBe(false);

    const unwatched = {
      creative_analysis: section('creative_analysis', { data: { creatives_analyzed: 0, media_resolution: [1, 2, 3] } }),
    };
    expect(lines(base({ sections: unwatched }))).toContain('Read the copy on 3 top-spending ads');
  });

  it('counts the checks it ran and the insights it kept', () => {
    const sections = {
      a: section('a'),
      b: section('b'),
      c: section('c', { status: 'planned' }),
    };
    const out = lines(base({ sections, insightsRanked: 3, scorecardDimensions: 5 }));
    expect(out).toContain('Ran 2 checks over the account end to end');
    expect(out).toContain('Graded 5 dimensions against the accounts on our desk');
    expect(out).toContain('Ranked everything found and kept the 3 that matter most');
  });

  it('stays inside the cap the page renders', () => {
    const sections: Record<string, AuditSection> = {
      creative_fatigue: section('creative_fatigue', { data: { assessed_ads: 11 } }),
      spend_concentration: section('spend_concentration', { data: { ads_with_spend: 12 } }),
      budget_scatter: section('budget_scatter', { data: { ads_plotted: 13 } }),
      creative_analysis: section('creative_analysis', { data: { creatives_analyzed: 8 } }),
      creative_cohorts: section('creative_cohorts', { data: { window_months: 6 } }),
      cost_trends: section('cost_trends', { data: { series: [1, 2, 3] } }),
      landing_pages: section('landing_pages', { data: { dead_checks: [1, 2] } }),
      message_match: section('message_match', { data: { page: { url: 'https://x.test' } } }),
      account_activity: section('account_activity', { data: { total_window: 90 } }),
      account_facts: section('account_facts', { data: { facts: [1, 2, 3, 4, 5, 6] } }),
    };
    const rows = buildWorkLedger(base({ sections, retiredAdsFound: 4, insightsRanked: 3, scorecardDimensions: 5 }));
    expect(rows.length).toBeLessThanOrEqual(MAX_WORK_ROWS);
    for (const r of rows) expect(r.n).toBeGreaterThan(0);
  });

  it('says nothing at all about a run that did nothing', () => {
    expect(buildWorkLedger(base({ adsRead: 0, daysRead: 0, coreDaysCovered: 0 }))).toEqual([]);
  });
});
