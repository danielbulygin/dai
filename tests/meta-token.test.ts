import { describe, it, expect, afterEach } from 'vitest';
import { normalizeAdAccountId, pickAdAccount, envTokenFor } from '../src/integrations/meta-token.js';

/**
 * The token bridge's pure selection logic (the DB lookup is integration-tested
 * live). Two invariants matter for correctness:
 *  - the cold audit must target the SAME account the Tinkers funnel showed the
 *    user (inferAccountSnapshot uses ad_account_ids[0]) unless one is pinned;
 *  - the env branch keeps the exact GROWTHSQUAD split the engine always used.
 */

describe('normalizeAdAccountId', () => {
  it('prefixes a bare id and leaves an act_ id untouched', () => {
    expect(normalizeAdAccountId('123')).toBe('act_123');
    expect(normalizeAdAccountId('act_123')).toBe('act_123');
    expect(normalizeAdAccountId('  act_9  ')).toBe('act_9');
  });
});

describe('pickAdAccount', () => {
  it('returns the first granted account by default (funnel parity)', () => {
    expect(pickAdAccount(['act_1', 'act_2'])).toBe('act_1');
    expect(pickAdAccount(['9', '8'])).toBe('act_9'); // normalised
  });

  it('honours a pinned account when it is actually granted (act_-insensitive)', () => {
    expect(pickAdAccount(['act_1', 'act_2'], '2')).toBe('act_2');
    expect(pickAdAccount(['act_1', 'act_2'], 'act_2')).toBe('act_2');
  });

  it('falls back to the first granted account when the pin is NOT granted', () => {
    expect(pickAdAccount(['act_1', 'act_2'], 'act_999')).toBe('act_1');
  });

  it('returns null when nothing is granted', () => {
    expect(pickAdAccount([])).toBeNull();
    expect(pickAdAccount([''])).toBeNull();
  });
});

describe('envTokenFor', () => {
  const orig = { main: process.env.META_ACCESS_TOKEN, gs: process.env.META_ACCESS_TOKEN_GROWTHSQUAD };
  afterEach(() => {
    process.env.META_ACCESS_TOKEN = orig.main;
    process.env.META_ACCESS_TOKEN_GROWTHSQUAD = orig.gs;
  });

  it('routes Growth Squad clients to the GROWTHSQUAD token', () => {
    process.env.META_ACCESS_TOKEN = 'main-token';
    process.env.META_ACCESS_TOKEN_GROWTHSQUAD = 'gs-token';
    // envTokenFor reads env.META_ACCESS_TOKEN (cached at import) for the main
    // branch, so we only assert the GROWTHSQUAD routing here.
    expect(envTokenFor('LA')).toBe('gs-token');
    expect(envTokenFor('la2')).toBe('gs-token');
    expect(envTokenFor('TL')).toBe('gs-token');
  });

  it('falls back to the main token for a Growth Squad client when GS token is unset', () => {
    delete process.env.META_ACCESS_TOKEN_GROWTHSQUAD;
    // main branch comes from the env module (loaded once); just assert it is NOT
    // the (now-absent) GS token.
    expect(envTokenFor('LA')).not.toBe('gs-token');
  });

  it('never uses the GS token for a non-Growth-Squad client', () => {
    process.env.META_ACCESS_TOKEN_GROWTHSQUAD = 'gs-token';
    expect(envTokenFor('AB')).not.toBe('gs-token');
    expect(envTokenFor('GG')).not.toBe('gs-token');
    expect(envTokenFor('SS')).not.toBe('gs-token');
  });
});
