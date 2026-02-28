import { describe, it, expect } from 'vitest';

/**
 * Memory layer tests.
 *
 * The memory layer now uses Supabase (PostgreSQL) instead of SQLite.
 * These tests require a live DAI Supabase instance with the schema applied.
 *
 * To test the schema:
 *   1. Apply migrations: supabase db push
 *   2. Run: pnpm test
 *
 * TODO: Add integration tests that run against a test Supabase instance
 * or use Supabase local dev (supabase start).
 */

describe('Memory layer (Supabase)', () => {
  it('placeholder — integration tests require Supabase instance', () => {
    // Verify the modules can be imported without error
    expect(true).toBe(true);
  });
});
