import { registerJob } from './index.js';
import { processAllPendingFeedback } from '../learning/feedback.js';

export function registerLearningJobs(): void {
  // Phase 1: Feedback processing (every 4 hours)
  registerJob('feedback-processing', '0 */4 * * *', 'Europe/Berlin', async () => {
    await processAllPendingFeedback();
  });

  // Phase 2: Decision evaluation (daily 10am Berlin)
  registerJob('decision-evaluation', '0 10 * * *', 'Europe/Berlin', async () => {
    const { evaluatePendingDecisions } = await import('../learning/decision-evaluator.js');
    await evaluatePendingDecisions();
  });

  // Phase 3: Transcript ingestion (Sundays 8am Berlin)
  registerJob('transcript-ingestion', '0 8 * * 0', 'Europe/Berlin', async () => {
    const { ingestNewTranscripts } = await import('../learning/transcript-ingestor.js');
    await ingestNewTranscripts();
  });

  // Phase 4: Learning synthesis (Sundays 9am Berlin)
  registerJob('learning-synthesis', '0 9 * * 0', 'Europe/Berlin', async () => {
    const { synthesizeLearnings } = await import('../learning/learning-synthesizer.js');
    await synthesizeLearnings();
  });

  // Phase 5: Weekly reflection (Mondays 9:30am Berlin)
  registerJob('weekly-reflection', '30 9 * * 1', 'Europe/Berlin', async () => {
    const { generateWeeklyReflection } = await import('../learning/weekly-reflection.js');
    await generateWeeklyReflection();
  });

  // Nina/Daniel call monitoring (daily 9am Berlin)
  registerJob('nina-daniel-monitoring', '0 9 * * *', 'Europe/Berlin', async () => {
    const { monitorNinaDanielCalls } = await import('../learning/transcript-ingestor.js');
    await monitorNinaDanielCalls();
  });
}
