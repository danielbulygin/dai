import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";
import { getDaiSupabase } from "../integrations/dai-supabase.js";
import { getMessages } from "../memory/messages.js";
import {
  addLearning,
  findDuplicateLearning,
  getLearnings,
  updateLearningConfidence,
  deleteLearning,
  type Learning,
} from "../memory/learnings.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";
const SYNTHESIS_MODEL = "claude-sonnet-4-20250514";

// ---------------------------------------------------------------------------
// Anthropic client (lazy singleton)
// ---------------------------------------------------------------------------

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExtractedPreference {
  category:
    | "communication"
    | "scheduling"
    | "delegation"
    | "briefing"
    | "workflow"
    | "personal";
  content: string;
  confidence: number;
  source: "conversation" | "briefing_reaction" | "correction" | "repetition";
  evidence: string;
}

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM = `You analyze conversations between Daniel and his AI assistant Jasmin to extract Daniel's preferences and patterns.

Extract ONLY clear, actionable preferences — not generic observations. Each preference should be something Jasmin can apply in future interactions.

Categories:
- communication: How Daniel likes to be communicated with (tone, length, format)
- scheduling: Calendar and meeting preferences
- delegation: Who Daniel assigns what to, how he frames tasks
- briefing: What Daniel wants in briefings, what he reacts to
- workflow: How Daniel works (tools, processes, habits)
- personal: Personal preferences (food, interests, routines)

Confidence rules:
- Explicit statement ("I always want...", "never..."): 0.6
- Correction ("No, do it this way"): 0.5
- Implicit pattern (observed behavior): 0.3

Return a JSON array of preferences. If the conversation reveals NO clear preferences, return an empty array [].

Response format (ONLY valid JSON, no markdown):
[
  {
    "category": "communication",
    "content": "Prefers bullet points over paragraphs for status updates",
    "confidence": 0.3,
    "source": "conversation",
    "evidence": "Daniel said: 'just give me the bullets'"
  }
]`;

const BRIEFING_REACTION_SYSTEM = `You analyze Daniel's reactions to briefing messages from Jasmin to understand what he finds useful.

Given a briefing message and Daniel's reaction, extract what specifically Daniel liked or disliked.

Positive reactions (👍, ✅, ❤️, 🔥) mean Daniel found the item useful.
Negative reactions (👎, ❌, 🚫) mean Daniel didn't want this type of content.

Return a JSON array of preferences. If the reaction doesn't reveal a clear preference, return [].

Response format (ONLY valid JSON, no markdown):
[
  {
    "category": "briefing",
    "content": "Finds calendar conflict alerts useful in morning briefings",
    "confidence": 0.3,
    "source": "briefing_reaction",
    "evidence": "Reacted 👍 to: 'Heads up — you have back-to-back calls 2-4pm'"
  }
]`;

// ---------------------------------------------------------------------------
// 1. Extract preferences from sessions
// ---------------------------------------------------------------------------

export async function extractPreferencesFromSessions(): Promise<void> {
  const log = logger.child({ job: "jasmin-preference-extraction" });

  try {
    const supabase = getDaiSupabase();

    // Get Jasmin sessions from the last 24 hours
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: sessions, error: sessErr } = await supabase
      .from("sessions")
      .select("id, created_at")
      .eq("agent_id", "jasmin")
      .gt("created_at", since);

    if (sessErr) {
      log.error({ error: sessErr.message }, "Failed to query sessions");
      return;
    }

    if (!sessions || sessions.length === 0) {
      log.info("No Jasmin sessions in the last 24 hours");
      return;
    }

    log.info({ sessionCount: sessions.length }, "Processing Jasmin sessions for preferences");

    let totalExtracted = 0;

    for (const session of sessions) {
      try {
        const messages = await getMessages(session.id, 50);
        if (messages.length < 2) continue; // Skip trivial sessions

        const conversationText = messages
          .map((m) => `${m.role === "user" ? "Daniel" : "Jasmin"}: ${m.content}`)
          .join("\n\n");

        const response = await getClient().messages.create({
          model: EXTRACTION_MODEL,
          max_tokens: 2048,
          system: EXTRACTION_SYSTEM,
          messages: [
            {
              role: "user",
              content: `Analyze this conversation:\n\n${conversationText}`,
            },
          ],
        });

        const responseText = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");

        const cleaned = responseText
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();

        const preferences = JSON.parse(cleaned) as ExtractedPreference[];

        for (const pref of preferences) {
          await savePreference(pref, session.id, log);
          totalExtracted++;
        }
      } catch (err) {
        log.error(
          { err, sessionId: session.id },
          "Failed to extract preferences from session",
        );
        // Continue processing other sessions
      }
    }

    log.info({ totalExtracted }, "Preference extraction from sessions complete");
  } catch (err) {
    log.error({ err }, "Preference extraction job failed");
  }
}

// ---------------------------------------------------------------------------
// 2. Extract preferences from briefing reactions
// ---------------------------------------------------------------------------

export async function extractPreferencesFromBriefingReactions(): Promise<void> {
  const log = logger.child({ job: "jasmin-briefing-reactions" });

  try {
    const supabase = getDaiSupabase();

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: feedbackRows, error: fbErr } = await supabase
      .from("feedback")
      .select("*")
      .eq("agent_id", "jasmin")
      .gt("created_at", since);

    if (fbErr) {
      log.error({ error: fbErr.message }, "Failed to query feedback");
      return;
    }

    if (!feedbackRows || feedbackRows.length === 0) {
      log.info("No Jasmin feedback in the last 24 hours");
      return;
    }

    // Map reactions to sentiment
    const positiveReactions = new Set(["+1", "white_check_mark", "heart", "fire", "thumbsup"]);
    const negativeReactions = new Set(["-1", "x", "no_entry", "thumbsdown"]);

    let totalExtracted = 0;

    for (const fb of feedbackRows) {
      try {
        const reactionType = fb.type as string;
        const isPositive = positiveReactions.has(reactionType);
        const isNegative = negativeReactions.has(reactionType);

        if (!isPositive && !isNegative) continue;

        const sentiment = isPositive ? "positive" : "negative";
        const reactionEmoji = isPositive ? "👍" : "👎";
        const messageContent = fb.content || "briefing message";

        const response = await getClient().messages.create({
          model: EXTRACTION_MODEL,
          max_tokens: 1024,
          system: BRIEFING_REACTION_SYSTEM,
          messages: [
            {
              role: "user",
              content: `Briefing message: ${messageContent}\n\nDaniel's reaction: ${reactionEmoji} (${sentiment})`,
            },
          ],
        });

        const responseText = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");

        const cleaned = responseText
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/i, "")
          .trim();

        const preferences = JSON.parse(cleaned) as ExtractedPreference[];

        for (const pref of preferences) {
          await savePreference(pref, fb.session_id, log);
          totalExtracted++;
        }
      } catch (err) {
        log.error(
          { err, feedbackId: fb.id },
          "Failed to extract preferences from feedback",
        );
      }
    }

    log.info({ totalExtracted }, "Briefing reaction extraction complete");
  } catch (err) {
    log.error({ err }, "Briefing reaction extraction job failed");
  }
}

// ---------------------------------------------------------------------------
// 3. Weekly preference synthesis
// ---------------------------------------------------------------------------

const SYNTHESIS_SYSTEM = `You consolidate and deduplicate Daniel's preferences that Jasmin has learned over time.

Your tasks:
1. Merge duplicates: Combine preferences that express the same idea differently. Keep the clearest wording.
2. Resolve conflicts: If two preferences contradict, keep the more recent or higher-confidence one.
3. Identify confirmed patterns: Preferences observed 3+ times (confidence >= 0.7) are confirmed.
4. Flag stale preferences: Low confidence (< 0.5) and not updated in 30+ days should be removed.
5. Generate a concise "Understanding of Daniel" summary — a natural-language paragraph describing what Jasmin knows about how Daniel works and what he prefers.

Return JSON:
{
  "merge": [
    { "keep_id": "id_to_keep", "delete_ids": ["id1", "id2"], "merged_content": "combined preference text", "new_confidence": 0.7 }
  ],
  "remove": ["stale_id_1", "stale_id_2"],
  "summary": "Daniel prefers concise communication..."
}`;

export async function synthesizeJasminPreferences(): Promise<void> {
  const log = logger.child({ job: "jasmin-preference-synthesis" });

  try {
    // Fetch all Jasmin preference learnings
    const allPrefs = await getLearnings("jasmin", undefined, 200);
    const preferences = allPrefs.filter((l) => l.category.startsWith("preference_"));

    if (preferences.length < 3) {
      log.info(
        { count: preferences.length },
        "Too few preferences for synthesis, skipping",
      );
      return;
    }

    log.info({ count: preferences.length }, "Starting preference synthesis");

    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const prefsText = preferences
      .map(
        (p) =>
          `[id=${p.id}] category=${p.category} confidence=${p.confidence} updated=${p.updated_at} content: ${p.content}`,
      )
      .join("\n");

    const response = await getClient().messages.create({
      model: SYNTHESIS_MODEL,
      max_tokens: 4096,
      system: SYNTHESIS_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Current date: ${new Date().toISOString().slice(0, 10)}\nStale threshold: ${thirtyDaysAgo}\n\nPreferences:\n${prefsText}`,
        },
      ],
    });

    const responseText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    const cleaned = responseText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const result = JSON.parse(cleaned) as {
      merge: Array<{
        keep_id: string;
        delete_ids: string[];
        merged_content: string;
        new_confidence: number;
      }>;
      remove: string[];
      summary: string;
    };

    // Apply merges
    for (const merge of result.merge) {
      try {
        // Update the kept learning with merged content
        const supabase = getDaiSupabase();
        await supabase
          .from("learnings")
          .update({
            content: merge.merged_content,
            confidence: Math.min(merge.new_confidence, 0.95),
          })
          .eq("id", merge.keep_id);

        // Delete merged duplicates
        for (const deleteId of merge.delete_ids) {
          await deleteLearning(deleteId);
        }

        log.debug(
          { keepId: merge.keep_id, deletedCount: merge.delete_ids.length },
          "Merged preferences",
        );
      } catch (err) {
        log.error({ err, merge }, "Failed to apply merge");
      }
    }

    // Remove stale preferences
    for (const removeId of result.remove) {
      try {
        await deleteLearning(removeId);
        log.debug({ id: removeId }, "Removed stale preference");
      } catch (err) {
        log.error({ err, id: removeId }, "Failed to remove stale preference");
      }
    }

    // Save or update the summary
    if (result.summary) {
      const existingSummary = await findDuplicateLearning(
        "jasmin",
        "preference_summary",
        "understanding of Daniel summary",
        null,
      );

      if (existingSummary) {
        const supabase = getDaiSupabase();
        await supabase
          .from("learnings")
          .update({ content: result.summary, confidence: 0.95 })
          .eq("id", existingSummary.id);
        log.info("Updated preference summary");
      } else {
        await addLearning({
          agent_id: "jasmin",
          category: "preference_summary",
          content: result.summary,
          confidence: 0.95,
        });
        log.info("Created preference summary");
      }
    }

    log.info(
      {
        merged: result.merge.length,
        removed: result.remove.length,
        hasSummary: !!result.summary,
      },
      "Preference synthesis complete",
    );
  } catch (err) {
    log.error({ err }, "Preference synthesis job failed");
  }
}

// ---------------------------------------------------------------------------
// 4. Confidence decay (called before weekly synthesis)
// ---------------------------------------------------------------------------

export async function applyConfidenceDecay(): Promise<void> {
  const log = logger.child({ job: "jasmin-confidence-decay" });

  try {
    const supabase = getDaiSupabase();
    const { data, error } = await supabase.rpc("decay_jasmin_confidence");

    if (error) {
      log.error({ error: error.message }, "Confidence decay RPC failed");
      return;
    }

    log.info({ decayed: data }, "Applied confidence decay to stale preferences");
  } catch (err) {
    log.error({ err }, "Confidence decay failed");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONFIDENCE_INCREMENT = 0.15;
const MAX_CONFIDENCE = 0.95;

/**
 * Semantic dedup: when FTS finds nothing, ask Haiku if any existing
 * same-category preference is semantically equivalent.
 */
async function findSemanticDuplicate(
  category: string,
  content: string,
): Promise<Learning | undefined> {
  try {
    const existing = await getLearnings("jasmin", category, 5);
    if (existing.length === 0) return undefined;

    const existingList = existing
      .map((l, i) => `${i + 1}. [id=${l.id}] ${l.content}`)
      .join("\n");

    const response = await getClient().messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 100,
      system:
        "You compare preferences for semantic equivalence. Given a new preference and existing ones, return the ID of the duplicate if one exists, or 'none'. Return ONLY the id string or 'none', nothing else.",
      messages: [
        {
          role: "user",
          content: `New: ${content}\n\nExisting:\n${existingList}`,
        },
      ],
    });

    const answer = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (answer === "none") return undefined;
    return existing.find((l) => l.id === answer);
  } catch {
    return undefined;
  }
}

async function savePreference(
  pref: ExtractedPreference,
  sessionId: string | null,
  log: ReturnType<typeof logger.child>,
): Promise<void> {
  const category = `preference_${pref.category}`;

  // Check for existing similar preference
  const existing = await findDuplicateLearning("jasmin", category, pref.content, null);

  // Fallback: semantic dedup if FTS finds nothing
  const match = existing ?? (await findSemanticDuplicate(category, pref.content));

  if (match) {
    // Boost confidence for repeated observation
    const newConfidence = Math.min(
      match.confidence + CONFIDENCE_INCREMENT,
      MAX_CONFIDENCE,
    );
    await updateLearningConfidence(match.id, newConfidence);
    log.debug(
      { id: match.id, oldConfidence: match.confidence, newConfidence },
      "Boosted existing preference confidence",
    );
  } else {
    await addLearning({
      agent_id: "jasmin",
      category,
      content: pref.content,
      confidence: pref.confidence,
      source_session_id: sessionId,
    });
    log.debug({ category, content: pref.content }, "Saved new preference");
  }
}
