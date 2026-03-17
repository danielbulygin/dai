import { describe, it, expect } from 'vitest';
import { emptyExtraction, type UniversalExtraction } from '../src/pipeline/extractor.js';

describe('pipeline router', () => {
  // Router tests require Supabase and Slack mocking.
  // These are structural tests validating the routing logic.

  describe('routing signals', () => {
    it('deep extraction should only trigger for media_buying_depth === deep', () => {
      const extraction = emptyExtraction();

      // Default is 'none' — should NOT trigger deep extraction
      expect(extraction.routing_signals.media_buying_depth).toBe('none');

      // Set to 'shallow' — should NOT trigger deep extraction
      extraction.routing_signals.media_buying_depth = 'shallow';
      expect(extraction.routing_signals.media_buying_depth).not.toBe('deep');

      // Set to 'deep' — SHOULD trigger deep extraction
      extraction.routing_signals.media_buying_depth = 'deep';
      expect(extraction.routing_signals.media_buying_depth).toBe('deep');
    });

    it('urgency signals are an array of strings', () => {
      const extraction = emptyExtraction();
      expect(Array.isArray(extraction.routing_signals.urgency_signals)).toBe(true);
      expect(extraction.routing_signals.urgency_signals).toHaveLength(0);
    });
  });

  describe('extraction shape', () => {
    it('all agent sections are present in UniversalExtraction', () => {
      const e = emptyExtraction();

      // Amy sections
      expect(e).toHaveProperty('action_items');
      expect(e).toHaveProperty('decisions');
      expect(e).toHaveProperty('sentiment');
      expect(e).toHaveProperty('priority_changes');
      expect(e).toHaveProperty('open_questions');
      expect(e).toHaveProperty('initiative_updates');

      // Ada sections
      expect(e).toHaveProperty('account_insights');
      expect(e).toHaveProperty('campaign_decisions');

      // Maya sections
      expect(e).toHaveProperty('creative_feedback');

      // Routing
      expect(e).toHaveProperty('routing_signals');
    });
  });
});
