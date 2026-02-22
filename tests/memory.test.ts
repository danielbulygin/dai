import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/memory/schema.js';
import fs from 'node:fs';
import path from 'node:path';

// Use an in-memory database for tests
let db: Database.Database;

// We need to mock getDb since memory modules import it
// Instead, let's test the schema and CRUD logic directly
const TEST_DB_PATH = '/tmp/dai-test.db';

beforeAll(() => {
  // Clean up any leftover test db
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}

  db = new Database(TEST_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
});

afterAll(() => {
  db.close();
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
});

describe('Schema migrations', () => {
  it('creates all 5 tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name")
      .all() as { name: string }[];

    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions');
    expect(names).toContain('observations');
    expect(names).toContain('summaries');
    expect(names).toContain('learnings');
    expect(names).toContain('feedback');
  });

  it('creates FTS5 virtual tables', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%' ORDER BY name")
      .all() as { name: string }[];

    const names = tables.map((t) => t.name);
    // FTS5 creates multiple internal tables, but the main ones should be there
    expect(names.some(n => n.includes('observations_fts'))).toBe(true);
    expect(names.some(n => n.includes('learnings_fts'))).toBe(true);
  });

  it('is idempotent (running migrations twice does not error)', () => {
    expect(() => runMigrations(db)).not.toThrow();
  });
});

describe('Sessions CRUD', () => {
  it('can insert and retrieve a session', () => {
    const id = 'test-session-1';
    db.prepare(`INSERT INTO sessions (id, agent_id, channel_id, thread_ts, user_id)
                VALUES (?, ?, ?, ?, ?)`).run(id, 'otto', 'C123', 'T456', 'U789');

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown>;
    expect(session).toBeDefined();
    expect(session.agent_id).toBe('otto');
    expect(session.channel_id).toBe('C123');
    expect(session.user_id).toBe('U789');
    expect(session.status).toBe('active');
  });

  it('can update a session', () => {
    db.prepare("UPDATE sessions SET status = 'ended', summary = 'test summary' WHERE id = ?")
      .run('test-session-1');

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get('test-session-1') as Record<string, unknown>;
    expect(session.status).toBe('ended');
    expect(session.summary).toBe('test summary');
  });
});

describe('Observations CRUD', () => {
  it('can insert an observation', () => {
    db.prepare(`INSERT INTO observations (id, session_id, tool_name, input_summary, output_summary, importance, tags)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'obs-1', 'test-session-1', 'Write', 'wrote file.ts', 'success', 8, '["coding"]'
    );

    const obs = db.prepare('SELECT * FROM observations WHERE id = ?').get('obs-1') as Record<string, unknown>;
    expect(obs).toBeDefined();
    expect(obs.tool_name).toBe('Write');
    expect(obs.importance).toBe(8);
  });

  it('FTS5 search works for observations', () => {
    const results = db.prepare(
      "SELECT * FROM observations_fts WHERE observations_fts MATCH 'file'"
    ).all();
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('Learnings CRUD', () => {
  it('can insert and search learnings', () => {
    db.prepare(`INSERT INTO learnings (id, agent_id, category, content, confidence)
                VALUES (?, ?, ?, ?, ?)`).run(
      'learn-1', 'otto', 'technical', 'User prefers TypeScript with strict mode', 0.8
    );

    const learning = db.prepare('SELECT * FROM learnings WHERE id = ?').get('learn-1') as Record<string, unknown>;
    expect(learning).toBeDefined();
    expect(learning.confidence).toBe(0.8);
    expect(learning.applied_count).toBe(0);
  });

  it('FTS5 search works for learnings', () => {
    const results = db.prepare(
      "SELECT * FROM learnings_fts WHERE learnings_fts MATCH 'TypeScript'"
    ).all();
    expect(results.length).toBeGreaterThan(0);
  });

  it('can increment applied_count', () => {
    db.prepare('UPDATE learnings SET applied_count = applied_count + 1 WHERE id = ?').run('learn-1');
    const learning = db.prepare('SELECT * FROM learnings WHERE id = ?').get('learn-1') as Record<string, unknown>;
    expect(learning.applied_count).toBe(1);
  });
});

describe('Feedback CRUD', () => {
  it('can insert and query feedback', () => {
    db.prepare(`INSERT INTO feedback (id, session_id, agent_id, user_id, type, sentiment, content)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'fb-1', 'test-session-1', 'otto', 'U789', 'reaction', 'positive', 'thumbsup'
    );

    const fb = db.prepare('SELECT * FROM feedback WHERE id = ?').get('fb-1') as Record<string, unknown>;
    expect(fb).toBeDefined();
    expect(fb.sentiment).toBe('positive');
    expect(fb.processed).toBe(0);
  });

  it('can mark feedback as processed', () => {
    db.prepare('UPDATE feedback SET processed = 1 WHERE id = ?').run('fb-1');
    const fb = db.prepare('SELECT * FROM feedback WHERE id = ?').get('fb-1') as Record<string, unknown>;
    expect(fb.processed).toBe(1);
  });
});

describe('Foreign keys', () => {
  it('enforces session FK on observations', () => {
    expect(() => {
      db.prepare(`INSERT INTO observations (id, session_id, tool_name) VALUES (?, ?, ?)`)
        .run('obs-bad', 'nonexistent-session', 'Read');
    }).toThrow();
  });
});
