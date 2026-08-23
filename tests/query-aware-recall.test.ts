import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Query-aware recall injection (AOT Memory plan endgame; built 2026-08-23).
 *
 * What these tests protect:
 *  - the section is built from the USER'S message via the store (query-aware),
 *    replacing the static top-5 learnings that carried the needed fact 3/59;
 *  - it FAILS OPEN: store down / no hits / trivial message → null, and the
 *    prompt falls back to the static learnings block — never a broken prompt;
 *  - client-scoped (Tinkers) prompts never touch the store this way until the
 *    injection-scope question is decided;
 *  - truncated excerpts tell Ada to read_corpus_memory for the rest.
 */

const { storeState } = vi.hoisted(() => ({
  storeState: {
    hits: [] as Array<Record<string, unknown>>,
    throws: false,
    calls: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock('../src/memory-store/store-client.js', () => ({
  storeSearch: vi.fn(async (args: Record<string, unknown>) => {
    storeState.calls.push(args);
    if (storeState.throws) throw new Error('store unreachable');
    return storeState.hits;
  }),
  allClientScopes: () => ['teethlovers', 'laori'],
  clientScopeFor: () => null,
}));

const { buildQueryAwareRecallSection, buildSystemPrompt } = await import('../src/agents/sdk/runAgentSDK.js');

const HIT = {
  address: 'internal::org/reference_meta_ad_processing_error_2643152.md',
  path: 'org/reference_meta_ad_processing_error_2643152.md',
  title: 'Meta 2643152 silently halts ads',
  snippet: 'issues_info …',
  score: 0.03,
  version: 1,
  contentHead: 'Meta flips run_status itself; fix = re-POST with own creative_id.',
};

beforeEach(() => {
  storeState.hits = [];
  storeState.throws = false;
  storeState.calls = [];
});

describe('buildQueryAwareRecallSection', () => {
  it('injects titles, paths, and content heads for real questions', async () => {
    storeState.hits = [HIT];
    const section = await buildQueryAwareRecallSection('why are these SweetSpot ads PAUSED with WITH_ISSUES?');
    expect(section).toContain('Relevant agency knowledge');
    expect(section).toContain('Meta 2643152 silently halts ads');
    expect(section).toContain('org/reference_meta_ad_processing_error_2643152.md');
    expect(section).toContain('re-POST with own creative_id');
  });

  it('marks a maxed-out excerpt as truncated and points at read_corpus_memory', async () => {
    storeState.hits = [{ ...HIT, contentHead: 'x'.repeat(1200) }];
    const section = await buildQueryAwareRecallSection('a real question about halted ads please');
    expect(section).toContain('TRUNCATED, read_corpus_memory');
  });

  it('trivial messages skip the store entirely', async () => {
    expect(await buildQueryAwareRecallSection('hi')).toBeNull();
    expect(storeState.calls.length).toBe(0);
  });

  it('fails open: store error → null, never a throw', async () => {
    storeState.throws = true;
    expect(await buildQueryAwareRecallSection('why are these ads paused right now?')).toBeNull();
  });

  it('no hits → null (caller falls back to static learnings)', async () => {
    storeState.hits = [];
    expect(await buildQueryAwareRecallSection('question with zero corpus coverage whatsoever')).toBeNull();
  });
});

describe('buildSystemPrompt integration', () => {
  it('internal Ada gets the query-aware section', async () => {
    storeState.hits = [HIT];
    const prompt = await buildSystemPrompt({
      agentId: 'ada',
      userMessage: 'why are these SweetSpot ads PAUSED with WITH_ISSUES but no review feedback?',
      userId: 'U_TEST',
      channelId: 'internal-test',
    });
    expect(prompt).toContain('Relevant agency knowledge');
    expect(prompt).toContain('2643152');
  });

  it('client-scoped Ada never triggers the store search', async () => {
    storeState.hits = [HIT];
    await buildSystemPrompt({
      agentId: 'ada',
      userMessage: 'why are these ads PAUSED with WITH_ISSUES but no review feedback?',
      userId: 'U_TEST',
      channelId: 'internal-test',
      clientScope: { clientCode: 'laori' },
    } as never);
    expect(storeState.calls.length).toBe(0);
  });
});
