/**
 * Supabase CRUD operations for the triage queue.
 */

import { getDaiSupabase } from '../integrations/dai-supabase.js';
import { logger } from '../utils/logger.js';
import type { TriageItem, TriageQueueRow, TriageStatus } from './index.js';

// ---------------------------------------------------------------------------
// Upsert (insert or escalate)
// ---------------------------------------------------------------------------

export async function upsertTriageItem(item: TriageItem): Promise<void> {
  const supabase = getDaiSupabase();
  const { error } = await supabase
    .from('triage_queue')
    .upsert(
      {
        source: item.source,
        source_id: item.source_id,
        priority: item.priority,
        priority_num: item.priority_num,
        title: item.title,
        preview: item.preview ?? null,
        reason: item.reason,
        suggested_action: item.suggested_action ?? null,
        metadata: item.metadata,
        status: 'pending',
        detected_at: new Date().toISOString(),
      },
      { onConflict: 'source_id' },
    );

  if (error) {
    logger.error({ error, source_id: item.source_id }, 'Failed to upsert triage item');
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getPendingItems(maxPriorityNum = 3): Promise<TriageQueueRow[]> {
  const supabase = getDaiSupabase();
  const { data, error } = await supabase.rpc('get_pending_triage', {
    max_priority_num: maxPriorityNum,
  });

  if (error) {
    logger.error({ error }, 'Failed to get pending triage items');
    return [];
  }
  return (data ?? []) as TriageQueueRow[];
}

export async function getItemsByStatus(status: TriageStatus): Promise<TriageQueueRow[]> {
  const supabase = getDaiSupabase();
  const { data, error } = await supabase
    .from('triage_queue')
    .select('*')
    .eq('status', status)
    .order('priority_num', { ascending: true })
    .order('detected_at', { ascending: true });

  if (error) {
    logger.error({ error, status }, 'Failed to get triage items by status');
    return [];
  }
  return (data ?? []) as TriageQueueRow[];
}

export async function getUnresolvedItems(): Promise<TriageQueueRow[]> {
  const supabase = getDaiSupabase();
  const { data, error } = await supabase
    .from('triage_queue')
    .select('*')
    .in('status', ['pending', 'notified', 'snoozed'])
    .order('priority_num', { ascending: true })
    .order('detected_at', { ascending: true });

  if (error) {
    logger.error({ error }, 'Failed to get unresolved triage items');
    return [];
  }
  return (data ?? []) as TriageQueueRow[];
}

// ---------------------------------------------------------------------------
// Status updates
// ---------------------------------------------------------------------------

export async function updateItemStatus(
  id: string,
  status: TriageStatus,
  extra?: Partial<Pick<TriageQueueRow, 'notified_at' | 'snoozed_until' | 'notification_ts'>>,
): Promise<void> {
  const supabase = getDaiSupabase();
  const { error } = await supabase
    .from('triage_queue')
    .update({ status, ...extra })
    .eq('id', id);

  if (error) {
    logger.error({ error, id, status }, 'Failed to update triage item status');
  }
}

export async function batchUpdateStatus(
  ids: string[],
  status: TriageStatus,
): Promise<void> {
  if (ids.length === 0) return;
  const supabase = getDaiSupabase();
  const { error } = await supabase
    .from('triage_queue')
    .update({ status })
    .in('id', ids);

  if (error) {
    logger.error({ error, count: ids.length, status }, 'Failed to batch update triage items');
  }
}

export async function resolveBySourceId(sourceId: string): Promise<void> {
  const supabase = getDaiSupabase();
  const { error } = await supabase
    .from('triage_queue')
    .update({ status: 'resolved' as TriageStatus })
    .eq('source_id', sourceId)
    .in('status', ['pending', 'notified', 'snoozed']);

  if (error) {
    logger.error({ error, sourceId }, 'Failed to resolve triage item by source_id');
  }
}

// ---------------------------------------------------------------------------
// Maintenance RPCs
// ---------------------------------------------------------------------------

export async function unsnoozeExpiredItems(): Promise<number> {
  const supabase = getDaiSupabase();
  const { data, error } = await supabase.rpc('unsnooze_triage_items');
  if (error) {
    logger.error({ error }, 'Failed to unsnooze triage items');
    return 0;
  }
  return (data as number) ?? 0;
}

export async function expireOldItems(maxAgeHours = 48): Promise<number> {
  const supabase = getDaiSupabase();
  const { data, error } = await supabase.rpc('expire_old_triage_items', {
    max_age_hours: maxAgeHours,
  });
  if (error) {
    logger.error({ error }, 'Failed to expire old triage items');
    return 0;
  }
  return (data as number) ?? 0;
}

// ---------------------------------------------------------------------------
// Scan state (watermarks)
// ---------------------------------------------------------------------------

export async function getScanWatermark(sourceId: string): Promise<string | null> {
  const supabase = getDaiSupabase();
  const { data, error } = await supabase
    .from('triage_scan_state')
    .select('watermark')
    .eq('source_id', sourceId)
    .single();

  if (error) return null;
  return (data as { watermark: string | null })?.watermark ?? null;
}

export async function updateScanWatermark(
  sourceId: string,
  watermark: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  const supabase = getDaiSupabase();
  const { error } = await supabase
    .from('triage_scan_state')
    .upsert({
      source_id: sourceId,
      watermark,
      last_scan_at: new Date().toISOString(),
      extra: extra ?? {},
      updated_at: new Date().toISOString(),
    });

  if (error) {
    logger.error({ error, sourceId }, 'Failed to update scan watermark');
  }
}
