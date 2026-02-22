import { getAgent, loadAgentRegistry } from "../agents/registry.js";
import type { AgentDefinition } from "../agents/registry.js";

export interface RouteResult {
  agentId: string;
  cleanedText: string;
}

/**
 * Well-known agent keyword mappings.
 * Maps lowercase keywords to agent IDs for "hey coda" / "ask rex" patterns.
 */
const AGENT_KEYWORDS: ReadonlyMap<string, string> = new Map([
  ["otto", "otto"],
  ["coda", "coda"],
  ["rex", "rex"],
  ["sage", "sage"],
]);

/**
 * Patterns that prefix an agent name, e.g. "hey coda" or "ask rex".
 */
const PREFIX_PATTERN = /^(?:hey|ask|tell|ping|yo)\s+(\w+)/i;

/**
 * Extract all Slack user IDs from @mention syntax: <@U12345>.
 */
function extractMentions(text: string): string[] {
  const regex = /<@([A-Z0-9]+)>/g;
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    ids.push(match[1]!);
  }
  return ids;
}

/**
 * Strip the bot's @mention from the message text.
 */
function stripBotMention(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
}

/**
 * Try to find an agent whose display_name (case-insensitive) matches any of
 * the mentioned user IDs' names. This is a heuristic: since we don't have a
 * lookup from Slack user ID to our agent system, we compare against the
 * registry's display names.
 *
 * In practice, the bot's own @mention is the most common trigger.  When a
 * user says `@Otto ask Coda to review this`, we detect "Coda" as a keyword.
 */
function findAgentByKeyword(text: string): AgentDefinition | undefined {
  const lower = text.toLowerCase();

  // Check whole-word keyword match in the cleaned text
  const registry = loadAgentRegistry();
  for (const [, agent] of registry) {
    const name = agent.config.display_name.toLowerCase();
    const pattern = new RegExp(`\\b${name}\\b`, 'i');
    if (pattern.test(lower)) {
      return agent;
    }
  }

  return undefined;
}

/**
 * Try the "hey <name>" / "ask <name>" prefix pattern.
 */
function findAgentByPrefix(text: string): { agent: AgentDefinition; cleanedText: string } | undefined {
  const match = PREFIX_PATTERN.exec(text);
  if (!match) {
    return undefined;
  }

  const keyword = match[1]!.toLowerCase();
  const agentId = AGENT_KEYWORDS.get(keyword);
  if (!agentId) {
    return undefined;
  }

  const agent = getAgent(agentId);
  if (!agent) {
    return undefined;
  }

  // Remove the prefix pattern from the text
  const cleanedText = text.replace(PREFIX_PATTERN, "").trim();
  return { agent, cleanedText };
}

/**
 * Route a Slack message to the correct agent.
 *
 * Routing priority:
 * 1. "hey coda" / "ask rex" prefix patterns
 * 2. Agent display_name found as keyword in the cleaned text
 * 3. Default agent (otto)
 *
 * The bot's own @mention is stripped from the returned cleanedText regardless
 * of routing decision.
 */
export function routeMessage(text: string, botUserId: string): RouteResult {
  // Strip the bot's own @mention first
  const cleaned = stripBotMention(text, botUserId);

  // 1. Check for "hey coda" / "ask rex" prefix pattern
  const prefixResult = findAgentByPrefix(cleaned);
  if (prefixResult) {
    return {
      agentId: prefixResult.agent.config.id,
      cleanedText: prefixResult.cleanedText,
    };
  }

  // 2. Check for agent name keyword anywhere in the text
  const keywordAgent = findAgentByKeyword(cleaned);
  if (keywordAgent) {
    return {
      agentId: keywordAgent.config.id,
      cleanedText: cleaned,
    };
  }

  // 3. Default to otto
  return {
    agentId: "otto",
    cleanedText: cleaned,
  };
}
