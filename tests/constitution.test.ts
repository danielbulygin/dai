import { describe, it, expect, beforeEach } from 'vitest';
import { getConstitution, resetConstitutionCache } from '../src/agents/constitution.js';
import { loadAgentRegistry, getAgent } from '../src/agents/registry.js';
import { buildSystemBlocks } from '../src/agents/runner.js';
import { buildSystemPrompt } from '../src/agents/sdk/runAgentSDK.js';

/**
 * Constitution injection (memory-track Phase 0, rides the Ada 2.0 Phase-A batch).
 * BOTH prompt paths must carry it: runner.ts buildSystemBlocks (the 7 hand-rolled
 * agents) AND runAgentSDK.ts buildSystemPrompt (Ada's SDK loop) — Ada does not
 * pass through buildSystemBlocks, so runner-only wiring silently misses her.
 * The live verify gate re-checks this on the deployed service.
 */

const MARKER = 'Ask, don\'t assume';

const EMPTY_CONTEXT = { lastSessionSummary: null, topLearnings: [], userLearnings: [] } as never;

describe('constitution loader', () => {
  beforeEach(() => resetConstitutionCache());

  it('loads the six principles and strips the source-pointer comment', () => {
    const c = getConstitution();
    expect(c).toContain(MARKER);
    expect(c).toContain('Verify your own work with tests');
    expect(c.startsWith('<!--')).toBe(false);
    expect(c).not.toContain('CANONICAL SOURCE');
  });
});

describe('registry opt-out flag', () => {
  it('defaults constitution: true for every agent', () => {
    for (const [id, def] of loadAgentRegistry()) {
      expect(def.config.constitution, `agent ${id}`).toBe(true);
    }
  });
});

describe('prompt path 1 — runner.ts buildSystemBlocks', () => {
  it('the constitution is the FIRST thing in stable Block 1', () => {
    const blocks = buildSystemBlocks('PERSONA', 'INSTRUCTIONS', EMPTY_CONTEXT, [], [], getConstitution());
    expect(blocks[0]!.text.indexOf(MARKER)).toBeGreaterThanOrEqual(0);
    expect(blocks[0]!.text.indexOf(MARKER)).toBeLessThan(blocks[0]!.text.indexOf('PERSONA'));
  });

  it('an opted-out agent (empty constitution) gets the old prompt exactly', () => {
    const blocks = buildSystemBlocks('PERSONA', 'INSTRUCTIONS', EMPTY_CONTEXT, [], [], '');
    expect(blocks[0]!.text.startsWith('PERSONA')).toBe(true);
    expect(blocks[0]!.text).not.toContain(MARKER);
  });
});

describe('prompt path 2 — runAgentSDK.ts buildSystemPrompt (Ada)', () => {
  it('Ada\'s composed system prompt contains the constitution before her persona', async () => {
    const prompt = await buildSystemPrompt({
      agentId: 'ada',
      userMessage: 'hello',
      userId: 'U_TEST',
      channelId: 'internal-test',
    });
    const ada = getAgent('ada')!;
    expect(prompt).toContain(MARKER);
    expect(prompt.indexOf(MARKER)).toBeLessThan(prompt.indexOf(ada.persona.slice(0, 40)));
  });
});
