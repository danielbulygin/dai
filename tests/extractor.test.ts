import { describe, it, expect } from 'vitest';
import { emptyExtraction } from '../src/pipeline/extractor.js';

describe('extractor', () => {
  describe('emptyExtraction', () => {
    it('returns a valid empty extraction with all fields', () => {
      const e = emptyExtraction();

      expect(e.action_items).toEqual([]);
      expect(e.decisions).toEqual([]);
      expect(e.sentiment).toBe('neutral');
      expect(e.priority_changes).toEqual([]);
      expect(e.open_questions).toEqual([]);
      expect(e.initiative_updates).toEqual([]);
      expect(e.account_insights).toEqual([]);
      expect(e.campaign_decisions).toEqual([]);
      expect(e.creative_feedback).toEqual([]);
      expect(e.routing_signals).toEqual({
        has_media_buying_content: false,
        media_buying_depth: 'none',
        has_creative_content: false,
        urgency_signals: [],
      });
    });
  });

  // Note: Full extraction tests require mocking the Anthropic API.
  // The extractFromMeeting function is tested via the integration test
  // (tests/pipeline.test.ts) with real meetings.
  //
  // Key behaviors to verify manually:
  // - Transcripts < 200 chars → empty extraction
  // - Valid JSON response → correctly parsed
  // - Markdown-wrapped JSON → stripped
  // - normalizeAccountCode applied to all account_code fields
});
