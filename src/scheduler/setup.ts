import { registerBriefingJobs } from './briefings.js';
import { registerLearningJobs } from './learning-jobs.js';
import { registerNudgeJobs } from './task-nudge.js';
import { registerTriageJobs } from './triage-jobs.js';

export function setupScheduledJobs(): void {
  registerBriefingJobs();
  registerLearningJobs();
  registerNudgeJobs();
  registerTriageJobs();
}
