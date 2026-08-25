import { describe, it, expect } from 'vitest';
import { parseChatPlan, buildScopedChatPrompt } from '../scripts/ada-console-assist.js';

/**
 * The plan block: a BUILD as ONE card the customer approves once.
 *
 * WHY it exists. On 2026-08-25 a founder asked web Ada for a new campaign
 * seeded with her running ad sets and got a chain of cards: approve the create,
 * wait for Meta, come back, approve each copy. Terminal Ada does the whole
 * build on one yes. The plan block is that one yes on the web: every step with
 * every setting, in one fenced block, sequenced by the portal's runner.
 *
 * Three properties are worth pinning rather than trusting:
 *
 *  1. A plan is all or nothing. A step of a type the portal cannot file, a
 *     reference the runner cannot resolve, a size outside the card: each drops
 *     the WHOLE plan, never the step, because a build with one unrunnable step
 *     is a build that stops half way with paused objects nobody asked for.
 *  2. "$step:n" is a promise about an id Meta has not given yet. It may only
 *     name an EARLIER step (the runner resolves it from that step's read-back),
 *     and only in destination_campaign_id, the one slot the runner rewrites.
 *  3. A lone proposal is untouched. parseChatPlan returns null for it, so a
 *     single change still travels as the card it always was.
 */

const CREATE = {
  type: 'create_campaign',
  settings: {
    name: 'BFM // QualifiedSubscription // CBO',
    objective: 'OUTCOME_SALES',
    status: 'PAUSED',
    daily_budget_usd: 200,
    optimization_event: 'QualifiedSubscription',
    pixel_id: '111',
    attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
    attribution_source: 'spend_weighted_account_default',
  },
  choices: [{
    key: 'budget_mode',
    label: 'Where the budget sits',
    options: [{ value: 'cbo', label: 'One budget for the whole campaign' }, { value: 'abo', label: 'A budget on each ad set' }],
    selected: 'cbo',
    why: 'Your Main + Testing campaign runs one budget.',
  }],
  reason: 'A new event needs its own campaign so the learning is not mixed in.',
};

const copy = (id: string, destination = '$step:0') => ({
  type: 'duplicate_ad_set',
  target_id: id,
  target_name: `Ad set ${id}`,
  settings: {
    destination_campaign_id: destination,
    name: `Ad set ${id} // QualifiedSubscription`,
    status: 'PAUSED',
    optimization_goal: 'OFFSITE_CONVERSIONS',
    promoted_object: { pixel_id: '111', custom_event_type: 'OTHER', custom_event_str: 'QualifiedSubscription' },
    attribution_spec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
    source_spend_30d: 1240,
    source_effective_status: 'ACTIVE',
  },
  reason: 'Your best ad set on the old event.',
  warnings: [],
});

const plan = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
  summary: 'New campaign for QualifiedSubscription, seeded with your 2 running ad sets',
  reason: 'The event just started firing and has no campaign optimizing on it.',
  warnings: [],
  steps,
  ...extra,
});

const reply = (block: unknown) =>
  `Here is the whole build on one card.\n\n\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;

describe('parseChatPlan — a build is one block', () => {
  it('parses a create followed by two copies into it', () => {
    const parsed = parseChatPlan(reply({ plan: plan([CREATE, copy('2001'), copy('2002')]) }));
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toContain('QualifiedSubscription');
    expect(parsed!.steps).toHaveLength(3);
    expect(parsed!.steps.map((s) => s.type)).toEqual(['create_campaign', 'duplicate_ad_set', 'duplicate_ad_set']);
    expect(parsed!.steps[1]?.settings?.destination_campaign_id).toBe('$step:0');
    // The create's choices ride on the create, where the card renders them once.
    expect(parsed!.steps[0]?.choices).toHaveLength(1);
  });

  it('accepts a literal destination when the campaign already exists', () => {
    const parsed = parseChatPlan(reply({ plan: plan([copy('2001', '120000'), copy('2002', '120000')]) }));
    expect(parsed?.steps).toHaveLength(2);
  });

  it('reads the LAST fenced block, so a worked example earlier in the reply does not win', () => {
    const text = 'An example:\n```json\n{"plan": {"summary": "x", "steps": []}}\n```\n' + reply({ plan: plan([CREATE]) });
    expect(parseChatPlan(text)?.steps).toHaveLength(1);
  });
});

describe('parseChatPlan — one fault drops the whole plan', () => {
  it('drops a step that references itself', () => {
    expect(parseChatPlan(reply({ plan: plan([CREATE, copy('2001', '$step:1')]) }))).toBeNull();
  });

  it('drops a step that references a later step', () => {
    expect(parseChatPlan(reply({ plan: plan([CREATE, copy('2001', '$step:2'), copy('2002')]) }))).toBeNull();
  });

  it('drops a reference anywhere but destination_campaign_id', () => {
    const misplaced = { ...copy('2001'), settings: { ...copy('2001').settings, name: '$step:0' } };
    expect(parseChatPlan(reply({ plan: plan([CREATE, misplaced]) }))).toBeNull();
    const nested = { ...copy('2001'), settings: { ...copy('2001').settings, promoted_object: { pixel_id: '$step:0' } } };
    expect(parseChatPlan(reply({ plan: plan([CREATE, nested]) }))).toBeNull();
    const onTarget = { ...copy('2001'), target_id: '$step:0' };
    expect(parseChatPlan(reply({ plan: plan([CREATE, onTarget]) }))).toBeNull();
  });

  it('drops a reference the runner could not read', () => {
    expect(parseChatPlan(reply({ plan: plan([CREATE, copy('2001', '$step:zero')]) }))).toBeNull();
    expect(parseChatPlan(reply({ plan: plan([CREATE, copy('2001', '$step:')]) }))).toBeNull();
  });

  it('drops a step of a type the portal cannot file', () => {
    const unknown = { type: 'create_ad_set', target_id: '1', settings: { status: 'PAUSED' } };
    expect(parseChatPlan(reply({ plan: plan([CREATE, unknown]) }))).toBeNull();
    // ...and never salvages the runnable steps around it.
    expect(parseChatPlan(reply({ plan: plan([CREATE, { ...copy('2001'), type: 'delete_ad_set' }, copy('2002')]) }))).toBeNull();
  });

  it('drops zero steps and drops twenty-six', () => {
    expect(parseChatPlan(reply({ plan: plan([]) }))).toBeNull();
    const twentySix = [CREATE, ...Array.from({ length: 25 }, (_, i) => copy(String(3000 + i)))];
    expect(twentySix).toHaveLength(26);
    expect(parseChatPlan(reply({ plan: plan(twentySix) }))).toBeNull();
    const twentyFive = twentySix.slice(0, 25);
    expect(parseChatPlan(reply({ plan: plan(twentyFive) }))?.steps).toHaveLength(25);
  });

  it('drops a plan with two creates', () => {
    expect(parseChatPlan(reply({ plan: plan([CREATE, copy('2001'), CREATE]) }))).toBeNull();
  });

  it('drops a plan that is not an object, has no summary, or has a malformed step', () => {
    expect(parseChatPlan(reply({ plan: [CREATE] }))).toBeNull();
    expect(parseChatPlan(reply({ plan: { steps: [CREATE] } }))).toBeNull();
    expect(parseChatPlan(reply({ plan: plan([CREATE, 'copy the best one']) }))).toBeNull();
    expect(parseChatPlan(reply({ plan: plan([{ ...CREATE, settings: 'mirror existing' }]) }))).toBeNull();
    expect(parseChatPlan(reply({ plan: plan([CREATE], { warnings: 'be careful' }) }))).toBeNull();
  });

  it('does not fall back to an earlier, valid block when the last plan is malformed', () => {
    const text = reply({ plan: plan([CREATE]) }) + reply({ plan: plan([]) });
    expect(parseChatPlan(text)).toBeNull();
  });
});

describe('parseChatPlan — a lone proposal is not a plan', () => {
  it('returns null for a {"proposal": ...} block', () => {
    const proposal = { proposal: { type: 'pause_ad_set', target_id: '2001', target_name: 'Ad set', settings: {}, reason: 'Frequency 4.1.' } };
    expect(parseChatPlan(reply(proposal))).toBeNull();
  });

  it('returns null for prose with no fence, and for a fence that is not json', () => {
    expect(parseChatPlan('Nothing to build here.')).toBeNull();
    expect(parseChatPlan('```json\n{"plan": \n```')).toBeNull();
  });
});

describe('the plan rule on the customer door', () => {
  const req = { question: 'Build a new campaign for QualifiedSubscription with my running ad sets' };
  const prompt = buildScopedChatPrompt(req as never, 'AOTUS');

  it('shows the plan block shape and no longer describes a chain of cards', () => {
    expect(prompt).toContain('{"plan":');
    expect(prompt).toContain('"destination_campaign_id": "$step:0"');
    expect(prompt).not.toContain('A build is a sequence of cards');
  });

  it('keeps the single-change card and the rules that bound every step', () => {
    expect(prompt).toContain('A single change stays a proposal');
    expect(prompt).toContain('never list the steps in words');
    expect(prompt).toContain('**target_id is required on every proposal.**');
    expect(prompt).toContain('You NEVER propose deletes');
    expect(prompt).toContain('a campaign outside the ones opened to you, refuse plainly');
  });
});
