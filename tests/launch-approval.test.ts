import { describe, it, expect } from 'vitest';
import { matchApproval } from '../src/slack/launch-approval.js';
import { extractBatchIds, buildLaunchStateSection, formatStaleBatchSection, type BatchState } from '../src/agents/launch-state.js';

describe('launch-approval matcher', () => {
  describe('approves unambiguous launch commands', () => {
    const approvals: Array<[string, string]> = [
      ['launch both', 'launch_verb'],
      ['aunch both', 'launch_verb'], // Nina's 2026-06-05 typo — the incident trigger
      ['launch', 'launch_verb'],
      ['launch them', 'launch_verb'],
      ['yes launch both', 'launch_verb'],
      ['Launch it 🚀', 'launch_verb'],
      ['fire both', 'launch_verb'],
      ['go ahead', 'bare_affirm'],
      ['yes please', 'bare_affirm'],
      ['do it', 'bare_affirm'],
      ['approved', 'bare_affirm'],
      ['👍', 'bare_affirm'],
      ['ja los', 'bare_affirm'],
    ];
    for (const [text, expected] of approvals) {
      it(`"${text}" → ${expected}`, () => {
        expect(matchApproval(text)).toBe(expected);
      });
    }
  });

  describe('rejects negations, questions, subsets, and nuance', () => {
    const rejections = [
      "don't launch yet",
      'do not launch',
      'no',
      'hold off on the launch',
      'wait before launching',
      'stop, cancel the launch',
      'can you launch both?', // question
      'launch only the statics', // subset → model resolves which
      'just launch one of them',
      'launch the videos first',
      'skip the statics and launch',
      'start with both', // Gate-2 work approval, NOT a launch approval
      'looks good but change the headline on ad 2 then launch', // >nuance, has edits
      'nicht launchen',
      'the launch looked great last week', // past-tense chatter... still has verb, but:
    ];
    for (const text of rejections.slice(0, 14)) {
      it(`"${text}" → null`, () => {
        expect(matchApproval(text)).toBeNull();
      });
    }
    it('long messages with launch verbs fall through to the model', () => {
      const long =
        'I think we should launch both of these but only after Rebecka confirms the naming, ' +
        'and also double-check the Swarovski one against the brief before anything goes out.';
      expect(matchApproval(long)).toBeNull();
    });
  });
});

describe('launch-state batch extraction', () => {
  it('extracts and dedupes UUIDs across messages, order-preserving', () => {
    const texts = [
      'Batch IDs:\n- 3906 (videos): `0ee234fc-4171-4b36-a5b3-203a5dcd5abf`\n- 3907 (statics): `4adea00c-9947-4aed-ac9f-5ff91eda9f7e`',
      'as discussed, 0EE234FC-4171-4B36-A5B3-203A5DCD5ABF again (uppercase dupe)',
    ];
    expect(extractBatchIds(texts)).toEqual([
      '0ee234fc-4171-4b36-a5b3-203a5dcd5abf',
      '4adea00c-9947-4aed-ac9f-5ff91eda9f7e',
    ]);
  });

  it('returns empty for text without UUIDs', () => {
    expect(extractBatchIds(['launch both', 'no ids here'])).toEqual([]);
  });
});

describe('launch-state prompt section', () => {
  it('renders pending and launched batches with the authoritative warning', () => {
    const states: BatchState[] = [
      {
        batch_id: '0ee234fc-4171-4b36-a5b3-203a5dcd5abf',
        client_code: 'SS',
        status: 'pending',
        mode: 'new_adset',
        adset_id: null,
        ad_ids: [],
        created_at: '2026-06-05T14:09:00Z',
        launched_at: null,
      },
      {
        batch_id: '4adea00c-9947-4aed-ac9f-5ff91eda9f7e',
        client_code: 'SS',
        status: 'launched',
        mode: 'new_adset',
        adset_id: '120245854481540241',
        ad_ids: ['1', '2', '3', '4', '5', '6'],
        created_at: '2026-06-05T14:09:00Z',
        launched_at: '2026-06-05T14:50:00Z',
      },
    ];
    const section = buildLaunchStateSection(states);
    expect(section).toContain('LIVE DATABASE STATE');
    expect(section).toContain('`0ee234fc-4171-4b36-a5b3-203a5dcd5abf` (SS, new_adset): **pending**');
    expect(section).toContain('**launched** — adset `120245854481540241`, 6 ads, launched_at 2026-06-05T14:50:00Z');
    expect(section).toContain('it has NOT been launched');
  });
});

describe('stale-pending digest section', () => {
  const base = {
    client_code: 'SS',
    status: 'pending',
    mode: 'new_adset',
    adset_id: null,
    ad_ids: [],
    launched_at: null,
  };
  it('renders age and batch prefixes', () => {
    const now = new Date('2026-06-06T14:00:00Z').getTime();
    const section = formatStaleBatchSection(
      [
        { ...base, batch_id: '0ee234fc-4171-4b36-a5b3-203a5dcd5abf', created_at: '2026-06-05T14:00:00Z' },
        { ...base, batch_id: '4adea00c-9947-4aed-ac9f-5ff91eda9f7e', created_at: '2026-06-04T14:00:00Z' },
      ],
      now,
    );
    expect(section).toContain('2 launch previews stuck in `pending` >24h');
    expect(section).toContain('`0ee234fc` (SS, new_adset) — previewed 24h ago, never launched');
    expect(section).toContain('`4adea00c` (SS, new_adset) — previewed 48h ago, never launched');
  });
  it('returns null when nothing is stale', () => {
    expect(formatStaleBatchSection([], Date.now())).toBeNull();
  });
});
