import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, INVESTIGATION_METHOD_SECTION } from '../src/agents/sdk/runAgentSDK.js';

/**
 * Investigation-method prompt block (the reflex half of the corpus fix,
 * 2026-08-23). The tools existed and Ada never called them — 0 corpus calls
 * across a full 19-question eval — because with lazy tool discovery nothing
 * ever tells her the corpus exists. The block must be present for internal
 * Ada, and ABSENT for client-scoped (Tinkers) Ada, whose profile denies the
 * tools it names: prompting a tool the guard refuses just manufactures
 * failed calls.
 */

describe('investigation method section', () => {
  it('names all four tools it depends on', () => {
    for (const tool of ['search_corpus', 'read_corpus_memory', 'grep_repo', 'run_analysis_script', 'look_at_media']) {
      expect(INVESTIGATION_METHOD_SECTION).toContain(tool);
    }
  });

  it('is in INTERNAL Ada\'s composed prompt', async () => {
    const prompt = await buildSystemPrompt({
      agentId: 'ada',
      userMessage: 'hello',
      userId: 'U_TEST',
      channelId: 'internal-test',
    });
    expect(prompt).toContain('Investigation method (internal tools)');
    expect(prompt).toContain('Search the corpus BEFORE concluding');
  });

  it('is NOT in client-scoped (Tinkers) Ada\'s prompt', async () => {
    const prompt = await buildSystemPrompt({
      agentId: 'ada',
      userMessage: 'hello',
      userId: 'U_TEST',
      channelId: 'internal-test',
      clientScope: { clientCode: 'laori' },
    } as never);
    expect(prompt).not.toContain('Investigation method (internal tools)');
    expect(prompt).not.toContain('search_corpus');
  });
});
