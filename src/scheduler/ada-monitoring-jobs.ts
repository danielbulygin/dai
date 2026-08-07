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

  // Loop 1 — the agency morning brief for the pilot clients (board card 81):
  // per-client narrative with numbers AND meaning, posted to #ada. Runs a few
  // minutes after the hour so the :00 warehouse sync has finished writing.
  registerJob(
    'ada-agency-morning-brief',
    '10 8 * * 1-5',
    'Europe/Berlin',
    async () => {
      const { runAgencyMorningBrief } = await import(
        '../monitoring/agency-morning-brief.js'
      );
      await runAgencyMorningBrief({ post: true });
    },
  );

  // The intraday pulse — between the morning briefs, twice on weekdays (13:40 +
  // 17:40 Berlin, after the :00 warehouse syncs settle). Posts to #ada ONLY when
  // something event-worthy happened on a pilot account today; total silence
  // otherwise. Event-shaped claims only — a partial day is never judged as a day.
  registerJob(
    'ada-intraday-pulse',
    '40 13,17,20 * * 1-5',
    'Europe/Berlin',
    async () => {
      const { runIntradayPulse } = await import('../monitoring/intraday-pulse.js');
      await runIntradayPulse({ post: true });
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
