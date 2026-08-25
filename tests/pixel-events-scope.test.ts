import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Scope + honesty regression suite for the two Events Manager reads
 * (`get_pixel_event_stats`, `get_custom_conversions`), added 2026-08-25.
 *
 * WHY these tests exist. Web-Ada was asked about "our new qualified subscriber
 * event", called no tool at all, and stated from memory that the event was
 * low-volume and risky to optimise on. The pixel said the opposite. Two things
 * have to hold for the fix to be worth anything:
 *
 *  1. The tools are REACHABLE from the customer chat profile, and the tenant on
 *     every call comes from the verified scope — never from the model. These are
 *     open Graph reads against an ad account; a model-chosen client code here
 *     would be a cross-tenant read, exactly the `search_memories` hole of
 *     2026-07-25.
 *  2. A refused read is never reported as a zero. "This pixel fired nothing" and
 *     "Meta would not let me look" are different facts, and collapsing them is
 *     the same fabricated receipt the tools were built to prevent.
 *
 * The tests drive the REAL `executeTool` dispatcher — the same path the SDK tool
 * bridge uses — so the scope forcing under test is the shipped one.
 */

const { state } = vi.hoisted(() => ({
  state: {
    graphCalls: [] as Array<{ path: string; params: Record<string, string>; token: string }>,
    /**
     * Pixel id -> stats payload, an error string Meta would return, or a
     * function of the window asked for. The window-aware form exists because
     * `last7dShare` is read from a SECOND call over a narrower window: a mock
     * that answers the same thing whatever it is asked could not tell the two
     * reads apart, and the share would test nothing.
     */
    stats: {} as Record<
      string,
      | { error: string }
      | { buckets: Array<Array<{ value: string; count: number }>> }
      | { byWindow: (from: number, to: number) => Array<Array<{ value: string; count: number }>> | { error: string } }
    >,
    pixels: {} as Record<string, Array<{ id: string; name: string; last_fired_time?: string }>>,
    customConversions: {} as Record<string, Array<Record<string, unknown>>>,
  },
}));

/** Two tenants with different accounts, pixels and events — any leak is visible. */
const ACCOUNTS: Record<string, string> = { alpha: 'act_1111', bravo: 'act_2222' };

vi.mock('../src/integrations/supabase.js', () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: (_col: string, code: string) => ({
          single: async () => ({
            data: ACCOUNTS[code] ? { ad_account_id: ACCOUNTS[code], timezone: 'UTC', currency: 'USD' } : null,
            error: ACCOUNTS[code] ? null : { message: 'not found' },
          }),
        }),
      }),
    }),
  }),
}));

vi.mock('../src/integrations/meta-token.js', () => ({
  getTokenForClient: async ({ clientCode }: { clientCode: string }) =>
    ACCOUNTS[clientCode]
      ? { token: `token-for-${clientCode}`, adAccountId: ACCOUNTS[clientCode], source: 'connection', mode: 'readonly' }
      : null,
}));

vi.mock('../src/integrations/meta-graph.js', () => ({
  META_API_VERSION: 'v21.0',
  META_GRAPH_BASE: 'https://graph.facebook.com/v21.0',
  graphGet: async (path: string, params: Record<string, string>, token: string) => {
    state.graphCalls.push({ path, params, token });

    const pixelList = /^(act_\d+)\/adspixels$/.exec(path);
    if (pixelList) return { data: state.pixels[pixelList[1]!] ?? [] };

    const statsRead = /^(\d+)\/stats$/.exec(path);
    if (statsRead) {
      const canned = state.stats[statsRead[1]!];
      if (canned === undefined) return { data: [] };
      if ('error' in canned) return { error: canned.error };
      const answered = 'byWindow' in canned
        ? canned.byWindow(Number(params.start_time), Number(params.end_time))
        : canned.buckets;
      if (!Array.isArray(answered)) return { error: answered.error };
      return { data: answered.map((entries) => ({ start_time: '2026-08-18T00:00:00+0000', data: entries })) };
    }

    const customConversions = /^(act_\d+)\/customconversions$/.exec(path);
    if (customConversions) return { data: state.customConversions[customConversions[1]!] ?? [] };

    return { data: [] };
  },
}));

// The tool-registry audit log writes through the dai Supabase; keep it inert.
vi.mock('../src/integrations/dai-supabase.js', () => ({
  getDaiSupabase: () => ({
    from: () => ({
      insert: () => ({ then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }) }),
    }),
  }),
}));

const { executeTool } = await import('../src/agents/tool-registry.js');
const { toolProfiles } = await import('../src/agents/profiles/index.js');

const scopedContext = (clientCode: string) => ({
  agentId: `ada_client_${clientCode}`,
  channelId: 'C_TEST',
  userId: 'U_TEST',
  clientScope: { clientCode },
});

async function run(tool: string, input: Record<string, unknown>, clientCode: string) {
  const { result, isError } = await executeTool(tool, input, scopedContext(clientCode));
  expect(isError).toBe(false);
  return JSON.parse(result);
}

beforeEach(() => {
  state.graphCalls = [];
  state.pixels = {
    act_1111: [{ id: '9001', name: 'Alpha Pixel', last_fired_time: '2026-08-24T00:00:00+0000' }],
    act_2222: [{ id: '9002', name: 'Bravo Pixel' }],
  };
  state.stats = {
    // Two hourly buckets, so the per-event sum is exercised rather than assumed.
    '9001': {
      buckets: [
        [
          { value: 'PageView', count: 500 },
          { value: 'QualifiedSubscription', count: 20_000 },
          { value: 'Purchase', count: 4000 },
        ],
        [
          { value: 'QualifiedSubscription', count: 21_999 },
          { value: 'Purchase', count: 5305 },
          { value: 'CompleteRegistration', count: 30 },
        ],
      ],
    },
    '9002': { buckets: [[{ value: 'BRAVO_SECRET_EVENT', count: 77 }]] },
  };
  state.customConversions = {
    act_1111: [
      {
        id: 'cc1',
        name: 'Qualified Lead',
        custom_event_type: 'LEAD',
        is_archived: false,
        pixel: { id: '9001' },
        rule: { and: [{ event: { eq: 'Lead' } }, { or: [{ URL: { i_contains: 'thank-you-page-with-a-very-long-url-segment-that-keeps-going-and-going-and-going-well-past-the-truncation-limit-we-set' } }] }] },
      },
    ],
    act_2222: [{ id: 'cc2', name: 'BRAVO SECRET CONVERSION', custom_event_type: 'PURCHASE', is_archived: false, pixel: { id: '9002' }, rule: null }],
  };
});

describe('the Events Manager reads are reachable by customers', () => {
  it('both tools are in the customer chat profile', () => {
    expect(toolProfiles.client_media_buyer).toContain('get_pixel_event_stats');
    expect(toolProfiles.client_media_buyer).toContain('get_custom_conversions');
  });
});

describe('the verified scope picks the tenant, never the model', () => {
  it('a model-supplied clientCode cannot redirect the pixel read', async () => {
    const res = await run('get_pixel_event_stats', { clientCode: 'bravo' }, 'alpha');

    expect(res.ad_account_id).toBe('act_1111');
    expect(JSON.stringify(res)).not.toContain('BRAVO_SECRET_EVENT');
    for (const call of state.graphCalls) {
      expect(call.token).toBe('token-for-alpha');
      expect(call.path).not.toContain('act_2222');
    }
  });

  it('a model-supplied clientCode cannot redirect the custom-conversion read', async () => {
    const res = await run('get_custom_conversions', { clientCode: 'bravo' }, 'alpha');

    expect(res.ad_account_id).toBe('act_1111');
    expect(JSON.stringify(res)).not.toContain('BRAVO SECRET CONVERSION');
    expect(res.custom_conversions[0].name).toBe('Qualified Lead');
  });
});

describe('get_pixel_event_stats answers what was actually fired', () => {
  it('sums each event across every hourly bucket', async () => {
    const res = await run('get_pixel_event_stats', { clientCode: 'alpha', days: 7 }, 'alpha');
    const pixel = res.pixels[0];

    expect(pixel.readable).toBe(true);
    expect(pixel.top_events[0]).toEqual({ event: 'QualifiedSubscription', count: 41_999 });
    expect(pixel.benchmark_events.Purchase).toBe(9305);
    // The ratio the answer needs must be derivable from one read.
    expect(pixel.benchmark_events.Purchase).toBeLessThan(pixel.top_events[0].count);
  });

  it('resolves a loosely typed event name to the real one', async () => {
    const res = await run(
      'get_pixel_event_stats',
      { clientCode: 'alpha', event: 'qualified subscription' },
      'alpha',
    );
    const matched = res.pixels[0].matched;

    expect(matched.resolvedFrom).toBe('qualified subscription');
    expect(matched.resolvedTo).toEqual(['QualifiedSubscription']);
    expect(matched.matches[0].count).toBe(41_999);
  });

  it('reaches the real event name across a different word ending', async () => {
    // The question that started this: the customer says "qualified subscriber",
    // the pixel says "QualifiedSubscription". Neither string contains the other.
    const res = await run(
      'get_pixel_event_stats',
      { clientCode: 'alpha', event: 'qualified subscriber' },
      'alpha',
    );
    const matched = res.pixels[0].matched;

    expect(matched.resolvedTo).toEqual(['QualifiedSubscription']);
    expect(matched.matches[0].how).toBe('stem');
    expect(matched.matches[0].count).toBe(41_999);
  });

  it('does not stem-match an unrelated event that shares one word', async () => {
    const res = await run(
      'get_pixel_event_stats',
      { clientCode: 'alpha', event: 'qualified lead' },
      'alpha',
    );
    expect(res.pixels[0].matched.resolvedTo).toBeNull();
  });

  it('says plainly when nothing on the pixel matches the name', async () => {
    const res = await run('get_pixel_event_stats', { clientCode: 'alpha', event: 'newsletter_signup' }, 'alpha');
    const matched = res.pixels[0].matched;

    expect(matched.resolvedTo).toBeNull();
    expect(matched.note).toContain('No event on this pixel matches');
  });

  it('an unmeasured standard event is null, not zero', async () => {
    const res = await run('get_pixel_event_stats', { clientCode: 'alpha' }, 'alpha');
    // Never fired in the fixture: null says "not seen", 0 would be a measurement.
    expect(res.pixels[0].benchmark_events.StartTrial).toBeNull();
    expect(res.pixels[0].benchmark_events.CompleteRegistration).toBe(30);
  });

  it('a refused pixel read is reported as unreadable, never as zero', async () => {
    state.stats['9001'] = { error: 'Facebook API error: (#100) Permission Denied' };
    const res = await run('get_pixel_event_stats', { clientCode: 'alpha' }, 'alpha');
    const pixel = res.pixels[0];

    expect(pixel.readable).toBe(false);
    expect(pixel.error).toContain('Permission Denied');
    expect(pixel.total_events).toBeUndefined();
    expect(pixel.note).toContain('NOT a zero');
  });

  it('an account with no pixel says so as a fact about the account', async () => {
    state.pixels.act_1111 = [];
    const res = await run('get_pixel_event_stats', { clientCode: 'alpha' }, 'alpha');

    expect(res.pixel_count).toBe(0);
    expect(res.note).toContain('No pixel');
    expect(res.note).toContain('not a read failure');
  });

  it('clamps the window to the 1-28 day range Meta will answer', async () => {
    await run('get_pixel_event_stats', { clientCode: 'alpha', days: 400 }, 'alpha');
    const statsCalls = state.graphCalls.filter((c) => c.path.endsWith('/stats'));

    // 28 days walked in 7-day chunks, because Meta refuses a 14-day span.
    expect(statsCalls).toHaveLength(4);
    for (const call of statsCalls) {
      const span = Number(call.params.end_time) - Number(call.params.start_time);
      expect(span).toBeLessThanOrEqual(7 * 86_400);
    }
  });
});

describe('a count is read against the funnel it belongs to', () => {
  /**
   * The 2026-08-25 failure this suite exists for: Ada read QualifiedSubscription
   * at 58,828 against Purchase at 35,018 and called it "good signal density".
   * A subscriber event is a SUBSET of purchases, so out-firing them 1.7x is
   * over-counting, not density. The tool now hands the model the comparison
   * rather than hoping it makes it.
   */
  it('flags an event that out-fires Purchase, with the multiple', async () => {
    const res = await run(
      'get_pixel_event_stats',
      { clientCode: 'alpha', event: 'qualified subscriber' },
      'alpha',
    );
    const check = res.pixels[0].funnelCheck;

    expect(check.event).toBe('QualifiedSubscription');
    expect(check.count).toBe(41_999);
    expect(check.comparedWith).toEqual({ Purchase: 9305, CompleteRegistration: 30 });
    expect(check.timesPurchase).toBe(4.5);
    expect(check.verdict).toBe('higher_than_purchase');
    expect(check.note).toContain('over-counting');
  });

  it('an event below the one above it is simply ok', async () => {
    const res = await run(
      'get_pixel_event_stats',
      { clientCode: 'alpha', event: 'CompleteRegistration' },
      'alpha',
    );
    const check = res.pixels[0].funnelCheck;

    expect(check.event).toBe('CompleteRegistration');
    expect(check.verdict).toBe('ok');
    expect(check.note).toBeUndefined();
    // 30 against 9,305 rounds away to nothing, and "0 times Purchase" would read
    // as a measurement. The two counts are in the payload; the ratio is dropped.
    expect(check.timesPurchase).toBeUndefined();
  });

  it('says there is no Purchase to compare against rather than passing the count', async () => {
    state.stats['9001'] = { buckets: [[{ value: 'QualifiedSubscription', count: 500 }]] };
    const res = await run(
      'get_pixel_event_stats',
      { clientCode: 'alpha', event: 'qualified subscription' },
      'alpha',
    );
    const check = res.pixels[0].funnelCheck;

    expect(check.verdict).toBe('no_purchase_event');
    expect(check.comparedWith).toEqual({});
    expect(check.note).toContain('nothing above it');
  });

  it('no funnel check when the name resolved to nothing', async () => {
    const res = await run(
      'get_pixel_event_stats',
      { clientCode: 'alpha', event: 'newsletter_signup' },
      'alpha',
    );
    expect(res.pixels[0].funnelCheck).toBeUndefined();
  });

  it('no funnel check and no extra read when no event was asked about', async () => {
    const res = await run('get_pixel_event_stats', { clientCode: 'alpha', days: 28 }, 'alpha');

    expect(res.pixels[0].funnelCheck).toBeUndefined();
    expect(state.graphCalls.filter((c) => c.path.endsWith('/stats'))).toHaveLength(4);
  });

  it('reports what share of a long window landed in its last 7 days', async () => {
    const now = Math.floor(Date.now() / 1000);
    const week = 7 * 86_400;
    state.stats['9001'] = {
      byWindow: (from) =>
        from > now - week - 120
          ? [[{ value: 'QualifiedSubscription', count: 30_000 }, { value: 'Purchase', count: 5000 }]]
          : [[{ value: 'QualifiedSubscription', count: 5000 }, { value: 'Purchase', count: 12_000 }]],
    };

    const res = await run(
      'get_pixel_event_stats',
      { clientCode: 'alpha', days: 28, event: 'qualified subscriber' },
      'alpha',
    );
    const check = res.pixels[0].funnelCheck;

    // Three older weeks at 5,000 plus 30,000 in the last one.
    expect(check.count).toBe(45_000);
    expect(check.last7dShare).toBe(0.67);
    expect(check.note).toContain('still ramping');
    // 45,000 against 41,000 purchases: the order is broken here too.
    expect(check.verdict).toBe('higher_than_purchase');
    // The 28 days walked in four chunks, plus the ONE extra read for the week.
    expect(state.graphCalls.filter((c) => c.path.endsWith('/stats'))).toHaveLength(5);
  });

  it('a refused last-week read is a null share, never a zero one', async () => {
    // The 28 days are four chunks; the fifth read is the extra one, and it is
    // the only one refused. A window predicate could not separate it from the
    // final chunk, which covers exactly the same seven days.
    let statsReads = 0;
    state.stats['9001'] = {
      byWindow: () => {
        statsReads += 1;
        return statsReads > 4
          ? { error: 'Facebook API error: (#100) Permission Denied' }
          : [[{ value: 'QualifiedSubscription', count: 5000 }, { value: 'Purchase', count: 12_000 }]];
      },
    };

    const res = await run(
      'get_pixel_event_stats',
      { clientCode: 'alpha', days: 28, event: 'qualified subscriber' },
      'alpha',
    );
    const check = res.pixels[0].funnelCheck;

    expect(check.last7dShare).toBeNull();
    expect(check.note ?? '').not.toContain('ramping');
    // The window itself was still read, so the funnel verdict still stands.
    expect(check.count).toBe(20_000);
    expect(check.verdict).toBe('ok');
  });
});

describe('get_custom_conversions', () => {
  it('returns the rule truncated, with the pixel it belongs to', async () => {
    const res = await run('get_custom_conversions', { clientCode: 'alpha' }, 'alpha');
    const conversion = res.custom_conversions[0];

    expect(conversion.custom_event_type).toBe('LEAD');
    expect(conversion.pixel_id).toBe('9001');
    expect(conversion.rule.length).toBeLessThanOrEqual(164);
    expect(conversion.rule.endsWith('...')).toBe(true);
  });
});
