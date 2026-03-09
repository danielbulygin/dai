import { gatherReportData } from './data-gatherer.js';
import { condenseReport } from './data-condenser.js';
import { generateNarrative } from './narrative-generator.js';
import { getDaiSupabase } from '../integrations/dai-supabase.js';
import { logger } from '../utils/logger.js';
import type { ReportResult } from './types.js';

// ---------------------------------------------------------------------------
// Pipeline orchestrator
// ---------------------------------------------------------------------------

export async function generateReport(
  clientCode: string,
  days = 7,
): Promise<ReportResult> {
  const startTime = Date.now();
  logger.info({ clientCode, days }, 'Starting report generation pipeline');

  // Stage 1: Data gathering
  const rawData = await gatherReportData(clientCode, days);

  // Stage 2: Condensation
  const condensed = condenseReport(rawData);

  // Stage 3: Narrative generation
  const result = await generateNarrative(condensed);

  // Persist to Supabase
  await persistReport(clientCode, days, result);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info(
    {
      clientCode,
      elapsed: `${elapsed}s`,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      healthScore: condensed.healthScore,
    },
    'Report generation complete',
  );

  return result;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistReport(
  clientCode: string,
  days: number,
  result: ReportResult,
): Promise<void> {
  try {
    const supabase = getDaiSupabase();

    // Calculate the report week (Monday of the current week)
    const now = new Date();
    const dayOfWeek = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
    const reportWeek = monday.toISOString().slice(0, 10);

    const { error } = await supabase.from('client_reports').upsert(
      {
        client_code: clientCode.toUpperCase(),
        report_week: reportWeek,
        report_text: result.reportText,
        condensed_data: result.condensedData,
        status: 'draft',
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_code,report_week' },
    );

    if (error) {
      logger.error({ error, clientCode }, 'Failed to persist report');
      return;
    }

    logger.info({ clientCode, reportWeek }, 'Report persisted to Supabase');
  } catch (err) {
    logger.error({ err, clientCode }, 'Failed to persist report');
  }
}

export { gatherReportData, condenseReport, generateNarrative };
export type { ReportResult } from './types.js';
