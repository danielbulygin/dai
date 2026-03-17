import { registerJob } from './index.js';

export function registerPipelineJobs(): void {
  // Fireflies team sync: every 30 min during work hours — pulls ALL team meetings
  // (webhook only fires for Daniel's recordings, this catches everyone else's)
  registerJob('fireflies-team-sync', '*/30 9-20 * * 1-5', 'Europe/Berlin', async () => {
    const { syncTeamMeetings } = await import('../integrations/fireflies-sync.js');
    await syncTeamMeetings();
  });

  // Meeting pipeline: every 5 min during work hours (9-20 Berlin, Mon-Fri)
  registerJob('meeting-pipeline', '*/5 9-20 * * 1-5', 'Europe/Berlin', async () => {
    const { processNewMeetings } = await import('../pipeline/index.js');
    await processNewMeetings();
  });

  // Reconciliation: daily 6am — catches overnight meetings
  registerJob('meeting-pipeline-reconciliation', '0 6 * * *', 'Europe/Berlin', async () => {
    const { processNewMeetings } = await import('../pipeline/index.js');
    await processNewMeetings();
  });
}
