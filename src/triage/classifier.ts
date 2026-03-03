/**
 * Rule-based priority classifier for triage items.
 * Zero LLM cost — pure heuristic rules based on sender, wait time, and keywords.
 */

import {
  type TriageItem,
  type TriagePriority,
  PRIORITY_NUM,
  VIP_NAMES,
  TEAM_DOMAINS,
  VIP_EMAILS,
  URGENCY_KEYWORDS,
  NOISE_PATTERNS,
} from './index.js';

// ---------------------------------------------------------------------------
// DM classification
// ---------------------------------------------------------------------------

export interface DmClassifyInput {
  userId: string;
  userName: string;
  channelId: string;
  lastMessageText: string;
  waitMinutes: number;
  unansweredCount: number;
}

export function classifyDm(input: DmClassifyInput): TriageItem {
  const nameLower = input.userName.toLowerCase();
  const isVip = VIP_NAMES.has(nameLower);

  let priority: TriagePriority;
  let reason: string;

  if (isVip) {
    if (input.waitMinutes >= 120) {
      priority = 'P0';
      reason = `VIP (${input.userName}) waiting ${formatWait(input.waitMinutes)}`;
    } else if (input.waitMinutes >= 30) {
      priority = 'P1';
      reason = `VIP (${input.userName}) waiting ${formatWait(input.waitMinutes)}`;
    } else {
      priority = 'P2';
      reason = `VIP (${input.userName}) — recent message`;
    }
  } else if (hasUrgencyKeywords(input.lastMessageText)) {
    if (input.waitMinutes >= 60) {
      priority = 'P1';
      reason = `Urgent language detected, waiting ${formatWait(input.waitMinutes)}`;
    } else {
      priority = 'P2';
      reason = `Urgent language detected`;
    }
  } else if (input.waitMinutes >= 480) {
    priority = 'P1';
    reason = `Waiting ${formatWait(input.waitMinutes)} — long unanswered`;
  } else if (input.waitMinutes >= 240) {
    priority = 'P2';
    reason = `Waiting ${formatWait(input.waitMinutes)}`;
  } else if (input.waitMinutes >= 60) {
    priority = 'P3';
    reason = `Waiting ${formatWait(input.waitMinutes)}`;
  } else {
    priority = 'P3';
    reason = 'Recent DM, not urgent';
  }

  const preview = input.lastMessageText.length > 200
    ? input.lastMessageText.slice(0, 200) + '...'
    : input.lastMessageText;

  return {
    source: 'slack_dm',
    source_id: `dm:${input.channelId}`,
    priority,
    priority_num: PRIORITY_NUM[priority],
    title: `Unanswered DM from ${input.userName}`,
    preview,
    reason,
    suggested_action: `Reply to ${input.userName}`,
    metadata: {
      user_id: input.userId,
      channel_id: input.channelId,
      wait_minutes: input.waitMinutes,
      unanswered_count: input.unansweredCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Email classification
// ---------------------------------------------------------------------------

export interface EmailClassifyInput {
  messageId: string;
  from: string;
  subject: string;
  snippet: string;
  account: string;
  unreadMinutes: number;
  isReplyToMyEmail?: boolean;
}

export function classifyEmail(input: EmailClassifyInput): TriageItem {
  const fromLower = input.from.toLowerCase();
  const subjectLower = input.subject.toLowerCase();

  // Noise detection — auto P3
  if (isNoiseEmail(fromLower, subjectLower)) {
    return makeEmailItem(input, 'P3', 'Newsletter / automated email');
  }

  const isVip = isVipEmail(fromLower);
  const isTeam = isTeamEmail(fromLower);
  const hasUrgency = hasUrgencyKeywords(subjectLower) || hasUrgencyKeywords(input.snippet.toLowerCase());

  let priority: TriagePriority;
  let reason: string;

  if (isVip || isTeam) {
    if (input.unreadMinutes >= 240) {
      priority = 'P1';
      reason = `${isVip ? 'VIP' : 'Team'} email unread ${formatWait(input.unreadMinutes)}`;
    } else if (input.unreadMinutes >= 60) {
      priority = 'P2';
      reason = `${isVip ? 'VIP' : 'Team'} email unread ${formatWait(input.unreadMinutes)}`;
    } else {
      priority = 'P3';
      reason = `${isVip ? 'VIP' : 'Team'} email — recent`;
    }
  } else if (input.isReplyToMyEmail && input.unreadMinutes >= 120) {
    priority = 'P2';
    reason = `Reply to your email, unread ${formatWait(input.unreadMinutes)}`;
  } else {
    priority = 'P3';
    reason = 'External email';
  }

  // Urgency keyword bump: escalate one tier (but not beyond P0)
  if (hasUrgency && PRIORITY_NUM[priority] > 0) {
    const bumped = PRIORITY_NUM[priority] - 1;
    const bumpedPriority = (['P0', 'P1', 'P2', 'P3'] as const)[bumped]!;
    reason += ' + urgency keywords detected';
    return makeEmailItem(input, bumpedPriority, reason);
  }

  return makeEmailItem(input, priority, reason);
}

function makeEmailItem(input: EmailClassifyInput, priority: TriagePriority, reason: string): TriageItem {
  const preview = input.snippet.length > 200
    ? input.snippet.slice(0, 200) + '...'
    : input.snippet;

  return {
    source: 'email',
    source_id: `email:${input.account}:${input.messageId}`,
    priority,
    priority_num: PRIORITY_NUM[priority],
    title: `Email from ${extractSenderName(input.from)}: "${input.subject}"`,
    preview,
    reason,
    suggested_action: 'Read and reply',
    metadata: {
      message_id: input.messageId,
      from: input.from,
      subject: input.subject,
      account: input.account,
      unread_minutes: input.unreadMinutes,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasUrgencyKeywords(text: string): boolean {
  return URGENCY_KEYWORDS.some((kw) => text.includes(kw));
}

function isVipEmail(fromLower: string): boolean {
  for (const name of VIP_EMAILS) {
    if (fromLower.includes(name)) return true;
  }
  return false;
}

function isTeamEmail(fromLower: string): boolean {
  for (const domain of TEAM_DOMAINS) {
    if (fromLower.includes(domain)) return true;
  }
  return false;
}

function isNoiseEmail(fromLower: string, subjectLower: string): boolean {
  return NOISE_PATTERNS.some((p) => fromLower.includes(p) || subjectLower.includes(p));
}

function extractSenderName(from: string): string {
  // "Franzi <franzi@adsontap.io>" → "Franzi"
  const match = from.match(/^([^<]+)</);
  if (match) return match[1].trim();
  // "franzi@adsontap.io" → "franzi"
  const atMatch = from.match(/^([^@]+)@/);
  if (atMatch) return atMatch[1].trim();
  return from;
}

function formatWait(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}
