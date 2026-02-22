import { getDb, closeDb } from "../src/memory/db.js";
import { logger } from "../src/utils/logger.js";

try {
  logger.info("Starting database migration...");
  getDb();
  logger.info("Migration completed successfully");
} catch (error) {
  logger.error({ error }, "Migration failed");
  process.exit(1);
} finally {
  closeDb();
}
