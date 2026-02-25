import { registerBriefingJobs } from './briefings.js';
import { registerLearningJobs } from './learning-jobs.js';

export function setupScheduledJobs(): void {
  registerBriefingJobs();
  registerLearningJobs();
}
