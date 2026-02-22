import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { env } from "../env.js";
import { logger } from "../utils/logger.js";
import { runMigrations } from "./schema.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) {
    return db;
  }

  const dbPath = env.DB_PATH;
  const dataDir = path.dirname(dbPath);

  // Ensure the data directory exists
  fs.mkdirSync(dataDir, { recursive: true });

  logger.info({ dbPath }, "Opening SQLite database");

  db = new Database(dbPath);

  // Set performance and safety pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = 20000");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");

  logger.debug("SQLite pragmas configured");

  // Run migrations
  runMigrations(db);

  return db;
}

export function closeDb(): void {
  if (db) {
    logger.info("Closing SQLite database");
    db.close();
    db = null;
  }
}
