/**
 * Triage system types, constants, and VIP configuration.
 *
 * Priority tiers:
 *   P0 = Critical (notify immediately, even in meetings)
 *   P1 = Urgent   (notify within 2 min if not in meeting)
 *   P2 = Needs Attention (batched every 2h during work hours)
 *   P3 = FYI (held for next briefing)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TriageSource = 'email' | 'slack_dm' | 'slack_channel' | 'calendar';
export type TriagePriority = 'P0' | 'P1' | 'P2' | 'P3';
export type TriageStatus = 'pending' | 'notified' | 'acknowledged' | 'snoozed' | 'resolved' | 'expired';

export interface TriageItem {
  source: TriageSource;
  source_id: string;
  priority: TriagePriority;
  priority_num: number;
  title: string;
  preview?: string;
  reason: string;
  suggested_action?: string;
  metadata: Record<string, unknown>;
}

export interface TriageQueueRow {
  id: string;
  source: TriageSource;
  source_id: string;
  priority: TriagePriority;
  priority_num: number;
  title: string;
  preview: string | null;
  reason: string | null;
  suggested_action: string | null;
  metadata: Record<string, unknown>;
  status: TriageStatus;
  detected_at: string;
  notified_at: string | null;
  snoozed_until: string | null;
  notification_ts: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PRIORITY_NUM: Record<TriagePriority, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

/** VIP Slack user display names (lowercased for matching) */
export const VIP_NAMES = new Set([
  'franzi', 'franziska',
  'nina',
  'aaron',
  'mikel',
]);

/** Email domains that indicate internal team */
export const TEAM_DOMAINS = new Set([
  'adsontap.io',
]);

/** VIP email addresses (lowercased) — matched by "from" field containing these */
export const VIP_EMAILS = new Set([
  'franzi', 'franziska',
  'nina',
  'aaron',
  'mikel',
]);

/** Subject keywords that indicate urgency (lowercased) */
export const URGENCY_KEYWORDS = [
  'urgent', 'asap', 'emergency', 'critical', 'immediately',
  'deadline', 'overdue', 'time-sensitive', 'action required',
  'action needed', 'please respond', 'waiting on you',
  'blocked', 'blocker',
];

/** Patterns indicating newsletter / marketing / no-reply emails → auto P3 */
export const NOISE_PATTERNS = [
  'noreply', 'no-reply', 'newsletter', 'unsubscribe',
  'marketing', 'promotions', 'notifications@',
  'digest@', 'updates@', 'info@',
];

/** Work hours (Berlin time) */
export const WORK_HOURS = { start: 9, end: 19 };

/** How often each scanner runs (minutes) */
export const SCAN_INTERVAL_MIN = 5;

/** How often the dispatcher runs (minutes) */
export const DISPATCH_INTERVAL_MIN = 2;

/** P2 batch interval (hours) */
export const P2_BATCH_INTERVAL_HOURS = 2;

/** Maximum age before auto-expire (hours) */
export const MAX_AGE_HOURS = 48;

/** Snooze duration (minutes) */
export const SNOOZE_DURATION_MIN = 60;

/** Meeting check cache TTL (ms) */
export const MEETING_CHECK_CACHE_MS = 5 * 60 * 1000;
