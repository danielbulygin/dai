import { registerJob } from './index.js';

export function registerAdaMonitoringJobs(): void {
  // Morning briefing: 8am Berlin, weekdays
  registerJob(
    'ada-morning-briefing',
    '0 8 * * 1-5',
    'Europe/Berlin',
    async () => {
      const { sendMorningBriefing } = await import(
        '../monitoring/morning-briefing.js'
      );
      await sendMorningBriefing();
    },
  );
}
