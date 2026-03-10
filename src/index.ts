import { env } from './env.js';
import { logger } from './utils/logger.js';
import { slackApp } from './slack/app.js';
import { registerAllListeners } from './slack/listeners/index.js';
import { startDedicatedBots, stopDedicatedBots } from './slack/dedicated-bots.js';
import { loadAgentRegistry } from './agents/registry.js';
import { getDaiSupabase } from './integrations/dai-supabase.js';
import { startMonitoringLoop, stopMonitoringLoop } from './monitoring/analyzer.js';
import { setupScheduledJobs } from './scheduler/setup.js';
import { startScheduler, stopScheduler } from './scheduler/index.js';
import { shutdownBrowser } from './integrations/browser.js';
import { startApiServer } from './api/server.js';

async function start(): Promise<void> {
  // Verify Supabase connectivity
  const supabase = getDaiSupabase();
  const { error } = await supabase.from('sessions').select('id').limit(1);
  if (error) {
    throw new Error(`Supabase connectivity check failed: ${error.message}`);
  }
  logger.info('Supabase connected');

  // Load agent definitions
  const agents = loadAgentRegistry();
  logger.info({ agentCount: agents.size }, 'Agent registry loaded');

  // Register Slack listeners
  registerAllListeners(slackApp);

  // Start the Slack app
  await slackApp.start();

  // Start dedicated agent bots (Jasmin, Ada, etc.) if configured
  await startDedicatedBots();

  // Start the channel monitoring loop (analyzes buffered messages every 15 minutes)
  startMonitoringLoop(15);

  // Set up and start scheduled jobs (briefings, etc.)
  setupScheduledJobs();
  startScheduler();

  // Start the HTTP API server (for Studio / web integrations)
  if (env.STUDIO_API_KEY) {
    startApiServer();
  }

  logger.info(
    { env: env.NODE_ENV, logLevel: env.LOG_LEVEL },
    'DAI is running in Socket Mode',
  );
}

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down gracefully');
  stopScheduler();
  stopMonitoringLoop();
  shutdownBrowser().catch((err: unknown) =>
    logger.error({ err }, 'Error shutting down browser'),
  );
  Promise.all([slackApp.stop(), stopDedicatedBots()])
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
