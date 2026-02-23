import { getDb } from "../memory/db.js";
import { logger } from "../utils/logger.js";

export interface MonitoredMessage {
  id: number;
  channel_id: string;
  channel_name: string | null;
  user_id: string;
  user_name: string | null;
  message_ts: string;
  thread_ts: string | null;
  text: string;
  matched_keywords: string | null;
  priority: string;
  analyzed: number;
  created_at: string;
}

export interface BufferMessageParams {
  channel_id: string;
  channel_name?: string | null;
  user_id: string;
  user_name?: string | null;
  message_ts: string;
  thread_ts?: string | null;
  text: string;
  matched_keywords?: string | null;
  priority?: string;
}

export function bufferMessage(params: BufferMessageParams): void {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO channel_monitor
      (channel_id, channel_name, user_id, user_name, message_ts, thread_ts, text, matched_keywords, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    params.channel_id,
    params.channel_name ?? null,
    params.user_id,
    params.user_name ?? null,
    params.message_ts,
    params.thread_ts ?? null,
    params.text,
    params.matched_keywords ?? null,
    params.priority ?? "normal",
  );

  logger.debug(
    { channel_id: params.channel_id, message_ts: params.message_ts, priority: params.priority },
    "Buffered monitored message",
  );
}

export function getUnanalyzedMessages(limit = 100): MonitoredMessage[] {
  const db = getDb();

  const stmt = db.prepare(`
    SELECT * FROM channel_monitor
    WHERE analyzed = 0
    ORDER BY created_at ASC
    LIMIT ?
  `);

  return stmt.all(limit) as MonitoredMessage[];
}

export function markAnalyzed(ids: number[]): void {
  if (ids.length === 0) return;

  const db = getDb();

  const placeholders = ids.map(() => "?").join(", ");
  const stmt = db.prepare(`
    UPDATE channel_monitor SET analyzed = 1 WHERE id IN (${placeholders})
  `);

  stmt.run(...ids);

  logger.debug({ count: ids.length }, "Marked messages as analyzed");
}

export function getRecentMessages(
  hours = 24,
  channelId?: string,
): MonitoredMessage[] {
  const db = getDb();

  if (channelId) {
    const stmt = db.prepare(`
      SELECT * FROM channel_monitor
      WHERE created_at >= datetime('now', ? || ' hours')
        AND channel_id = ?
      ORDER BY created_at DESC
    `);
    return stmt.all(`-${hours}`, channelId) as MonitoredMessage[];
  }

  const stmt = db.prepare(`
    SELECT * FROM channel_monitor
    WHERE created_at >= datetime('now', ? || ' hours')
    ORDER BY created_at DESC
  `);
  return stmt.all(`-${hours}`) as MonitoredMessage[];
}

export function cleanOldMessages(daysToKeep = 7): number {
  const db = getDb();

  const stmt = db.prepare(`
    DELETE FROM channel_monitor
    WHERE created_at < datetime('now', ? || ' days')
  `);

  const result = stmt.run(`-${daysToKeep}`);

  if (result.changes > 0) {
    logger.info({ deleted: result.changes, daysToKeep }, "Cleaned old monitored messages");
  }

  return result.changes;
}
