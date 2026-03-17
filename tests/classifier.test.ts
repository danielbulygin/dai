import { describe, it, expect } from 'vitest';
import { classifyMeeting, type MeetingRow } from '../src/pipeline/classifier.js';

function makeMeeting(overrides: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id: 'test-meeting-1',
    title: 'Test Meeting',
    date: '2026-03-17T10:00:00Z',
    speakers: [],
    participant_emails: [],
    short_summary: null,
    organizer_email: 'daniel.bulygin@gmail.com',
    ...overrides,
  };
}

describe('classifyMeeting', () => {
  it('classifies meeting with audibene.de participant as AB, external, client_call', () => {
    const result = classifyMeeting(makeMeeting({
      title: 'Weekly sync',
      participant_emails: ['daniel.bulygin@gmail.com', 'contact@audibene.de'],
    }));

    expect(result.client_code).toBe('AB');
    expect(result.is_external).toBe(true);
    expect(result.meeting_type).toBe('client_call');
    expect(result.confidence).toBe(0.95);
  });

  it('classifies meeting with only internal participants as internal', () => {
    const result = classifyMeeting(makeMeeting({
      title: 'Team standup',
      participant_emails: ['daniel.bulygin@gmail.com', 'nina@adsontap.io'],
    }));

    expect(result.client_code).toBeNull();
    expect(result.is_external).toBe(false);
    expect(result.meeting_type).toBe('internal_review');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('classifies meeting from title when no email match (Ninepine Weekly)', () => {
    const result = classifyMeeting(makeMeeting({
      title: 'Ninepine Weekly',
      participant_emails: [],
    }));

    expect(result.client_code).toBe('NP');
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('returns unknown with 0 confidence for empty meeting', () => {
    const result = classifyMeeting(makeMeeting({
      title: '',
      speakers: [],
      participant_emails: [],
      short_summary: null,
    }));

    expect(result.meeting_type).toBe('unknown');
    expect(result.confidence).toBe(0.0);
    expect(result.client_code).toBeNull();
  });

  it('picks majority domain when multiple client domains present', () => {
    const result = classifyMeeting(makeMeeting({
      title: 'Cross-client review',
      participant_emails: ['a@audibene.de', 'b@audibene.de', 'c@teethlovers.de'],
    }));

    expect(result.client_code).toBe('AB');
  });

  it('detects onboarding meetings from title', () => {
    const result = classifyMeeting(makeMeeting({
      title: 'Client Onboarding Call',
      participant_emails: ['person@ninepine.co'],
    }));

    expect(result.meeting_type).toBe('onboarding');
  });

  it('uses title pattern matching with higher confidence when meeting pattern also matches', () => {
    const result = classifyMeeting(makeMeeting({
      title: 'Audibene Campaign Review',
      speakers: [],
    }));

    // Should match via TITLE_CLIENT_PATTERNS
    expect(result.client_code).toBe('AB');
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('detects strategy meetings', () => {
    const result = classifyMeeting(makeMeeting({
      title: 'Q2 Strategy Planning',
      participant_emails: ['daniel.bulygin@gmail.com', 'franzi@adsontap.io'],
    }));

    expect(result.meeting_type).toBe('strategy');
    expect(result.is_external).toBe(false);
  });
});
