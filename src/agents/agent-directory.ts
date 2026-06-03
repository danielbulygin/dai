/**
 * Shared directory of every AI agent (and key humans) across runtimes, with their
 * Slack user IDs. Injected into every dedicated-bot agent's system prompt so agents
 * can emit REAL Slack mentions (`<@U...>`) at each other.
 *
 * Why: in the 2026-06-03 agent-office demo Ada wrote a literal "@Ace" — she had no
 * way to know Ace's user ID (Ace runs in the separate aot-agents service and isn't
 * in this registry). A plain-text tag triggers nothing.
 *
 * Keep in sync with aot-agents (Ace reads the same map from its persona).
 */

export interface AgentDirectoryEntry {
  name: string;
  slackUserId: string;
  runtime: 'dai' | 'aot-agents' | 'human';
  lane: string;
}

export const AGENT_DIRECTORY: AgentDirectoryEntry[] = [
  { name: 'Ada', slackUserId: 'U0AHK9K5GEB', runtime: 'dai', lane: 'Media buying & performance — spend → performance, launch flow, optimization calls' },
  { name: 'Piper', slackUserId: 'U0B7AF0N3CL', runtime: 'dai', lane: 'Production pipeline — concept → upload, cadence, what is slipping' },
  { name: 'Ace', slackUserId: 'U0B4VEG1JLB', runtime: 'aot-agents', lane: 'Account management — agendas, recaps, approvals, client comms (works with Vanessa)' },
  { name: 'Dan', slackUserId: 'U084AS8QRA7', runtime: 'human', lane: 'Owner' },
  { name: 'Nina', slackUserId: 'U08LEQVHDRU', runtime: 'human', lane: 'Media buyer' },
];

/** Channel where agents are allowed to talk to each other (hop-budgeted). */
export const AGENT_OFFICE_CHANNEL_ID = 'C0B83JXLPK6';

/** Render the directory as a system-prompt section. */
export function buildAgentDirectorySection(selfName?: string): string {
  const rows = AGENT_DIRECTORY.map(
    (a) =>
      `- ${a.name}${selfName && a.name.toLowerCase() === selfName.toLowerCase() ? ' (you)' : ''} — \`<@${a.slackUserId}>\` — ${a.lane}`,
  ).join('\n');
  return [
    '## Agent & Team Directory (Slack)',
    'When you need to tag a teammate or another agent, ALWAYS use their real Slack mention from this list (the `<@U...>` form) — a plain-text "@Name" notifies nobody and triggers nothing.',
    rows,
    `Agent-to-agent conversations happen in the #agent-office channel (\`${AGENT_OFFICE_CHANNEL_ID}\`).`,
    'Agent-to-agent protocol: be terse (≤3 sentences or a tight bullet block, no greetings/sign-offs). Either ANSWER or HAND OFF by mentioning exactly ONE agent with one concrete question — never mention an agent unless you need them to act. When a chain started from a human question, the final answer must tag that human.',
  ].join('\n');
}
