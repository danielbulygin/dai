import { registerJob } from './index.js';

export function registerMayaJobs(): void {
  // Creative classification: nightly at 2am Berlin, classifies unclassified BMAD creatives
  registerJob('creative-classification', '0 2 * * *', 'Europe/Berlin', async () => {
    const { classifyNewCreatives } = await import('../learning/creative-classifier.js');
    await classifyNewCreatives();
  });

  // Creative audit refresh: weekly Sundays 3am Berlin
  registerJob('creative-audit-refresh', '0 3 * * 0', 'Europe/Berlin', async () => {
    const { runCreativeAuditRefresh } = await import('../learning/creative-classifier.js');
    await runCreativeAuditRefresh();
  });
}
