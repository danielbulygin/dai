import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The onRowUpdate seam (AuditOptions) exists for one caller: the Tinkers
 * bridge, whose report lives in another database. The invariant it must never
 * break is that the audit itself does not notice it. This runs the SAME cold
 * audit twice — once without the option, once with — and asserts the sequence
 * of writes to magic_audits is identical, byte for byte.
 *
 * Everything the audit reaches for outside itself (Anthropic, the Graph, the
 * tool registry) is refused here, so the run is the deterministic tier plus
 * honest section errors — enough to exercise every updateRow call site.
 */

const { state, stamp } = vi.hoisted(() => ({
  state: { updates: [] as string[] },
  // Two runs of the same audit differ only in their clock — normalize it away
  // so the comparison is about behavior.
  stamp: (json: string): string => json.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>'),
}));

vi.mock('../src/integrations/supabase.js', () => ({
  getSupabase: () => ({
    from: () => {
      const q = {
        insert: () => q,
        update: (patch: Record<string, unknown>) => {
          const { updated_at: _at, ...rest } = patch;
          state.updates.push(stamp(JSON.stringify(rest)));
          return q;
        },
        select: () => q,
        eq: async () => ({ data: null, error: null }),
        gte: () => q,
        order: () => q,
        limit: () => q,
        range: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: { id: 'audit-row-1' }, error: null }),
      };
      return q;
    },
  }),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      stream: () => ({
        finalMessage: async () => {
          throw new Error('anthropic refused in test');
        },
      }),
    };
  },
}));

vi.mock('../src/agents/tool-registry.js', () => ({
  executeTool: async () => {
    throw new Error('tools refused in test');
  },
}));

vi.mock('../src/audit/cold-creative.js', () => ({
  runColdCreativeAnalysis: async () => {
    throw new Error('creative analysis refused in test');
  },
}));

vi.stubGlobal('fetch', async () => {
  throw new Error('network refused in test');
});

import { buildColdRows } from '../src/audit/cold-source.js';
import { runMagicAudit, type ColdInjection } from '../src/audit/magic-audit.js';

const day = (n: number): string => new Date(Date.UTC(2026, 6, n)).toISOString().slice(0, 10);

const rows = buildColdRows({
  adDays: [1, 2, 3, 4, 5].map((n) => ({
    ad_id: `ad_${n % 2}`,
    ad_name: `Ad ${n % 2}`,
    adset_id: 'adset_1',
    date_start: day(n),
    spend: 100 + n,
    impressions: 10_000 + n,
    clicks: 100,
    frequency: 1.2,
    actions: [{ action_type: 'purchase', value: '3' }],
    action_values: [{ action_type: 'purchase', value: '900' }],
  })),
  asOf: day(6),
});

const cold = (): ColdInjection => ({
  userId: 'org_1',
  accessToken: 'EAA-test-token',
  adAccountId: 'act_1',
  accountName: 'Acme',
  currency: 'EUR',
  rows,
  goalMetric: 'roas',
  goalValue: 2,
  grossMarginPct: 45,
});

beforeEach(() => {
  state.updates.length = 0;
});

describe('AuditOptions.onRowUpdate', () => {
  it('shares the focused budget read across learning, activity and root cause even when the general log fails', async () => {
    const activityQueries: Array<{ since: string; until: string; category?: 'budget' }> = [];
    const today = new Date().toISOString().slice(0, 10);
    const changes = [
      { at: `${today}T01:00:00Z`, fromBudget: 100, toBudget: 200 },
      { at: `${today}T02:00:00Z`, fromBudget: 200, toBudget: 100 },
      { at: `${today}T03:00:00Z`, fromBudget: 100, toBudget: 300 },
    ].map((row, i) => ({ ...row, key: `budget_${i}`, objectId: 'adset_1', objectName: 'Broad', kind: row.toBudget > row.fromBudget ? 'budget_increased' : 'budget_decreased' }));
    let final: Record<string, unknown> = {};
    await runMagicAudit('', {
      cold: { ...cold(), accessToken: '', seam: {
        adSets: async () => ({ state: 'ok', partial: false, data: [{ adsetId: 'adset_1', name: 'Broad', effectiveStatus: 'ACTIVE', optimizationGoal: 'OFFSITE_CONVERSIONS', promotedObjectEventType: 'PURCHASE', campaignId: 'campaign_1' }] }),
        adSetInsights: async () => ({ state: 'ok', data: [], partial: false }),
        breakdown: async () => ({ state: 'ok', data: [], partial: false }),
        activity: async (query) => {
          activityQueries.push(query);
          return query.category === 'budget'
            ? { state: 'ok', partial: false, data: query.until === today ? changes : [] }
            : { state: 'failed', reason: 'general history timed out' };
        },
        targeting: async () => ({ state: 'ok', partial: false, data: { adSets: [], audiences: [] } }),
        pixels: async () => ({ state: 'ok', partial: false, data: [] }),
      } },
      maxCostUsd: 0,
      onRowUpdate: (patch, meta) => { if (meta.final) final = patch; },
    });
    expect(activityQueries.filter((query) => query.category === 'budget')).toHaveLength(3);
    const sections = final.sections as Record<string, { status: string; data: Record<string, unknown>; summary: string }>;
    for (const name of ['learning_limited', 'account_activity']) {
      expect(sections[name]).toMatchObject({ status: 'complete', data: { signal: true, budget_history: { total_edits: 3, signal: true, learning_resets_confirmed: null } } });
    }
    expect(sections.account_activity!.summary).toContain('3 budget edits');
  }, 60_000);

  it('changes nothing about the run when absent, and mirrors every patch when present', async () => {
    await runMagicAudit('', { cold: cold(), maxCostUsd: 0 });
    const withoutOption = [...state.updates];
    expect(withoutOption.length).toBeGreaterThan(0);

    state.updates.length = 0;
    const mirrored: Array<{ patch: Record<string, unknown>; final: boolean }> = [];
    await runMagicAudit('', {
      cold: cold(),
      maxCostUsd: 0,
      onRowUpdate: (patch, { final }) => {
        mirrored.push({ patch: JSON.parse(JSON.stringify(patch)) as Record<string, unknown>, final });
      },
    });

    expect(state.updates).toEqual(withoutOption);


    // One mirror per row write, plus the single final call carrying the whole row.
    const progressive = mirrored.filter((m) => !m.final);
    const finals = mirrored.filter((m) => m.final);
    expect(progressive).toHaveLength(state.updates.length);
    expect(progressive.map((m) => stamp(JSON.stringify(m.patch)))).toEqual(state.updates);
    expect(finals).toHaveLength(1);
    expect(Object.keys(finals[0]!.patch)).toEqual([
      'sections',
      'recognition',
      'work_log',
      'cost_usd',
      'scorecard',
      'lead_insights',
      'status',
    ]);
  }, 60_000);

  it('hands over our raw snake_case column names — the shapes the bridge must map', async () => {
    const mirrored: Array<Record<string, unknown>> = [];
    await runMagicAudit('', {
      cold: cold(),
      maxCostUsd: 0,
      onRowUpdate: (patch, { final }) => {
        if (!final) mirrored.push(patch);
      },
    });

    // Every distinct patch shape the orchestrator emits. The Tinkers bridge
    // fixture in tests/tinkers-bridge.test.ts mirrors this list — if a new
    // column shows up here, that fixture (and toTinkersPatch) needs it too,
    // or the key silently vanishes at the far end of the seam.
    const shapes = [...new Set(mirrored.map((p) => Object.keys(p).join(',')))].sort();
    expect(shapes).toEqual([
      'lead_insights',
      'recognition',
      'scorecard',
      'sections,cost_usd',
      'status,cost_usd',
      'work_log',
    ]);
  }, 60_000);

  it('survives a mirror that throws or rejects — the audit still completes', async () => {
    await expect(
      runMagicAudit('', {
        cold: cold(),
        maxCostUsd: 0,
        onRowUpdate: (_patch, { final }) => {
          if (final) throw new Error('report exploded');
          return Promise.reject(new Error('report exploded'));
        },
      }),
    ).resolves.toMatchObject({ auditId: 'audit-row-1' });
  }, 60_000);
});
