import { registerAdaMonitoringJobs } from './ada-monitoring-jobs.js';
import { registerBriefingJobs } from './briefings.js';
import { registerLearningJobs } from './learning-jobs.js';
import { registerMayaJobs } from './maya-jobs.js';
import { registerNudgeJobs } from './task-nudge.js';
import { registerPipelineJobs } from './pipeline-jobs.js';
import { registerTriageJobs } from './triage-jobs.js';

export function setupScheduledJobs(): void {
  registerAdaMonitoringJobs();
  registerBriefingJobs();
  registerLearningJobs();
  registerMayaJobs();
  registerNudgeJobs();
  registerPipelineJobs();
  registerTriageJobs();
}
