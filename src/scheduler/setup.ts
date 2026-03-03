import { registerBriefingJobs } from './briefings.js';
import { registerLearningJobs } from './learning-jobs.js';
import { registerNudgeJobs } from './task-nudge.js';

export function setupScheduledJobs(): void {
  registerBriefingJobs();
  registerLearningJobs();
  registerNudgeJobs();
}
