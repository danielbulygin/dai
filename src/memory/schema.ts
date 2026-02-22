import type BetterSqlite3 from "better-sqlite3";
import { logger } from "../utils/logger.js";

const TABLES_SQL = `
-- Core sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT,
  user_id TEXT NOT NULL,
  claude_session_id TEXT,
  summary TEXT,
  total_cost REAL DEFAULT 0,
  total_turns INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Observations from tool calls and interactions
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  tool_name TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  importance INTEGER DEFAULT 5,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Summaries for sessions, daily, weekly rollups
CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT,
  agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  token_count INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Learnings extracted from feedback and self-reflection
CREATE TABLE IF NOT EXISTS learnings (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  applied_count INTEGER DEFAULT 0,
  source_session_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Chat messages for conversation history
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- User feedback: reactions, commands, implicit signals
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  agent_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  sentiment TEXT NOT NULL,
  content TEXT,
  message_ts TEXT,
  processed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_sessions_channel_thread ON sessions(channel_id, thread_ts);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_learnings_agent ON learnings(agent_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_processed ON feedback(processed);
`;

const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  input_summary,
  output_summary,
  tags,
  content='observations',
  content_rowid='rowid'
);

CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
  content,
  category,
  content='learnings',
  content_rowid='rowid'
);
`;

const TRIGGERS_SQL = `
-- Keep observations FTS in sync
CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, input_summary, output_summary, tags)
  VALUES (NEW.rowid, NEW.input_summary, NEW.output_summary, NEW.tags);
END;

CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, input_summary, output_summary, tags)
  VALUES ('delete', OLD.rowid, OLD.input_summary, OLD.output_summary, OLD.tags);
END;

-- Keep learnings FTS in sync
CREATE TRIGGER IF NOT EXISTS learnings_ai AFTER INSERT ON learnings BEGIN
  INSERT INTO learnings_fts(rowid, content, category)
  VALUES (NEW.rowid, NEW.content, NEW.category);
END;

CREATE TRIGGER IF NOT EXISTS learnings_ad AFTER DELETE ON learnings BEGIN
  INSERT INTO learnings_fts(learnings_fts, rowid, content, category)
  VALUES ('delete', OLD.rowid, OLD.content, OLD.category);
END;
`;

export function runMigrations(db: BetterSqlite3.Database): void {
  logger.info("Running database migrations...");

  db.exec(TABLES_SQL);
  logger.debug("Tables created");

  db.exec(INDEXES_SQL);
  logger.debug("Indexes created");

  db.exec(FTS_SQL);
  logger.debug("FTS virtual tables created");

  db.exec(TRIGGERS_SQL);
  logger.debug("Triggers created");

  logger.info("Database migrations complete");
}
