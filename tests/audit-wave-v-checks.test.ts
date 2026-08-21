import { describe, it, expect } from 'vitest';
import {
  buildProvisionalInsights,
  computeBudgetScatter,
  computeFatigue,
  DEAD_ON_ARRIVAL_MIN_DAYS,
  type PackAdRow,
} from '../src/audit/report-pack.js';
import {
  computeAccountActivity,
  computeAudienceSegments,
  computeLaunchDiscipline,
  computePixelHealth,
  computeTargetingSplit,
  computeWhatsWorking,
  MIN_NEW_ADS_PER_MONTH,
  SPEND_PER_NEW_AD,
  type AdSetNamePromise,
  type LaunchAdSpan,
  type PixelLite,
  type SegmentSpendRow,
  type TargetingSpecLite,
} from '../src/audit/report-pack-extra.js';

/**
 * The checks this wave added, and the honesty rule each one exists to keep.
 *
 * They share one shape: a finding is a sentence carrying its own numbers, the
 * basis of any benchmark is stated in the sentence that uses it, and an absence
 * is reported as an absence rather than as a zero.
 */

const day = (offset: number): string => new Date(Date.UTC(2026, 6, 1 + offset)).toISOString().slice(0, 10);

const adRows = (
  adId: string,
  name: string,
  days: number,
  over: Partial<PackAdRow> = {},
  startAt = 0,
): PackAdRow[] =>
  Array.from({ length: days }, (_, i) => ({
    ad_id: adId,
    ad_name: name,
    adset_id: null,
    date: day(startAt + i),
    spend: 500,
    impressions: 8_000,
    purchases: 0,
    purchase_value: 0,
    results: 0,
    frequency: 1.6,
    hook_rate: null,
    hold_rate: null,
    leads: 10,
    ...over,
  }));

// ---------------------------------------------------------------------------

describe('never found traction: the ads the fatigue read cannot see', () => {
  const rows = [
    ...adRows('big', 'workhorse', 30),
    // Six days, under the assessment floor, nothing measured back.
    ...adRows('doa', 'never-got-going', 6, { spend: 20, impressions: 400, leads: 0 }),
    // Three days is impatience, not a verdict.
    ...adRows('young', 'just-launched', 3, { spend: 20, impressions: 400, leads: 0 }),
  ];
  const section = computeFatigue(rows, 1.0, 'USD');

  it('names the ad, its days and its spend, and says it is not fatigue', () => {
    expect(section.data.never_found_traction_count).toBe(1);
    const listed = section.data.never_found_traction as Array<{ ad_name: string; age_days: number; spend: number }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ ad_name: 'never-got-going', age_days: 6, spend: 120 });
    expect(section.summary).toContain('never found traction');
    expect(section.summary).toContain('never got going');
    expect(section.data.assessment_floor).toBe(200);
  });

  it('is too young to call under five days', () => {
    const names = (section.data.never_found_traction as Array<{ ad_name: string }>).map((a) => a.ad_name);
    expect(names).not.toContain('just-launched');
    expect(DEAD_ON_ARRIVAL_MIN_DAYS).toBe(5);
  });

  it('leaves the existing classifier alone: the assessed ad is classified as before', () => {
    const assessed = section.data.ads as Array<{ ad_id: string; class: string }>;
    expect(assessed.map((a) => a.ad_id)).toEqual(['big']);
    expect(computeFatigue(adRows('big', 'workhorse', 30), 1.0, 'USD').data.ads).toEqual(
      (computeFatigue(rows, 1.0, 'USD').data.ads as unknown[]).filter((a) => (a as { ad_id: string }).ad_id === 'big'),
    );
  });

  it('makes the chapter a finding, with an action about the ads it just named', () => {
    expect(section.data.signal).toBe(true);
    expect(section.next_step).toContain('never found traction');
    expect(section.summary).not.toMatch(/—/);
    expect(section.next_step).not.toMatch(/—/);
  });

  it('says nothing at all on an account where every ad cleared the floor', () => {
    const clean = computeFatigue(adRows('big', 'workhorse', 30), 1.0, 'USD');
    expect(clean.data.never_found_traction_count).toBe(0);
    expect(clean.summary).not.toContain('never found traction');
  });
});

describe('watched and not clicked', () => {
  const watchedNotClicked = adRows('vid', 'brand-film', 12, {
    spend: 30,
    impressions: 5_000,
    hook_rate: 0.3,
    link_clicks: 2,
    leads: 0,
  });

  it('names the plays, the clicks and the spend behind them', () => {
    const section = computeFatigue([...adRows('big', 'workhorse', 30), ...watchedNotClicked], 1.0, 'USD');
    expect(section.data.attention_without_action_count).toBe(1);
    const listed = section.data.attention_without_action as Array<Record<string, number | string>>;
    expect(listed[0]).toMatchObject({ ad_name: 'brand-film', video_plays: 18_000, link_clicks: 24, spend: 360 });
    expect(section.summary).toContain('watched and not clicked');
    expect(section.summary).toContain('18,000');
    expect(section.summary).not.toMatch(/—/);
  });

  it('stays silent when the rows carry no click count at all', () => {
    // undefined means unread, never zero: on a warehouse pull every ad would
    // otherwise report as watched and never clicked.
    const noClicks = watchedNotClicked.map(({ link_clicks: _dropped, ...rest }) => rest);
    const section = computeFatigue([...adRows('big', 'workhorse', 30), ...noClicks], 1.0, 'USD');
    expect(section.data.attention_without_action_count).toBe(0);
    expect(section.summary).not.toContain('watched and not clicked');
  });

  it('leaves an ad people did click alone', () => {
    const clicked = adRows('vid', 'performing-film', 12, {
      spend: 30,
      impressions: 5_000,
      hook_rate: 0.3,
      link_clicks: 60,
      leads: 2,
    });
    const section = computeFatigue([...adRows('big', 'workhorse', 30), ...clicked], 1.0, 'USD');
    expect(section.data.attention_without_action_count).toBe(0);
  });
});

describe('the underfunded winner rides the scatter own verdict', () => {
  // One heavy dear ad and one small cheap one: the chart circles the second.
  const rows = [
    ...adRows('heavy', 'dear-ad', 30, { spend: 300, leads: 5 }),
    ...adRows('starved', 'cheap-ad', 30, { spend: 60, leads: 8 }),
  ];
  // The owner stated a target, which is what makes the chart's line readable and
  // lets it circle anything at all.
  const scatter = computeBudgetScatter(rows, [], 1.0, 'USD', null, {
    resultNoun: 'lead',
    costTarget: { metric: 'cpl', value: 40 },
  });

  it('names the ad the chart starred, with its cost and its share of the spend', () => {
    expect(scatter.data.starved_best_ad).toBe('cheap-ad');
    const insights = buildProvisionalInsights([], undefined, undefined, scatter.data as never);
    const starved = insights.find((i) => i.section === 'budget_scatter');
    expect(starved).toBeDefined();
    expect(starved!.headline).toContain('cheap-ad');
    expect(starved!.headline).toMatch(/\d/);
    expect(starved!.severity).toBe('opportunity');
    expect(starved!.detail).toMatch(/\d/);
    expect(starved!.headline).not.toMatch(/—/);
  });

  it('says nothing when the chart circled nothing', () => {
    const flat = computeBudgetScatter(
      [...adRows('a', 'one', 30, { spend: 200, leads: 10 }), ...adRows('b', 'two', 30, { spend: 200, leads: 10 })],
      [],
      1.0,
      'USD',
      null,
      { resultNoun: 'lead' },
    );
    expect(flat.data.starved_best_ad).toBeUndefined();
    expect(buildProvisionalInsights([], undefined, undefined, flat.data as never)).toEqual([]);
  });
});

describe('the protect list states the base rate where it matters', () => {
  it('an empty protect list says how many tests a winner takes, and whose rate that is', () => {
    const section = computeWhatsWorking(undefined, undefined, [], 'USD');
    expect(section.summary).toContain('one ad in twenty');
    expect(section.summary).toContain('not a measurement of your account');
    expect(section.next_step).toContain('twenty');
    expect(section.summary).not.toMatch(/—/);
    expect(section.next_step).not.toMatch(/—/);
  });

  it('a list with a winner on it does not lecture about base rates', () => {
    const section = computeWhatsWorking(
      { kpi_mode: 'cpr', ads: [{ ad_name: 'evergreen-1', spend_30d: 4_000, class: 'evergreen', in_window_age_days: 90, cpl_first_half: 18, cpl_last_14: 19 }] },
      undefined,
      [],
      'USD',
    );
    expect(section.summary).not.toContain('one ad in twenty');
  });
});

describe('audience segments', () => {
  const rows = (entries: Array<[string, number, number]>): SegmentSpendRow[] =>
    entries.map(([key, spend, leads]) => ({ key, spend, impressions: spend * 50, purchases: 0, purchase_value: 0, leads }));

  it('an all-unknown split is the absence of defined audiences, not a share of anything', () => {
    const section = computeAudienceSegments({ rows: rows([['unknown', 4_000, 80]]), currency: 'USD', windowDays: 30 });
    expect(section.data.segments_defined).toBe(false);
    expect(section.summary).toContain('no engaged or existing audiences defined');
    expect(section.summary).toContain('Most accounts never set these up');
    expect(section.data.signal).toBe(true);
  });

  it('the fix is the owner defining them, and nothing here promises we will', () => {
    const section = computeAudienceSegments({ rows: rows([['unknown', 4_000, 80]]), currency: 'USD', windowDays: 30 });
    expect(section.next_step).toContain('Define the two audiences');
    // A write is not on offer: the section may say what to define, never that
    // Ada will go and build it.
    expect(`${section.summary} ${section.next_step}`).not.toMatch(/\b(we|Ada|I) (will|can) (create|build|set up)\b/i);
  });

  it('real keys get the share sentence, in the grammar a reader can check', () => {
    const section = computeAudienceSegments({
      rows: rows([['New Audience', 8_000, 100], ['Engaged Audience', 2_000, 40]]),
      currency: 'USD',
      windowDays: 30,
    });
    expect(section.summary).toContain('80% of the spend');
    expect(section.summary).toContain('people who have never heard of you');
    expect(section.summary).toContain('8,000 USD of 10,000 USD');
    expect(section.data.new_audience_spend_share_pct).toBe(80);
    expect(section.data.segments_defined).toBe(true);
  });

  it('nothing running against the people who already know you IS the finding', () => {
    const section = computeAudienceSegments({
      rows: rows([['New Audience', 9_000, 100], ['other_key', 1_000, 5]]),
      currency: 'USD',
      windowDays: 30,
    });
    expect(section.data.known_audience_spend_share_pct).toBe(0);
    expect(section.summary).toContain('Nothing at all went to people who already know you');
    expect(section.data.signal).toBe(true);
    expect(section.next_step).toContain('one small ad set');
  });

  it('a window that had to be widened says so in the sentence that quotes it', () => {
    const section = computeAudienceSegments({
      rows: rows([['New Audience', 5_000, 50]]),
      currency: 'USD',
      windowDays: 31,
      widened: true,
    });
    expect(section.summary).toContain('the last 31 days this account actually spent in');
    expect(section.data.widened).toBe(true);
  });

  it('thin delivery is suppressed rather than guessed at, and stays quiet', () => {
    const section = computeAudienceSegments({ rows: rows([['New Audience', 40, 1]]), currency: 'USD', windowDays: 30 });
    expect(section.data.signal).toBe(false);
    expect(section.next_step).toBeUndefined();
    expect(section.warnings?.[0]).toContain('suppressed');
  });

  it('carries no em-dashes anywhere it can be read', () => {
    for (const section of [
      computeAudienceSegments({ rows: rows([['unknown', 4_000, 80]]), currency: 'USD', windowDays: 30 }),
      computeAudienceSegments({ rows: rows([['New Audience', 8_000, 100], ['Existing Customers', 2_000, 40]]), currency: 'USD', windowDays: 30 }),
    ]) {
      expect(JSON.stringify(section)).not.toMatch(/—/);
    }
  });
});

describe('pixel health', () => {
  const pixel = (over: Partial<PixelLite> = {}): PixelLite => ({
    id: 'px_1',
    name: 'Main pixel',
    last_fired_time: '2026-08-22T08:00:00Z',
    automatic_matching_enabled: true,
    automatic_matching_fields: ['em', 'ph'],
    match_rate_approx: null,
    diagnostics: [{ key: 'installed', title: 'Pixel installed', result: 'passed' }],
    ...over,
  });
  const asOf = '2026-08-22';

  it('an account Meta lists no pixel for is told so plainly', () => {
    const section = computePixelHealth({ pixels: [], asOf });
    expect(section.summary).toContain('no pixel on this ad account');
    expect(section.data.signal).toBe(true);
    expect(section.next_step).toContain('Events Manager');
  });

  it('reports Advanced Matching, its field count and the last event', () => {
    const section = computePixelHealth({ pixels: [pixel()], asOf });
    expect(section.summary).toContain('Advanced Matching is on and sending 2 customer fields');
    expect(section.summary).toContain('em, ph');
    expect(section.summary).toContain('last received an event today');
    expect(section.data.signal).toBe(false);
  });

  it('matching switched off is a finding with a settings action under it', () => {
    const section = computePixelHealth({ pixels: [pixel({ automatic_matching_enabled: false, automatic_matching_fields: [] })], asOf });
    expect(section.summary).toContain('Advanced Matching is off');
    expect(section.data.signal).toBe(true);
    expect(section.next_step).toContain('Turn Advanced Matching on');
  });

  it('a flag Meta did not set claims neither way', () => {
    const section = computePixelHealth({ pixels: [pixel({ automatic_matching_enabled: null })], asOf });
    expect(section.summary).toContain('did not say whether Advanced Matching is on');
  });

  it('quotes a failing check BY NAME, in Meta own result word', () => {
    const section = computePixelHealth({
      pixels: [pixel({ diagnostics: [{ key: 'unverified_domain', title: 'Verify your domain', result: 'failed' }] })],
      asOf,
    });
    expect(section.summary).toContain('"Verify your domain" (failed)');
    expect(section.summary).toContain("Meta's words");
    expect(section.next_step).toContain('Verify your domain');
  });

  it('never mentions a rate nobody measured, and states one that was', () => {
    expect(computePixelHealth({ pixels: [pixel()], asOf }).summary).not.toMatch(/match rate/i);
    const measured = computePixelHealth({ pixels: [pixel({ match_rate_approx: 0.62 })], asOf });
    expect(measured.summary).toContain('approximate match rate at 62%');
  });

  it('invents no score of its own', () => {
    const section = computePixelHealth({ pixels: [pixel()], asOf });
    expect(section.data.match_quality_score).toBeNull();
    expect(section.summary).not.toMatch(/\b(score|grade|out of 10|health score)\b/i);
    expect(section.derivation).toContain('no match-quality score');
  });

  it('a pixel nothing has reached in a week says how long it has been quiet', () => {
    const section = computePixelHealth({ pixels: [pixel({ last_fired_time: '2026-08-01T08:00:00Z' })], asOf });
    expect(section.summary).toContain('last received an event 21 days ago');
    expect(section.next_step).toContain('21 days');
    expect(section.data.signal).toBe(true);
  });

  it('a pixel with no last-fired time on record claims no recency', () => {
    const section = computePixelHealth({ pixels: [pixel({ last_fired_time: null })], asOf });
    expect(section.summary).toContain('no last-fired time');
    expect(JSON.stringify(section)).not.toMatch(/—/);
  });
});

describe('launching and testing', () => {
  const months = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
  const monthlySpend = months.map((month) => ({ month, spend: 6_000 }));
  const ad = (id: string, month: string, spend: number, last = `${month}-20`): LaunchAdSpan => ({
    ad_id: id,
    ad_name: `ad-${id}`,
    spend,
    first_spend_date: `${month}-05`,
    last_spend_date: last,
  });
  const inputs = {
    ads: [
      // Three "launches" in the read's first month, which are really the ads
      // that were already running when the window opened.
      ad('old1', '2026-03', 5_000), ad('old2', '2026-03', 5_000), ad('old3', '2026-03', 5_000),
      ad('a', '2026-04', 4_000),
      ad('b', '2026-06', 3_000), ad('c', '2026-06', 90), ad('d', '2026-06', 60),
      ad('e', '2026-07', 2_000),
      ad('f', '2026-08', 1_000, '2026-08-30'),
    ],
    monthlySpend,
    anchorDate: '2026-08-30',
    currency: 'USD',
    costTarget: { metric: 'cpl', value: 40 },
    resultNoun: 'lead',
  };
  const section = computeLaunchDiscipline(inputs);

  it('counts launches by first spending day and drops the left-censored first month', () => {
    expect(section.data.months_judged).toBe(5);
    expect(section.data.launched_total).toBe(6);
    const rows = section.data.months as Array<{ month: string; launched: number }>;
    expect(rows.map((r) => r.month)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
    expect(section.derivation).toContain("read's first month is left out");
  });

  it('states the expectation and where the number comes from', () => {
    expect(section.data.expected_per_month).toBe(2);
    expect(SPEND_PER_NEW_AD).toBe(3_000);
    expect(MIN_NEW_ADS_PER_MONTH).toBe(2);
    expect(section.summary).toContain('one new ad per 3,000 USD of monthly spend');
    expect(section.summary).toContain('the rate this desk plans to, not a measurement of your account');
    expect(section.data.signal).toBe(true);
  });

  it('counts the ads that stopped before a fair test, against the owner own target', () => {
    expect(section.data.fair_test_bar).toBe(120);
    expect(section.data.ads_without_fair_test).toBe(2);
    expect(section.summary).toContain('2 ads never got a fair test');
    expect(section.summary).toContain('120 USD');
    expect(section.summary).toContain('3 times the 40 USD per lead you told us you want');
  });

  it('claims no fair-test bar when the owner stated no target', () => {
    const noTarget = computeLaunchDiscipline({ ...inputs, costTarget: null });
    expect(noTarget.data.fair_test_bar).toBeNull();
    expect(noTarget.data.ads_without_fair_test).toBe(0);
    expect(noTarget.summary).not.toContain('fair test');
    expect(noTarget.derivation).toContain('no fair-test bar is claimed');
  });

  it('an ad still spending on the last day has not stopped, so it is not counted', () => {
    const stillRunning = computeLaunchDiscipline({
      ...inputs,
      ads: [ad('g', '2026-07', 50, '2026-08-30')],
    });
    expect(stillRunning.data.ads_without_fair_test).toBe(0);
  });

  it('a cadence needs months: two of them are not a rhythm', () => {
    const short = computeLaunchDiscipline({ ...inputs, monthlySpend: monthlySpend.slice(0, 2) });
    expect(short.data.signal).toBe(false);
    expect(short.next_step).toBeUndefined();
    expect(short.summary).toContain('too few months');
  });

  it('a healthy cadence reads clean and asks for nothing', () => {
    const healthy = computeLaunchDiscipline({
      ...inputs,
      ads: months.flatMap((month, i) => [ad(`x${i}`, month, 4_000), ad(`y${i}`, month, 4_000), ad(`z${i}`, month, 4_000)]),
      costTarget: null,
    });
    expect(healthy.data.months_below_expectation).toBe(0);
    expect(healthy.data.signal).toBe(false);
    expect(healthy.next_step).toBeUndefined();
  });

  it('carries no em-dashes', () => {
    expect(JSON.stringify(section)).not.toMatch(/—/);
  });
});

describe('the ad set name promise, inside the targeting split', () => {
  const specs: TargetingSpecLite[] = [
    { adset_id: 'as_1', adset_name: 'LAL 1% purchasers', effective_status: null, advantage_audience: false, has_custom_audiences: false, has_lookalikes: false, has_interests: false, age_min: null, age_max: null, genders: null },
    { adset_id: 'as_2', adset_name: 'Broad ABO', effective_status: null, advantage_audience: false, has_custom_audiences: false, has_lookalikes: false, has_interests: false, age_min: null, age_max: null, genders: null },
  ];
  const spend = new Map([['as_1', 4_000], ['as_2', 6_000]]);
  const kpi = new Map([['as_1', { value: 0, results: 100 }], ['as_2', { value: 0, results: 200 }]]);
  const rows = adRows('a', 'x', 30);
  const promises: AdSetNamePromise[] = [
    { adset_id: 'as_1', adset_name: 'LAL 1% purchasers', claim: 'a lookalike', targeting_class: 'broad', detail: '"LAL 1% purchasers" reads as a lookalike, and its live targeting holds no audience and no interests at all.' },
  ];

  it('reports the mismatch, makes the chapter a finding and asks for one thing', () => {
    const section = computeTargetingSplit(specs, spend, kpi, rows, 'USD', promises);
    expect(section.summary).toContain('1 of 2 spending ad sets carries a name that does not describe its targeting');
    expect(section.warnings?.join(' ')).toContain('LAL 1% purchasers');
    expect(section.data.signal).toBe(true);
    expect(section.next_step).toContain('LAL 1% purchasers');
    expect(section.data.name_promises).toHaveLength(1);
    expect(section.derivation).toContain("ad set's NAME was then read against");
  });

  it('ignores a mismatch on an ad set with no spend: nobody needs that label fixed', () => {
    const section = computeTargetingSplit(
      specs,
      new Map([['as_2', 6_000]]),
      kpi,
      rows,
      'USD',
      promises,
    );
    expect(section.data.name_promises).toEqual([]);
    expect(section.summary).not.toContain('does not describe');
  });

  it('a caller with no name check produces exactly the section it always did', () => {
    const withoutParam = computeTargetingSplit(specs, spend, kpi, rows, 'USD');
    const withEmpty = computeTargetingSplit(specs, spend, kpi, rows, 'USD', []);
    expect(withEmpty.summary).toBe(withoutParam.summary);
    expect(withEmpty.derivation).toBe(withoutParam.derivation);
    expect(withoutParam.data.name_promises_checked).toBeUndefined();
    expect(JSON.stringify(withoutParam)).not.toMatch(/—/);
  });
});

describe('a change history with no actor on it claims no who', () => {
  const events = [
    { event_type: 'update_ad_run_status', event_time: '2026-08-20T09:00:00Z', actor_id: null, actor_name: null, application_id: null, application_name: null, object_type: 'AD' },
    { event_type: 'update_ad_set_budget', event_time: '2026-08-19T09:00:00Z', actor_id: null, actor_name: null, application_id: null, application_name: null, object_type: 'AD_SET' },
  ];

  it('says out loud that the rows carried no person or tool', () => {
    const section = computeAccountActivity({ events, currency: 'USD', monthlyRetainer: null, asOf: '2026-08-22', windowDays: 90, actorsAvailable: false });
    expect(section.warnings?.join(' ')).toContain('without the person or tool behind each change');
    expect(section.data.actor_attribution_available).toBe(false);
    expect(section.data.by_actor).toEqual([]);
    expect(section.summary).not.toMatch(/Unattributed/);
    expect(section.derivation).toContain('nothing here is attributed to a person or a tool');
  });

  it('a source that DOES carry actors is unchanged', () => {
    const withActor = computeAccountActivity({
      events: [{ ...events[0]!, actor_id: '42', actor_name: 'Sam' }],
      currency: 'USD',
      monthlyRetainer: null,
      asOf: '2026-08-22',
      windowDays: 90,
    });
    expect(withActor.data.actor_attribution_available).toBe(true);
    expect(withActor.summary).toContain('Sam');
  });
});
