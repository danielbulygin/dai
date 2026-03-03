import Anthropic from "@anthropic-ai/sdk";
import {
  getUnanalyzedMessages,
  markAnalyzed,
  cleanOldMessages,
  type MonitoredMessage,
} from "./buffer.js";
import { postMessage } from "../agents/tools/slack-tools.js";
import { getDaiSupabase } from "../integrations/dai-supabase.js";
import { env } from "../env.js";
import { logger } from "../utils/logger.js";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

const ANALYSIS_MODEL = "claude-sonnet-4-20250514";

export interface AnalysisResult {
  blockers: string[];
  urgent: string[];
  notable: string[];
  suggestedActions: string[];
  messageCount: number;
}

function groupByChannel(
  messages: MonitoredMessage[],
): Map<string, MonitoredMessage[]> {
  const groups = new Map<string, MonitoredMessage[]>();
  for (const msg of messages) {
    const key = msg.channel_name ?? msg.channel_id;
    const existing = groups.get(key);
    if (existing) {
      existing.push(msg);
    } else {
      groups.set(key, [msg]);
    }
  }
  return groups;
}

function groupByThread(
  messages: MonitoredMessage[],
): Map<string | null, MonitoredMessage[]> {
  const threads = new Map<string | null, MonitoredMessage[]>();
  for (const msg of messages) {
    const key = msg.thread_ts ?? null;
    const existing = threads.get(key);
    if (existing) {
      existing.push(msg);
    } else {
      threads.set(key, [msg]);
    }
  }
  return threads;
}

function buildAnalysisPrompt(
  grouped: Map<string, MonitoredMessage[]>,
): string {
  const parts: string[] = [];

  parts.push(
    "You are a personal assistant analyzing Slack messages to help Daniel triage his work.",
  );
  parts.push(
    "Analyze the following messages from various Slack channels and categorize them.",
  );
  parts.push(
    "Daniel's user ID for reference: " + env.SLACK_OWNER_USER_ID,
  );
  parts.push("");
  parts.push(
    "IMPORTANT: Messages tagged with `@owner-reply` are from Daniel himself — they indicate he has already responded in that thread. " +
    "Do NOT list threads containing an @owner-reply as blockers or urgent. " +
    "Only mention them under Notable if someone posted a follow-up question AFTER Daniel's reply.",
  );
  parts.push("");
  parts.push("Messages grouped by channel:");
  parts.push("");

  for (const [channel, messages] of grouped) {
    parts.push(`### #${channel}`);

    // Sub-group by thread to make reply context visible
    const threads = groupByThread(messages);
    for (const [threadTs, threadMsgs] of threads) {
      if (threadTs) {
        const hasOwnerReply = threadMsgs.some((m) => m.matched_keywords?.includes("@owner-reply"));
        parts.push(`  Thread (${hasOwnerReply ? "Daniel replied" : "no reply from Daniel"}):`);
      }
      for (const msg of threadMsgs) {
        const user = msg.user_name ?? msg.user_id;
        const keywords = msg.matched_keywords ? ` [keywords: ${msg.matched_keywords}]` : "";
        const priority = msg.priority === "high" ? " [HIGH PRIORITY]" : "";
        const indent = threadTs ? "    " : "";
        parts.push(`${indent}- ${user}: ${msg.text}${keywords}${priority}`);
      }
    }
    parts.push("");
  }

  parts.push("Respond with a structured analysis using exactly these sections:");
  parts.push("");
  parts.push("## Blockers on Daniel");
  parts.push("Things people are waiting on Daniel for. List each as a bullet point, or write 'None detected' if there are no blockers.");
  parts.push("");
  parts.push("## Urgent items");
  parts.push("Time-sensitive requests or escalations that need immediate attention. List each as a bullet point, or write 'None detected'.");
  parts.push("");
  parts.push("## Notable updates");
  parts.push("Important but not urgent information Daniel should be aware of. List each as a bullet point, or write 'None detected'.");
  parts.push("");
  parts.push("## Suggested actions");
  parts.push("What Daniel should do next, in priority order. List each as a bullet point, or write 'No actions needed'.");

  return parts.join("\n");
}

function parseAnalysisResponse(text: string): AnalysisResult {
  const blockers: string[] = [];
  const urgent: string[] = [];
  const notable: string[] = [];
  const suggestedActions: string[] = [];

  type SectionKey = "blockers" | "urgent" | "notable" | "suggestedActions";
  const sectionArrays: Record<SectionKey, string[]> = {
    blockers,
    urgent,
    notable,
    suggestedActions,
  };

  let currentSection: SectionKey | null = null;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();

    if (trimmed.toLowerCase().includes("blockers on daniel")) {
      currentSection = "blockers";
    } else if (trimmed.toLowerCase().includes("urgent item")) {
      currentSection = "urgent";
    } else if (trimmed.toLowerCase().includes("notable update")) {
      currentSection = "notable";
    } else if (trimmed.toLowerCase().includes("suggested action")) {
      currentSection = "suggestedActions";
    } else if (currentSection && trimmed.startsWith("- ")) {
      const content = trimmed.slice(2).trim();
      if (
        content.toLowerCase() !== "none detected" &&
        content.toLowerCase() !== "no actions needed" &&
        content.toLowerCase() !== "none"
      ) {
        sectionArrays[currentSection].push(content);
      }
    }
  }

  return {
    blockers,
    urgent,
    notable,
    suggestedActions,
    messageCount: 0, // filled by caller
  };
}

function formatDmSummary(result: AnalysisResult): string {
  const parts: string[] = [];
  parts.push(":eyes: *Channel Monitor Summary*\n");

  if (result.blockers.length > 0) {
    parts.push(":rotating_light: *Blockers on you:*");
    for (const item of result.blockers) {
      parts.push(`  - ${item}`);
    }
    parts.push("");
  }

  if (result.urgent.length > 0) {
    parts.push(":warning: *Urgent items:*");
    for (const item of result.urgent) {
      parts.push(`  - ${item}`);
    }
    parts.push("");
  }

  if (result.notable.length > 0) {
    parts.push(":bulb: *Notable updates:*");
    for (const item of result.notable) {
      parts.push(`  - ${item}`);
    }
    parts.push("");
  }

  if (result.suggestedActions.length > 0) {
    parts.push(":dart: *Suggested actions:*");
    for (const item of result.suggestedActions) {
      parts.push(`  - ${item}`);
    }
  }

  return parts.join("\n");
}

async function persistInsight(result: AnalysisResult): Promise<void> {
  try {
    const supabase = getDaiSupabase();

    const { error } = await supabase.from("monitoring_insights").insert({
      message_count: result.messageCount,
      blockers: result.blockers,
      urgent: result.urgent,
      notable: result.notable,
      suggested_actions: result.suggestedActions,
      has_high_priority:
        result.blockers.length > 0 || result.urgent.length > 0,
    });

    if (error) {
      logger.error({ error }, "Failed to persist monitoring insight to Supabase");
      return;
    }

    logger.info(
      { messageCount: result.messageCount },
      "Persisted monitoring insight to Supabase",
    );
  } catch (err) {
    logger.error({ err }, "Failed to persist monitoring insight to Supabase");
  }
}

export async function analyzeBufferedMessages(): Promise<AnalysisResult | null> {
  const messages = await getUnanalyzedMessages(100);

  if (messages.length === 0) {
    logger.debug("No unanalyzed messages to process");
    return null;
  }

  logger.info(
    { messageCount: messages.length },
    "Analyzing buffered messages",
  );

  const grouped = groupByChannel(messages);
  const prompt = buildAnalysisPrompt(grouped);

  try {
    const response = await getClient().messages.create({
      model: ANALYSIS_MODEL,
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const responseText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const result = parseAnalysisResponse(responseText);
    result.messageCount = messages.length;

    // Mark all messages as analyzed
    const ids = messages.map((m) => m.id);
    await markAnalyzed(ids);

    // Persist analysis results to Supabase (best-effort)
    await persistInsight(result);

    logger.info(
      {
        messageCount: messages.length,
        blockers: result.blockers.length,
        urgent: result.urgent.length,
        notable: result.notable.length,
      },
      "Message analysis complete",
    );

    // DM Daniel if there are high-priority findings
    const hasHighPriority = result.blockers.length > 0 || result.urgent.length > 0;
    if (hasHighPriority) {
      const summary = formatDmSummary(result);
      await postMessage({
        channel: env.SLACK_OWNER_USER_ID,
        text: summary,
      });

      logger.info("Sent monitoring summary DM to owner");
    }

    return result;
  } catch (err) {
    logger.error({ err }, "Failed to analyze buffered messages");

    // Still mark as analyzed to avoid reprocessing on repeated failures
    const ids = messages.map((m) => m.id);
    await markAnalyzed(ids);

    return null;
  }
}

let monitoringInterval: ReturnType<typeof setInterval> | null = null;

export function startMonitoringLoop(intervalMinutes = 15): void {
  if (monitoringInterval) {
    logger.warn("Monitoring loop already running");
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;

  logger.info(
    { intervalMinutes },
    "Starting channel monitoring loop",
  );

  monitoringInterval = setInterval(() => {
    analyzeBufferedMessages().catch((err) => {
      logger.error({ err }, "Monitoring loop analysis failed");
    });

    // Clean old messages once per cycle
    cleanOldMessages(7).catch((err) => {
      logger.error({ err }, "Failed to clean old monitored messages");
    });
  }, intervalMs);
}

export function stopMonitoringLoop(): void {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    logger.info("Stopped channel monitoring loop");
  }
}
