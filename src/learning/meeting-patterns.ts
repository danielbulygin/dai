export interface MeetingPattern {
  id: string;
  titlePattern: RegExp;
  speakerPattern?: RegExp;
  description: string;
  extractionFocus: string;
}

export const MEETING_PATTERNS: MeetingPattern[] = [
  {
    id: 'nina-daniel-biweekly',
    titlePattern: /nina|account\s*review|media\s*buying\s*review/i,
    speakerPattern: /nina|daniel/i,
    description: 'Nina & Daniel bi-weekly account reviews',
    extractionFocus: 'account-specific insights, kill/scale decisions, creative observations, client context',
  },
  {
    id: 'comis-weekly',
    titlePattern: /comis/i,
    description: 'COMIS weekly calls',
    extractionFocus: 'account performance, strategy changes, client feedback, market context',
  },
  {
    id: 'ninepine',
    titlePattern: /ninepine/i,
    description: 'Ninepine calls',
    extractionFocus: 'account performance, optimization decisions, creative performance',
  },
];

export function matchMeetingPattern(
  title: string,
  speakers?: string[],
): MeetingPattern | undefined {
  for (const pattern of MEETING_PATTERNS) {
    if (!pattern.titlePattern.test(title)) continue;

    if (pattern.speakerPattern && speakers) {
      const hasSpeaker = speakers.some((s) => pattern.speakerPattern!.test(s));
      if (!hasSpeaker) continue;
    }

    return pattern;
  }

  return undefined;
}
