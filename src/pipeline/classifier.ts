/**
 * Rule-based meeting classifier — zero LLM cost.
 *
 * Scans participant emails through the domain registry, falls back to
 * title/pattern matching. Produces a classification that drives extraction
 * and routing decisions downstream.
 */

import { resolveClientFromParticipants, isInternalEmail } from '../config/client-domains.js';
import { matchMeetingPattern } from '../learning/meeting-patterns.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MeetingRow {
  id: string;
  title: string | null;
  date: string | null;
  speakers: string[] | null;
  participant_emails: string[] | null;
  short_summary: string | null;
  organizer_email: string | null;
}

export type MeetingType =
  | 'client_call'
  | 'internal_review'
  | 'strategy'
  | 'onboarding'
  | 'unknown';

export interface MeetingClassification {
  client_code: string | null;
  client_name: string | null;
  meeting_type: MeetingType;
  is_external: boolean;
  confidence: number;
  matched_pattern: string | null;
}

// ---------------------------------------------------------------------------
// Title-based client inference (fallback when no email match)
// ---------------------------------------------------------------------------

const TITLE_CLIENT_PATTERNS: Array<{ pattern: RegExp; clientCode: string; clientName: string }> = [
  { pattern: /audibene/i, clientCode: 'AB', clientName: 'Audibene' },
  { pattern: /teethlovers/i, clientCode: 'TL', clientName: 'Teethlovers' },
  { pattern: /ninepine/i, clientCode: 'NP', clientName: 'Ninepine' },
  { pattern: /laori/i, clientCode: 'LA', clientName: 'Laori' },
  { pattern: /press\s*london/i, clientCode: 'PL', clientName: 'Press London' },
  { pattern: /brain\.?fm/i, clientCode: 'BFM', clientName: 'Brain.fm' },
  { pattern: /slumber/i, clientCode: 'SLB', clientName: 'Slumber' },
  { pattern: /urvi/i, clientCode: 'URV', clientName: 'URVI' },
  { pattern: /jv\s*academy/i, clientCode: 'JVA', clientName: 'JV Academy' },
  { pattern: /strayz|meow/i, clientCode: 'MEOW', clientName: 'Strayz' },
  { pattern: /freeletics/i, clientCode: 'FP', clientName: 'Freeletics' },
  { pattern: /comis/i, clientCode: 'COM', clientName: 'COMIS' },
  { pattern: /kousha/i, clientCode: 'NP', clientName: 'Ninepine' }, // Kousha = Ninepine founder
];

// ---------------------------------------------------------------------------
// Meeting type inference
// ---------------------------------------------------------------------------

function inferMeetingType(title: string, patternId: string | null): MeetingType {
  const lower = title.toLowerCase();

  if (/onboard|kick\s*off|kickoff|new\s*client/i.test(lower)) return 'onboarding';
  if (/strateg|roadmap|planning/i.test(lower)) return 'strategy';
  if (patternId === 'nina-daniel-biweekly') return 'internal_review';
  if (/internal|stand[\s-]*up|team\s*sync|all\s*hands/i.test(lower)) return 'internal_review';

  // If we have a client match, it's likely a client call
  return 'client_call';
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

export function classifyMeeting(meeting: MeetingRow): MeetingClassification {
  // Fireflies sometimes packs multiple emails into a single array entry (comma-separated)
  const emails = (meeting.participant_emails ?? [])
    .flatMap((e) => e.split(','))
    .map((e) => e.trim())
    .filter(Boolean);
  const title = meeting.title ?? '';
  const speakers = meeting.speakers ?? [];
  const summary = meeting.short_summary ?? undefined;

  // Stage 1: Try email-based resolution (highest confidence)
  const emailMatch = resolveClientFromParticipants(emails);

  if (emailMatch) {
    const hasExternalParticipants = emails.some((e) => !isInternalEmail(e));
    const pattern = matchMeetingPattern(title, speakers, summary);

    return {
      client_code: emailMatch.clientCode,
      client_name: emailMatch.clientName,
      meeting_type: inferMeetingType(title, pattern?.id ?? null),
      is_external: hasExternalParticipants,
      confidence: emailMatch.confidence,
      matched_pattern: pattern?.id ?? null,
    };
  }

  // Stage 2: Try title + pattern matching
  const pattern = matchMeetingPattern(title, speakers, summary);

  // Check title for client name
  const searchText = summary ? `${title} ${summary}` : title;
  for (const { pattern: re, clientCode, clientName } of TITLE_CLIENT_PATTERNS) {
    if (re.test(searchText)) {
      const hasExternalParticipants = emails.some((e) => !isInternalEmail(e));
      return {
        client_code: clientCode,
        client_name: clientName,
        meeting_type: inferMeetingType(title, pattern?.id ?? null),
        is_external: hasExternalParticipants,
        confidence: pattern ? 0.8 : 0.5,
        matched_pattern: pattern?.id ?? null,
      };
    }
  }

  // Stage 3: Check if it's an internal-only meeting
  const allInternal = emails.length > 0 && emails.every((e) => isInternalEmail(e));

  if (allInternal) {
    return {
      client_code: null,
      client_name: null,
      meeting_type: inferMeetingType(title, pattern?.id ?? null),
      is_external: false,
      confidence: 0.7,
      matched_pattern: pattern?.id ?? null,
    };
  }

  // Stage 4: Unknown
  return {
    client_code: null,
    client_name: null,
    meeting_type: 'unknown',
    is_external: emails.some((e) => !isInternalEmail(e)),
    confidence: 0.0,
    matched_pattern: pattern?.id ?? null,
  };
}
