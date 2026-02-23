import cron from 'node-cron';
import { logger } from '../utils/logger.js';

interface ScheduledJob {
  name: string;
  task: cron.ScheduledTask;
}

const jobs: ScheduledJob[] = [];

export function registerJob(
  name: string,
  cronExpr: string,
  timezone: string,
  fn: () => Promise<void>,
): void {
  const task = cron.createTask(
    cronExpr,
    () => {
      logger.info({ job: name }, `Running scheduled job: ${name}`);
      fn().catch((err) => {
        logger.error({ err, job: name }, `Scheduled job failed: ${name}`);
      });
    },
    { timezone, name },
  );

  jobs.push({ name, task });
  logger.info({ job: name, cron: cronExpr, timezone }, 'Registered scheduled job');
}

export function startScheduler(): void {
  for (const job of jobs) {
    job.task.start();
  }
  logger.info({ jobCount: jobs.length }, 'Scheduler started');
}

export function stopScheduler(): void {
  for (const job of jobs) {
    job.task.stop();
  }
  logger.info('Scheduler stopped');
}
