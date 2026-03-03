/**
 * Triage scheduled jobs: scanners + dispatcher + cleanup.
 */

import { registerJob } from './index.js';

export function registerTriageJobs(): void {
  // Email scanner: every 5 min, 9am-6pm Mon-Fri Berlin
  registerJob(
    'triage-email-scan',
    '*/5 9-18 * * 1-5',
    'Europe/Berlin',
    async () => {
      const { scanEmails } = await import('../triage/scanners/email-scanner.js');
      await scanEmails();
    },
  );

  // DM scanner: every 5 min, 9am-6pm Mon-Fri Berlin
  registerJob(
    'triage-dm-scan',
    '*/5 9-18 * * 1-5',
    'Europe/Berlin',
    async () => {
      const { scanDMs } = await import('../triage/scanners/dm-scanner.js');
      await scanDMs();
    },
  );

  // Dispatcher: every 2 min, 24/7 (P0 can arrive anytime from channel monitor)
  registerJob(
    'triage-dispatch',
    '*/2 * * * *',
    'Europe/Berlin',
    async () => {
      const { dispatchNotifications } = await import('../triage/dispatcher.js');
      await dispatchNotifications();
    },
  );

  // Cleanup: daily 3am — expire old items
  registerJob(
    'triage-cleanup',
    '0 3 * * *',
    'Europe/Berlin',
    async () => {
      const { expireOldItems } = await import('../triage/queue.js');
      const expired = await expireOldItems(48);
      if (expired > 0) {
        const { logger } = await import('../utils/logger.js');
        logger.info({ expired }, 'Triage cleanup: expired old items');
      }
    },
  );
}
