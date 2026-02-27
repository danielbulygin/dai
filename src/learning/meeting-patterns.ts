export interface MeetingPattern {
  id: string;
  titlePattern: RegExp;
  speakerPattern?: RegExp;
  description: string;
  extractionFocus: string;
}

export const MEETING_PATTERNS: MeetingPattern[] = [
  // --- Priority 1: Nina-Daniel internal reviews ---
  {
    id: 'nina-daniel-biweekly',
    titlePattern: /nina|account\s*review|media\s*buying\s*review/i,
    speakerPattern: /nina|daniel/i,
    description: 'Nina & Daniel bi-weekly account reviews',
    extractionFocus: 'account-specific insights, kill/scale decisions, creative observations, client context',
  },

  // --- Priority 2: Client-specific calls ---
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
  {
    id: 'press-london',
    titlePattern: /press\s*london/i,
    description: 'Press London calls',
    extractionFocus: 'account performance, creative strategy, seasonal patterns, drinks vertical insights',
  },
  {
    id: 'brain-fm',
    titlePattern: /brain\.?fm/i,
    description: 'Brain.fm calls',
    extractionFocus: 'app install campaigns, subscription funnel, creative performance, retention signals',
  },
  {
    id: 'slumber',
    titlePattern: /slumber/i,
    description: 'Slumber calls',
    extractionFocus: 'account performance, creative strategy, health/wellness vertical insights',
  },
  {
    id: 'laori',
    titlePattern: /laori/i,
    description: 'Laori calls',
    extractionFocus: 'account performance, non-alcoholic beverages vertical, seasonal patterns',
  },
  {
    id: 'kousha',
    titlePattern: /kousha/i,
    description: 'Kousha calls',
    extractionFocus: 'account performance, optimization decisions, creative strategy',
  },
  {
    id: 'freeletics',
    titlePattern: /freeletics/i,
    description: 'Freeletics calls',
    extractionFocus: 'app install campaigns, fitness vertical, scaling strategy, bid caps',
  },
  {
    id: 'lassie',
    titlePattern: /lassie/i,
    description: 'Lassie calls',
    extractionFocus: 'lead generation, insurance vertical, CR2 tracking, funnel optimization',
  },

  // --- Priority 3: General media buying meetings ---
  {
    id: 'ads-strategy',
    titlePattern: /ads?\s*strateg|performance\s*market|media\s*buy|campaign\s*review|ad\s*performance|creative\s*review/i,
    description: 'General ads strategy and performance meetings',
    extractionFocus: 'cross-account patterns, methodology discussions, strategic decisions, platform trends',
  },
  {
    id: 'client-onboarding',
    titlePattern: /onboard|kick\s*off|kickoff|new\s*client/i,
    description: 'Client onboarding and kickoff meetings',
    extractionFocus: 'account setup methodology, initial audit process, target setting, account structure decisions',
  },
];

export function matchMeetingPattern(
  title: string,
  speakers?: string[],
  summary?: string,
): MeetingPattern | undefined {
  const searchText = summary ? `${title} ${summary}` : title;

  for (const pattern of MEETING_PATTERNS) {
    if (!pattern.titlePattern.test(searchText)) continue;

    if (pattern.speakerPattern && speakers) {
      const hasSpeaker = speakers.some((s) => pattern.speakerPattern!.test(s));
      if (!hasSpeaker) continue;
    }

    return pattern;
  }

  return undefined;
}
