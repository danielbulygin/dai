import { describe, it, expect } from 'vitest';
import { classifyMeeting, type MeetingRow } from '../src/pipeline/classifier.js';
import { emptyExtraction } from '../src/pipeline/extractor.js';
import {
  getClientCodeForEmail,
  isInternalEmail,
  getSlackChannelForDomain,
} from '../src/config/client-domains.js';

describe('pipeline integration', () => {
  describe('classify → extract flow', () => {
    it('classification feeds into extraction context correctly', () => {
      const meeting: MeetingRow = {
        id: 'test-1',
        title: 'Audibene Campaign Review',
        date: '2026-03-17T10:00:00Z',
        speakers: ['Daniel', 'Client Rep'],
        participant_emails: ['daniel.bulygin@gmail.com', 'rep@audibene.de'],
        short_summary: 'Review of Q1 campaign performance',
        organizer_email: 'daniel.bulygin@gmail.com',
      };

      const classification = classifyMeeting(meeting);

      // Classification should produce all fields needed by extractor
      expect(classification.client_code).toBe('AB');
      expect(classification.meeting_type).toBeDefined();
      expect(typeof classification.is_external).toBe('boolean');
      expect(typeof classification.confidence).toBe('number');
    });
  });

  describe('domain registry → Notion webhook regression', () => {
    it('Notion webhook routing still works after refactor', () => {
      // These are the same domains that were in DOMAIN_ROUTING
      expect(getSlackChannelForDomain('teethlovers.de')).toBe('C09LUB9CZC2');
      expect(getSlackChannelForDomain('audibene.de')).toBe('C0A5GPDKXEK');
    });

    it('unknown domains return undefined (filtering behavior preserved)', () => {
      expect(getSlackChannelForDomain('random.com')).toBeUndefined();
    });
  });

  describe('pipeline_status guard', () => {
    it('empty extraction has no media buying content (default safe)', () => {
      const e = emptyExtraction();
      expect(e.routing_signals.has_media_buying_content).toBe(false);
      expect(e.routing_signals.media_buying_depth).toBe('none');
    });
  });

  describe('end-to-end type consistency', () => {
    it('classification types match what router expects', () => {
      const meeting: MeetingRow = {
        id: 'test-e2e',
        title: 'Test',
        date: null,
        speakers: null,
        participant_emails: null,
        short_summary: null,
        organizer_email: null,
      };

      const c = classifyMeeting(meeting);

      // These fields are used by router.ts
      expect(c).toHaveProperty('client_code');
      expect(c).toHaveProperty('meeting_type');
      expect(c).toHaveProperty('is_external');
      expect(c).toHaveProperty('confidence');
      expect(c).toHaveProperty('matched_pattern');
    });
  });
});
