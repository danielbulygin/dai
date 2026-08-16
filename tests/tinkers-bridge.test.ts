import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The Tinkers monorepo seam: HMAC signing, the context contract (including the
 * ok:false refusals), snake_case → camelCase patch mapping, and the rule that
 * makes the whole thing safe to run — the access token never reaches a log.
 */

const { state } = vi.hoisted(() => ({
  state: {
    baseUrl: 'https://tinkers.test' as string | undefined,
    secret: 'seam-secret' as string | undefined,
    calls: [] as Array<{ url: string; signature: string | null; body: string }>,
    responses: [] as Array<{ status?: number; json?: unknown; throws?: Error }>,
    logs: [] as string[],
    // The real column patches magic-audit writes, in the order it writes them
    // (copied from a run of tests/magic-audit-row-mirror.test.ts).
    orchestratorPatches: [] as Array<Record<string, unknown>>,
    finalRowState: {} as Record<string, unknown>,
    /** Set to a pending promise to hold a run open (concurrency tests). */
    holdRun: undefined as Promise<void> | undefined,
  },
}));

vi.mock('../src/env.js', () => ({
  env: new Proxy(
    {},
    {
      get: (_, k) => {
        if (k === 'TINKERS_BASE_URL') return state.baseUrl;
        if (k === 'TINKERS_AUDIT_SEAM_SECRET') return state.secret;
        if (k === 'LOG_LEVEL') return 'silent';
        // Everything else stays real: this module's import chain reaches the
        // tool registry, which boots the Slack app off env at import time.
        return process.env[k as string];
      },
    },
  ),
}));

vi.mock('../src/utils/logger.js', () => {
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      state.logs.push(`${level} ${args.map((a) => JSON.stringify(a)).join(' ')}`);
  return { logger: { info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') } };
});

// The audit machinery is stubbed down to the one thing this file is about: the
// patches the orchestrator hands the bridge, and what leaves the wire for each.
vi.mock('../src/audit/cold-fetch.js', () => ({
  fetchAccountMeta: async () => ({ name: 'Acme', currency: 'EUR' }),
  fetchColdAdDays: async () => ({ adDays: [], truncated: false, failedSlices: 0 }),
  resolveDestinations: async () => ({}),
}));

vi.mock('../src/audit/cold-source.js', () => ({
  buildColdRows: () => ({ packRows90: [], packRows180: [], packAccRows90: [], accFull30: [], landing30: [], rowCount: 7, daysCovered: 3 }),
}));

vi.mock('../src/audit/magic-audit.js', () => ({
  runMagicAudit: async (_code: string, options: { onRowUpdate?: (p: Record<string, unknown>, m: { final: boolean }) => void | Promise<void> }) => {
    if (state.holdRun) await state.holdRun;
    for (const patch of state.orchestratorPatches) await options.onRowUpdate?.(patch, { final: false });
    await options.onRowUpdate?.(state.finalRowState, { final: true });
    return { auditId: 'dai-audit-1', token: 'tok', costUsd: 4.5 };
  },
}));

vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string>; body: string }) => {
  state.calls.push({
    url: String(url),
    signature: init.headers['x-tinkers-signature-256'] ?? null,
    body: init.body,
  });
  const next = state.responses.shift() ?? { json: { ok: false, reason: 'not_configured' } };
  if (next.throws) throw next.throws;
  const status = next.status ?? 200;
  return { ok: status >= 200 && status < 300, status, json: async () => next.json } as unknown as Response;
});

import { runBridgedColdAudit } from '../src/audit/tinkers-bridge.js';
import {
  fetchAuditContext,
  hasReportContent,
  isTinkersSeamConfigured,
  redactSecrets,
  reportAuditFinalize,
  reportAuditUpdate,
  signRequest,
  toTinkersPatch,
} from '../src/audit/tinkers-bridge.js';

const okContext = {
  ok: true,
  auditId: 'aud_1',
  adAccountId: 'act_123',
  accessToken: 'EAA-super-secret-token',
  currency: 'EUR',
  accountName: 'Acme',
  goalMetric: 'roas',
  goalValue: 2.5,
  grossMarginPct: 45,
};

beforeEach(() => {
  state.baseUrl = 'https://tinkers.test';
  state.secret = 'seam-secret';
  state.calls.length = 0;
  state.responses.length = 0;
  state.logs.length = 0;
  state.holdRun = undefined;
  state.orchestratorPatches = [
    { recognition: { ads_count: 12 }, updated_at: 'ts' },
    { work_log: [{ at: 'ts', line: 'Read 12 ads' }] },
    { sections: { creative_fatigue: { status: 'complete' } }, cost_usd: 0 },
    { scorecard: [{ key: 'hooks', band: 'weak' }] },
    { lead_insights: [{ headline: 'Top ad is fatiguing' }] },
    { status: 'complete', cost_usd: 4.5 },
  ];
  state.finalRowState = {
    sections: { creative_fatigue: { status: 'complete' } },
    recognition: { ads_count: 12 },
    work_log: [{ at: 'ts', line: 'Read 12 ads' }],
    scorecard: [{ key: 'hooks', band: 'weak' }],
    lead_insights: [{ headline: 'Top ad is fatiguing' }],
    cost_usd: 4.5,
    status: 'complete',
  };
});

describe('signRequest', () => {
  it('is the hex HMAC-SHA256 of the exact body bytes', () => {
    expect(signRequest('{"organizationId":"org_1"}', 'seam-secret')).toBe(
      '5b8c36ecc5ad22ac3da97c819ce7c8f39097491de30fcbf71c742d7aed9f60cf',
    );
  });

  it('changes with the body and with the secret', () => {
    const base = signRequest('{"a":1}', 's1');
    expect(signRequest('{"a":2}', 's1')).not.toBe(base);
    expect(signRequest('{"a":1}', 's2')).not.toBe(base);
  });
});

describe('isTinkersSeamConfigured', () => {
  it('needs both halves', () => {
    expect(isTinkersSeamConfigured()).toBe(true);
    state.secret = undefined;
    expect(isTinkersSeamConfigured()).toBe(false);
    state.secret = 'seam-secret';
    state.baseUrl = undefined;
    expect(isTinkersSeamConfigured()).toBe(false);
  });
});

describe('fetchAuditContext', () => {
  it('signs the body it actually sends, to the contract path', async () => {
    state.responses.push({ json: okContext });
    await fetchAuditContext('org_1');

    const call = state.calls[0]!;
    expect(call.url).toBe('https://tinkers.test/api/webhooks/audit-context');
    expect(call.body).toBe('{"organizationId":"org_1"}');
    expect(call.signature).toBe(signRequest(call.body, 'seam-secret'));
  });

  it('returns the refusal as data (never throws on ok:false)', async () => {
    state.responses.push({ json: { ok: false, reason: 'no_connection' } });
    await expect(fetchAuditContext('org_1')).resolves.toEqual({ ok: false, reason: 'no_connection' });
  });

  it('throws on a non-2xx answer and on a response off-contract', async () => {
    state.responses.push({ status: 500, json: {} });
    await expect(fetchAuditContext('org_1')).rejects.toThrow('500');

    state.responses.push({ json: { ok: true, auditId: 'aud_1' } });
    await expect(fetchAuditContext('org_1')).rejects.toThrow('contract');
  });

  it('throws when the seam is not configured', async () => {
    state.secret = undefined;
    await expect(fetchAuditContext('org_1')).rejects.toThrow('not configured');
    expect(state.calls).toHaveLength(0);
  });
});

describe('reportAuditUpdate', () => {
  it('sends every content payload as a partial, and seals with a contentless finalize', async () => {
    state.responses.push({ json: { received: true, recorded: true } });
    await reportAuditUpdate('aud_1', { costUsd: 1.5 });
    expect(JSON.parse(state.calls[0]!.body)).toEqual({ auditId: 'aud_1', partial: true, costUsd: 1.5 });
    expect(state.calls[0]!.url).toBe('https://tinkers.test/api/webhooks/audit-complete');

    // The finalize call stays tiny no matter how fat the report got — that is
    // the whole point of splitting it off the last content payload.
    state.responses.push({ json: { received: true, recorded: true } });
    await reportAuditFinalize('aud_1');
    expect(JSON.parse(state.calls[1]!.body)).toEqual({ auditId: 'aud_1', finalize: true });
    expect(state.calls[1]!.body.length).toBeLessThan(64);
  });

  it('is fail-soft: a transport failure warns instead of throwing', async () => {
    state.responses.push({ throws: new Error('socket hang up') });
    await expect(reportAuditUpdate('aud_1', { costUsd: 1 })).resolves.toBeUndefined();
    expect(state.logs.some((l) => l.startsWith('warn'))).toBe(true);
  });

  it('warns (but does not retry) when Tinkers received without recording', async () => {
    state.responses.push({ json: { received: true, recorded: false } });
    await reportAuditUpdate('aud_1', { costUsd: 1 });
    expect(state.calls).toHaveLength(1);
    expect(state.logs.some((l) => l.includes('not recorded'))).toBe(true);
  });

  it('never lets an unrecorded FINAL report read as a failed audit', async () => {
    // Tinkers only accepts content writes while the audit is RUNNING, so a
    // finalize that timed out here but landed there answers recorded:false on
    // the retry — with the audit complete and its email already sent.
    state.responses.push({ json: { received: true, recorded: false } });
    await reportAuditFinalize('aud_1');

    const line = state.logs.find((l) => l.includes('not recorded'))!;
    expect(line).toContain('audit may already be sealed');
    expect(line).toContain('the sweep reconciles if not');
    expect(line).not.toMatch(/failed|error|rejected/i);
  });
});

describe('toTinkersPatch', () => {
  it('maps our snake_case columns to the seam contract', () => {
    expect(
      toTinkersPatch({
        sections: { a: 1 },
        scorecard: [{ key: 'hooks' }],
        lead_insights: [{ headline: 'h' }],
        recognition: { ads_count: 4 },
        work_log: [{ at: 't', line: 'l' }],
        cost_usd: 3.25,
      }),
    ).toEqual({
      sections: { a: 1 },
      scorecard: [{ key: 'hooks' }],
      leadInsights: [{ headline: 'h' }],
      recognition: { ads_count: 4 },
      workLog: [{ at: 't', line: 'l' }],
      costUsd: 3.25,
    });
  });

  it('carries only the keys present, and drops columns that are ours alone', () => {
    expect(toTinkersPatch({ work_log: [], status: 'complete', updated_at: 'now' })).toEqual({ workLog: [] });
    expect(toTinkersPatch({})).toEqual({});
  });
});

describe('token hygiene', () => {
  it('redacts token-shaped text anywhere in a message', () => {
    expect(redactSecrets('GET https://graph.facebook.com/act_1?access_token=EAAsecret&x=1 failed')).toBe(
      'GET https://graph.facebook.com/act_1?access_token=[redacted]&x=1 failed',
    );
    expect(redactSecrets('token EAAB1234abcd rejected')).toBe('token [redacted-token] rejected');
    expect(redactSecrets('audit-context returned 500')).toBe('audit-context returned 500');
  });

  it('never lets the access token reach a log line', async () => {
    state.responses.push({ json: okContext });
    const context = await fetchAuditContext('org_1');
    expect(context.ok).toBe(true);

    state.responses.push({ throws: new Error(`upstream rejected token ${okContext.accessToken}`) });
    await reportAuditUpdate('aud_1', { costUsd: 1 });

    const logged = state.logs.join('\n');
    expect(logged).not.toContain('EAA');
    expect(logged).not.toContain(okContext.accessToken);
    expect(logged).toContain('upstream rejected token'); // the message still lands, just not the secret
  });
});

describe('hasReportContent', () => {
  it('is false for a payload Tinkers would store nothing from', () => {
    expect(hasReportContent({})).toBe(false);
    expect(hasReportContent({ costUsd: 4.5 })).toBe(false); // the orchestrator's status write maps to this
    expect(hasReportContent({ sections: {} })).toBe(true);
    expect(hasReportContent({ workLog: [], costUsd: 1 })).toBe(true);
  });
});

describe('runBridgedColdAudit reporting', () => {
  const SNAKE_KEYS = ['lead_insights', 'work_log', 'cost_usd', 'ads_count'];

  const runWithContext = async (): Promise<Array<Record<string, unknown>>> => {
    state.responses.push({ json: okContext }); // audit-context
    for (let i = 0; i < 12; i += 1) state.responses.push({ json: { received: true, recorded: true } });
    await runBridgedColdAudit({ organizationId: 'org_1' });
    return state.calls
      .filter((c) => c.url.endsWith('/audit-complete'))
      .map((c) => JSON.parse(c.body) as Record<string, unknown>);
  };

  it('maps EVERY payload, not just the last one', async () => {
    const posted = await runWithContext();

    for (const body of posted) {
      // Tinkers' zod strips unknown keys: a snake_case key at the TOP LEVEL of a
      // payload reads as no content at all — recorded:false, sections silently
      // lost, HTTP 200. Nothing may leave here in our column names.
      for (const key of Object.keys(body)) {
        expect(SNAKE_KEYS).not.toContain(key);
        expect(key).not.toMatch(/_/);
      }
    }

    // Contract v1.1: content is ALL partials — the accumulated row included —
    // and the run ends with the contentless finalize.
    expect(posted.map((b) => Object.keys(b).filter((k) => k !== 'auditId' && k !== 'partial'))).toEqual([
      ['recognition'],
      ['workLog'],
      ['sections', 'costUsd'],
      ['scorecard'],
      ['leadInsights'],
      ['sections', 'scorecard', 'leadInsights', 'recognition', 'workLog', 'costUsd'],
      ['finalize'],
    ]);
    expect(posted.slice(0, -1).every((b) => b.partial === true)).toBe(true);
  });

  it('skips the contentless cost-only patch instead of earning a warning for it', async () => {
    // The orchestrator's closing { status, cost_usd } write maps to costUsd
    // alone, which Tinkers reads as no content — posting it would warn on every
    // healthy run.
    const posted = await runWithContext();
    // Five of the six orchestrator patches carry content; the sixth is dropped.
    // The accumulated row then goes out as one more partial.
    const partials = posted.filter((b) => b.partial === true);
    expect(partials).toHaveLength(state.orchestratorPatches.length - 1 + 1);
    expect(partials.some((b) => Object.keys(b).join() === 'auditId,partial,costUsd')).toBe(false);
    expect(state.logs.some((l) => l.includes('not recorded'))).toBe(false);
  });

  it("seals with a tiny finalize carrying no content, after the whole report is stored", async () => {
    const posted = await runWithContext();
    const finalize = posted.at(-1)!;
    const lastContent = posted.at(-2)!;

    expect(finalize).toEqual({ auditId: 'aud_1', finalize: true });
    expect(lastContent).toEqual({
      auditId: 'aud_1',
      partial: true,
      sections: { creative_fatigue: { status: 'complete' } },
      recognition: { ads_count: 12 },
      workLog: [{ at: 'ts', line: 'Read 12 ads' }],
      scorecard: [{ key: 'hooks', band: 'weak' }],
      leadInsights: [{ headline: 'Top ad is fatiguing' }],
      costUsd: 4.5,
    });
  });

  it('stores the report but NEVER finalizes when the run ended in error', async () => {
    // Finalizing would flip their row COMPLETE and burn the one-ever "I found
    // something" email on a broken report. Their 24h fallback rail is the
    // honest treatment instead.
    state.orchestratorPatches = [{ sections: { creative_fatigue: { status: 'error' } } }, { status: 'error', cost_usd: 1 }];
    state.finalRowState = { sections: { creative_fatigue: { status: 'error' } }, cost_usd: 1, status: 'error' };

    const posted = await runWithContext();

    expect(posted.every((b) => b.partial === true)).toBe(true);
    expect(posted.some((b) => b.finalize === true)).toBe(false);
    expect(posted.at(-1)).toMatchObject({ sections: { creative_fatigue: { status: 'error' } }, costUsd: 1 });
    expect(state.logs.some((l) => l.includes('not finalizing'))).toBe(true);
  });

  it('reports to the auditId Tinkers returned, and posts nothing when it refuses', async () => {
    const posted = await runWithContext();
    expect(posted.every((b) => b.auditId === 'aud_1')).toBe(true);

    state.calls.length = 0;
    state.responses.length = 0; // drop the unused report answers from the run above
    state.responses.push({ json: { ok: false, reason: 'already_complete' } });
    await expect(runBridgedColdAudit({ organizationId: 'org_1' })).resolves.toEqual({
      status: 'skipped',
      reason: 'already_complete',
    });
    expect(state.calls.filter((c) => c.url.endsWith('/audit-complete'))).toHaveLength(0);
  });

  it('redacts token-shaped strings INSIDE the payload, not just the log line', async () => {
    // Section errors carry raw err.message, and this content is rendered on a
    // public /audit/<token> page — a token in a section error would be publish
    // -to-the-web, not just log noise.
    const leaked = 'insights slice failed: https://graph.facebook.com/v21.0/act_1/insights?access_token=EAAsecretlive';
    state.orchestratorPatches = [{ sections: { creative_fatigue: { status: 'error', error: leaked } } }];
    state.finalRowState = { sections: { creative_fatigue: { status: 'error', error: leaked } }, status: 'complete' };

    const posted = await runWithContext();
    const wire = JSON.stringify(posted);

    expect(wire).not.toContain('EAAsecretlive');
    expect(wire).toContain('access_token=[redacted]');
    expect(wire).toContain('insights slice failed'); // the honest error survives
  });
});

describe('runBridgedColdAudit idempotency', () => {
  it('refuses a second concurrent trigger for the same org, but not for another', async () => {
    // Two Graph pulls and two LLM bills interleaving partials into one row is
    // what a double-click costs without this — Tinkers' own idempotency answer
    // cannot see an audit that started a second ago.
    let release: () => void = () => {};
    state.holdRun = new Promise<void>((r) => {
      release = r;
    });
    state.responses.length = 0;
    state.responses.push({ json: okContext });
    for (let i = 0; i < 24; i += 1) state.responses.push({ json: { received: true, recorded: true } });

    const first = runBridgedColdAudit({ organizationId: 'org_1' });
    await new Promise((r) => setTimeout(r, 0));

    await expect(runBridgedColdAudit({ organizationId: 'org_1' })).resolves.toEqual({
      status: 'skipped',
      reason: 'already_running',
    });
    expect(state.logs.some((l) => l.includes('already running'))).toBe(true);
    expect(state.calls.filter((c) => c.url.endsWith('/audit-context'))).toHaveLength(1);

    release();
    await expect(first).resolves.toMatchObject({ status: 'complete' });

    // And the guard releases: the same org can be audited again afterwards.
    state.holdRun = undefined;
    state.responses.length = 0;
    state.responses.push({ json: okContext });
    for (let i = 0; i < 12; i += 1) state.responses.push({ json: { received: true, recorded: true } });
    await expect(runBridgedColdAudit({ organizationId: 'org_1' })).resolves.toMatchObject({ status: 'complete' });
  });
});
