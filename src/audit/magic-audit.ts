import { randomBytes } from 'node:crypto';
import { getSupabase } from '../integrations/supabase.js';
import { executeTool } from '../agents/tool-registry.js';
import type { ToolContext } from '../agents/tool-registry.js';
import { logger } from '../utils/logger.js';

/**
 * Magic Audit orchestrator (master-plan B1).
 *
 * Runs audit sections against a client account and writes results
 * progressively into the bmad `magic_audits` row — the report page renders
 * from that row, so sections appear as they complete (staged reveal, D5).
 *
 * Sections reuse Ada's registered tools via executeTool(), so every
 * capability she gains is automatically audit-able. v1 implements
 * dataset_health (B9 tool) + account_structure; the rest are declared
 * placeholders so the report shape is stable from day one.
 */

export interface AuditSection {
  key: string;
  title: string;
  status: 'pending' | 'running' | 'complete' | 'error' | 'planned';
  summary?: string;
  data?: unknown;
  warnings?: string[];
  error?: string;
  completed_at?: string;
}

const SECTION_ORDER: Array<Pick<AuditSection, 'key' | 'title' | 'status'>> = [
  { key: 'dataset_health', title: 'Data Foundation — pixel, CAPI & match quality', status: 'pending' },
  { key: 'account_structure', title: 'Account Structure & Spend Concentration', status: 'pending' },
  { key: 'creative_analysis', title: 'Creative Performance & Angles', status: 'planned' },
  { key: 'funnel_read', title: 'Funnel Diagnosis vs Benchmarks', status: 'planned' },
  { key: 'competitor_teardown', title: 'Competitor Landscape', status: 'planned' },
];

const toolCtx = (clientCode: string): ToolContext => ({
  agentId: 'magic-audit',
  channelId: `internal-audit-${clientCode.toLowerCase()}`,
  userId: 'magic-audit',
  threadTs: undefined,
  clientScope: undefined,
});

async function updateRow(auditId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await getSupabase()
    .from('magic_audits')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', auditId);
  if (error) logger.error({ error, auditId }, 'magic_audits update failed');
}

async function saveSection(
  auditId: string,
  sections: Record<string, AuditSection>,
  section: AuditSection,
): Promise<void> {
  sections[section.key] = section;
  await updateRow(auditId, { sections });
}

// ---------------------------------------------------------------------------
// Section runners
// ---------------------------------------------------------------------------

async function runDatasetHealth(clientCode: string): Promise<Partial<AuditSection>> {
  const { result, isError } = await executeTool(
    'audit_dataset_health',
    { client_code: clientCode },
    toolCtx(clientCode),
  );
  if (isError) return { status: 'error', error: result.slice(0, 500) };
  const parsed = JSON.parse(result) as {
    error?: string;
    pixels?: Array<{ pixel_name: string; warnings: string[]; config: Record<string, unknown>; source_split_last_day: Record<string, unknown> }>;
  };
  if (parsed.error) return { status: 'error', error: parsed.error };
  const warnings = (parsed.pixels ?? []).flatMap((p) => p.warnings.map((w) => `${p.pixel_name}: ${w}`));
  const summary =
    warnings.length === 0
      ? `All ${parsed.pixels?.length ?? 0} pixel(s) healthy: advanced matching on, no restriction flags, CAPI + browser both firing.`
      : `${warnings.length} finding(s) in the tracking foundation — see warnings.`;
  return { status: 'complete', summary, data: parsed, warnings };
}

async function runAccountStructure(clientCode: string): Promise<Partial<AuditSection>> {
  const { result, isError } = await executeTool(
    'get_campaign_summary',
    { clientCode, days: 30 },
    toolCtx(clientCode),
  );
  if (isError) return { status: 'error', error: result.slice(0, 500) };
  let campaigns: Array<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(result) as unknown;
    campaigns = Array.isArray(parsed)
      ? (parsed as Array<Record<string, unknown>>)
      : ((parsed as Record<string, unknown>).campaigns as Array<Record<string, unknown>> ?? []);
  } catch {
    return { status: 'error', error: 'unparseable campaign summary' };
  }
  const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
  const withSpend = campaigns
    .map((c) => ({ name: String(c.campaign_name ?? c.name ?? 'unknown'), spend: num(c.spend ?? c.total_spend) }))
    .filter((c) => c.spend > 0)
    .sort((a, b) => b.spend - a.spend);
  const total = withSpend.reduce((s, c) => s + c.spend, 0);
  const top = withSpend[0];
  const topShare = top && total > 0 ? Math.round((top.spend / total) * 100) : 0;
  const warnings: string[] = [];
  if (topShare >= 70) {
    warnings.push(`${topShare}% of 30-day spend runs through one campaign ("${top!.name}") — concentration risk.`);
  }
  if (withSpend.length === 0) warnings.push('No campaigns with spend in the last 30 days.');
  return {
    status: 'complete',
    summary: `${withSpend.length} campaigns spent in the last 30 days; top campaign carries ${topShare}% of spend.`,
    data: { total_spend_30d: Math.round(total), campaigns: withSpend.slice(0, 10) },
    warnings,
  };
}

const SECTION_RUNNERS: Record<string, (clientCode: string) => Promise<Partial<AuditSection>>> = {
  dataset_health: runDatasetHealth,
  account_structure: runAccountStructure,
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runMagicAudit(clientCode: string): Promise<{ auditId: string; token: string }> {
  const supabase = getSupabase();
  const code = clientCode.toUpperCase();
  const { data: client } = await supabase
    .from('clients')
    .select('code, name')
    .ilike('code', code)
    .single();

  const token = randomBytes(16).toString('hex');
  const sections: Record<string, AuditSection> = {};
  for (const s of SECTION_ORDER) sections[s.key] = { ...s };

  const { data: row, error } = await supabase
    .from('magic_audits')
    .insert({ token, client_code: code, client_name: client?.name ?? null, sections })
    .select('id')
    .single();
  if (error || !row) throw new Error(`audit row insert failed: ${error?.message}`);
  const auditId = row.id as string;
  logger.info({ auditId, token, clientCode: code }, 'Magic audit started');

  let anyError = false;
  for (const def of SECTION_ORDER) {
    const runner = SECTION_RUNNERS[def.key];
    if (!runner) continue; // planned sections stay as declared
    await saveSection(auditId, sections, { ...sections[def.key]!, status: 'running' });
    try {
      const partial = await runner(code);
      await saveSection(auditId, sections, {
        ...sections[def.key]!,
        ...partial,
        status: partial.status ?? 'complete',
        completed_at: new Date().toISOString(),
      });
      if (partial.status === 'error') anyError = true;
    } catch (err) {
      anyError = true;
      await saveSection(auditId, sections, {
        ...sections[def.key]!,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await updateRow(auditId, { status: anyError ? 'error' : 'complete' });
  logger.info({ auditId, anyError }, 'Magic audit finished');
  return { auditId, token };
}
