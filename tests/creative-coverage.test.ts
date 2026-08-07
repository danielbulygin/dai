/**
 * Loop 5's coverage line — the pure half, one case per decision it makes.
 *
 * Nothing here is mocked: `buildCoverageRead` carries every formatting and
 * threshold decision, and `fetchCreativeCoverage` is a thin wrapper whose only
 * extra job is fail-open. So the rules worth protecting are all testable
 * without touching the network:
 *
 *   1. Absence is honest. No spending ads → no line and no amber flag. A
 *      client who didn't spend has no coverage gap to warn about.
 *   2. Numbers carry their meaning, and never arrive as a bare percentage.
 *   3. The amber threshold is a real 95%, checked at the boundary.
 */

import { describe, expect, it } from 'vitest';
import {
  AMBER_BELOW,
  DEFAULT_COVERAGE_DAYS,
  buildCoverageRead,
  fetchCreativeCoverage,
} from '../src/monitoring/creative-coverage.js';

describe('buildCoverageRead — full coverage', () => {
  it('says "all N" and names the window', () => {
    const read = buildCoverageRead(87, 87, 7);
    expect(read.line).toBe('Creative coverage: all 87 spending ads understood (last 7 days)');
    expect(read.analyzed).toBe(87);
    expect(read.spendingAds).toBe(87);
    expect(read.ratio).toBe(1);
    expect(read.amber).toBe(false);
  });

  it('carries a non-default window into the line', () => {
    expect(buildCoverageRead(12, 12, 30).line).toContain('(last 30 days)');
  });

  it('says "day" not "days" for a one-day window', () => {
    expect(buildCoverageRead(4, 4, 1).line).toBe(
      'Creative coverage: all 4 spending ads understood (last 1 day)',
    );
  });

  it('defaults to the 7-day window', () => {
    expect(buildCoverageRead(5, 5).line).toContain(`(last ${DEFAULT_COVERAGE_DAYS} days)`);
  });
});

describe('buildCoverageRead — partial coverage', () => {
  it('gives both numbers and names the shortfall', () => {
    const read = buildCoverageRead(82, 87, 7);
    expect(read.line).toBe(
      'Creative coverage: 82 of 87 spending ads understood — 5 not yet analyzed',
    );
    expect(read.analyzed).toBe(82);
    expect(read.spendingAds).toBe(87);
    expect(read.ratio).toBeCloseTo(0.9425, 4);
    expect(read.amber).toBe(true);
  });

  it('handles the real BFM 7-day read (16 of 238)', () => {
    const read = buildCoverageRead(16, 238, 7);
    expect(read.line).toBe(
      'Creative coverage: 16 of 238 spending ads understood — 222 not yet analyzed',
    );
    expect(read.amber).toBe(true);
  });

  it('handles zero analyzed without pretending there is no line', () => {
    const read = buildCoverageRead(0, 47, 7);
    expect(read.line).toBe(
      'Creative coverage: 0 of 47 spending ads understood — 47 not yet analyzed',
    );
    expect(read.ratio).toBe(0);
    expect(read.amber).toBe(true);
  });
});

describe('buildCoverageRead — nothing spent', () => {
  it('returns no line and no amber flag', () => {
    const read = buildCoverageRead(0, 0, 7);
    expect(read.line).toBeNull();
    expect(read.spendingAds).toBe(0);
    expect(read.analyzed).toBe(0);
    expect(read.ratio).toBe(0);
    // The rule worth protecting: no spend means no gap, so no warning.
    expect(read.amber).toBe(false);
  });

  it('stays silent even if the RPC reports analyzed ads with a zero denominator', () => {
    expect(buildCoverageRead(5, 0, 7).line).toBeNull();
  });
});

describe('buildCoverageRead — the amber threshold', () => {
  it('is not amber exactly at 95%', () => {
    const read = buildCoverageRead(95, 100, 7);
    expect(read.ratio).toBe(0.95);
    expect(read.amber).toBe(false);
  });

  it('is amber just below 95%', () => {
    expect(buildCoverageRead(94, 100, 7).amber).toBe(true);
    expect(buildCoverageRead(949, 1000, 7).amber).toBe(true);
  });

  it('matches the exported threshold', () => {
    expect(AMBER_BELOW).toBe(0.95);
  });
});

describe('buildCoverageRead — ratio rounding', () => {
  it('rounds to 4 decimal places', () => {
    expect(buildCoverageRead(1, 3, 7).ratio).toBe(0.3333);
    expect(buildCoverageRead(2, 3, 7).ratio).toBe(0.6667);
    expect(buildCoverageRead(16, 238, 7).ratio).toBe(0.0672);
  });

  it('keeps ratio and amber consistent with each other', () => {
    for (const [a, n] of [
      [1, 3],
      [82, 87],
      [94, 100],
      [95, 100],
      [99, 100],
      [100, 100],
    ] as const) {
      const read = buildCoverageRead(a, n, 7);
      expect(read.amber).toBe(read.ratio < AMBER_BELOW);
    }
  });
});

describe('buildCoverageRead — house rules', () => {
  it('never puts a percentage in the line', () => {
    for (const [a, n] of [
      [87, 87],
      [82, 87],
      [16, 238],
      [0, 47],
    ] as const) {
      expect(buildCoverageRead(a, n, 7).line).not.toMatch(/%|percent/i);
    }
  });

  it('always pairs a number with what it means', () => {
    expect(buildCoverageRead(82, 87, 7).line).toContain('spending ads understood');
    expect(buildCoverageRead(82, 87, 7).line).toContain('not yet analyzed');
  });
});

describe('buildCoverageRead — defensive input', () => {
  it('never reports a negative shortfall when analyzed exceeds the total', () => {
    const read = buildCoverageRead(90, 87, 7);
    expect(read.analyzed).toBe(87);
    expect(read.line).toBe('Creative coverage: all 87 spending ads understood (last 7 days)');
    expect(read.amber).toBe(false);
  });

  it('treats garbage counts as zero rather than emitting NaN', () => {
    const read = buildCoverageRead(Number.NaN, Number.NaN, 7);
    expect(read.line).toBeNull();
    expect(read.ratio).toBe(0);

    const partial = buildCoverageRead(Number.NaN, 10, 7);
    expect(partial.line).toBe(
      'Creative coverage: 0 of 10 spending ads understood — 10 not yet analyzed',
    );
  });

  it('ignores negative counts', () => {
    expect(buildCoverageRead(-5, -5, 7).line).toBeNull();
  });
});

describe('fetchCreativeCoverage — fail-open contract', () => {
  it('returns null instead of throwing when the warehouse is unreachable', async () => {
    // tests/setup.ts leaves SUPABASE_URL unset, so getSupabase() throws on the
    // way in. That is exactly the shape of "coverage is broken": the caller
    // must get null, never an exception that takes the brief down with it.
    await expect(fetchCreativeCoverage('BFM', 7)).resolves.toBeNull();
  });
});
