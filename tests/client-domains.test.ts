import { describe, it, expect } from 'vitest';
import {
  getClientCodeForEmail,
  isInternalEmail,
  getSlackChannelForDomain,
  resolveClientFromParticipants,
  getClientForDomain,
} from '../src/config/client-domains.js';

describe('client-domains', () => {
  describe('getClientCodeForEmail', () => {
    it('returns correct code for known client domain', () => {
      expect(getClientCodeForEmail('nina@audibene.de')).toBe('AB');
      expect(getClientCodeForEmail('contact@teethlovers.de')).toBe('TL');
      expect(getClientCodeForEmail('kousha@ninepine.co')).toBe('NP');
    });

    it('is case-insensitive', () => {
      expect(getClientCodeForEmail('Nina@AUDIBENE.DE')).toBe('AB');
    });

    it('returns undefined for unknown domains', () => {
      expect(getClientCodeForEmail('someone@unknown.com')).toBeUndefined();
    });

    it('returns undefined for internal emails', () => {
      expect(getClientCodeForEmail('daniel@adsontap.io')).toBeUndefined();
    });
  });

  describe('isInternalEmail', () => {
    it('identifies adsontap.io as internal', () => {
      expect(isInternalEmail('franzi@adsontap.io')).toBe(true);
      expect(isInternalEmail('nina@adsontap.io')).toBe(true);
    });

    it('identifies Daniel gmail as internal', () => {
      expect(isInternalEmail('daniel.bulygin@gmail.com')).toBe(true);
      expect(isInternalEmail('danielbulygin@gmail.com')).toBe(true);
    });

    it('returns false for client domains', () => {
      expect(isInternalEmail('contact@audibene.de')).toBe(false);
    });

    it('returns false for unknown domains', () => {
      expect(isInternalEmail('someone@random.com')).toBe(false);
    });
  });

  describe('getSlackChannelForDomain', () => {
    it('returns correct channel for domains with channel mapping', () => {
      expect(getSlackChannelForDomain('audibene.de')).toBe('C0A5GPDKXEK');
      expect(getSlackChannelForDomain('teethlovers.de')).toBe('C09LUB9CZC2');
    });

    it('returns undefined for domains without channel mapping', () => {
      expect(getSlackChannelForDomain('ninepine.co')).toBeUndefined();
      expect(getSlackChannelForDomain('unknown.com')).toBeUndefined();
    });
  });

  describe('resolveClientFromParticipants', () => {
    it('resolves client from participant emails', () => {
      const result = resolveClientFromParticipants([
        'daniel.bulygin@gmail.com',
        'nina@adsontap.io',
        'contact@audibene.de',
      ]);
      expect(result).toBeDefined();
      expect(result!.clientCode).toBe('AB');
      expect(result!.confidence).toBe(0.95);
    });

    it('returns undefined for all-internal participants', () => {
      const result = resolveClientFromParticipants([
        'daniel.bulygin@gmail.com',
        'nina@adsontap.io',
      ]);
      expect(result).toBeUndefined();
    });

    it('picks majority domain when multiple clients present', () => {
      const result = resolveClientFromParticipants([
        'a@audibene.de',
        'b@audibene.de',
        'c@teethlovers.de',
      ]);
      expect(result).toBeDefined();
      expect(result!.clientCode).toBe('AB');
    });

    it('returns undefined for empty array', () => {
      expect(resolveClientFromParticipants([])).toBeUndefined();
    });

    it('returns undefined for unknown domains only', () => {
      expect(resolveClientFromParticipants(['foo@unknown.com'])).toBeUndefined();
    });
  });

  describe('getClientForDomain', () => {
    it('returns full entry for known domain', () => {
      const entry = getClientForDomain('audibene.de');
      expect(entry).toBeDefined();
      expect(entry!.clientCode).toBe('AB');
      expect(entry!.clientName).toBe('Audibene');
      expect(entry!.slackChannel).toBe('C0A5GPDKXEK');
    });
  });
});
