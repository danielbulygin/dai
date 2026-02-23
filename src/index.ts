import { env } from './env.js';
import { logger } from './utils/logger.js';
import { slackApp } from './slack/app.js';
import { registerAllListeners } from './slack/listeners/index.js';
import { loadAgentRegistry } from './agents/registry.js';
import { getDb, closeDb } from './memory/db.js';
import { startMonitoringLoop, stopMonitoringLoop } from './monitoring/analyzer.js';
import { setupScheduledJobs } from './scheduler/setup.js';
import { startScheduler, stopScheduler } from './scheduler/index.js';

async function start(): Promise<void> {
  // Initialize database (runs migrations)
  getDb();
  logger.info('Database initialized');

  // Load agent definitions
  const agents = loadAgentRegistry();
  logger.info({ agentCount: agents.size }, 'Agent registry loaded');

  // Register Slack listeners
  registerAllListeners(slackApp);

  // Start the Slack app
  await slackApp.start();

  // Start the channel monitoring loop (analyzes buffered messages every 15 minutes)
  startMonitoringLoop(15);

  // Set up and start scheduled jobs (briefings, etc.)
  setupScheduledJobs();
  startScheduler();

  logger.info(
    { env: env.NODE_ENV, logLevel: env.LOG_LEVEL },
    'DAI is running in Socket Mode',
  );
}

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down gracefully');
  stopScheduler();
  stopMonitoringLoop();
  closeDb();
  slackApp
    .stop()
    .then(() => {
      logger.info('DAI stopped');
      process.exit(0);
    })
    .catch((err: unknown) => {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start DAI');
  process.exit(1);
});
