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

  // Ready-to-Upload backlog check: 10:00 + 17:00 Berlin, every day. Posts to #ada
  // tagging Dan + Nina when there are "Upload and Configure" tasks ready, so the
  // gated launch flow can be kicked off in-thread. Silent when the backlog is empty.
  registerJob('ada-ready-to-upload-am', '0 10 * * *', 'Europe/Berlin', async () => {
    const { runReadyToUploadCheck } = await import('../monitoring/ready-to-upload-check.js');
    await runReadyToUploadCheck('morning');
  });
  registerJob('ada-ready-to-upload-pm', '0 17 * * *', 'Europe/Berlin', async () => {
    const { runReadyToUploadCheck } = await import('../monitoring/ready-to-upload-check.js');
    await runReadyToUploadCheck('evening');
  });

  // Monday meeting-prep pipeline (Ada → Ace). 08:00: per-client Fri–Sun
  // highlights/lowlights drafts in #ada for Nina's client updates. 09:30 (after
  // Ace's agenda sweep): per-client 7-day agenda blocks in #agent-office, handed
  // to Ace via real @mention for surgical merge into the Client Meetings pages.
  registerJob('ada-monday-three-day-drafts', '0 8 * * 1', 'Europe/Berlin', async () => {
    const { runMondayThreeDayDrafts } = await import('../monitoring/monday-prep.js');
    await runMondayThreeDayDrafts();
  });
  registerJob('ada-monday-agenda-blocks', '30 9 * * 1', 'Europe/Berlin', async () => {
    const { runMondayAgendaBlocks } = await import('../monitoring/monday-prep.js');
    await runMondayAgendaBlocks();
  });
}
