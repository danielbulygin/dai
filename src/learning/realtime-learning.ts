import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";
import {
  addLearning,
  findDuplicateLearning,
  updateLearningConfidence,
} from "../memory/learnings.js";
import { logger } from "../utils/logger.js";

const EXTRACTION_MODEL = "claude-haiku-4-5-20251001";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Stage 1: Regex signal detection — cheap, runs on every message
// ---------------------------------------------------------------------------

const PREFERENCE_SIGNALS = [
  /\balways\b/i,
  /\bnever\b/i,
  /\bI prefer\b/i,
  /\bI like\b/i,
  /\bI don'?t like\b/i,
  /\bI hate\b/i,
  /\bfrom now on\b/i,
  /\bstop doing\b/i,
  /\bdon'?t do\b/i,
  /\bno,\s/i,
  /\bactually,?\s/i,
  /\bremember that\b/i,
  /\bkeep in mind\b/i,
  /\bplease don'?t\b/i,
  /\binstead of\b/i,
  /\bI want\b/i,
  /\bnext time\b/i,
];

function hasPreferenceSignal(text: string): boolean {
  return PREFERENCE_SIGNALS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Stage 2: Haiku extraction — only called when signal detected
// ---------------------------------------------------------------------------

const REALTIME_SYSTEM = `You extract Daniel's preferences from a single exchange with his AI assistant Jasmin.

Extract ONLY clear, actionable preferences. If the message is just a normal request with no preference signal, return [].

Categories: communication, scheduling, delegation, briefing, workflow, personal

Return a JSON array (no markdown):
[
  {
    "category": "communication",
    "content": "Prefers bullet points over paragraphs",
    "confidence": 0.5,
    "evidence": "Daniel said: 'just give me the bullets'"
  }
]

Confidence rules:
- Explicit statement ("I always want...", "never..."): 0.6
- Correction ("No, do it this way"): 0.5
- Mild preference ("I prefer...", "I like..."): 0.4`;

interface RealtimePreference {
  category: string;
  content: string;
  confidence: number;
  evidence: string;
}

const CONFIDENCE_INCREMENT = 0.15;
const MAX_CONFIDENCE = 0.95;

async function extractAndSave(
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  const log = logger.child({ module: "realtime-learning" });

  try {
    const response = await getClient().messages.create({
      model: EXTRACTION_MODEL,
      max_tokens: 1024,
      system: REALTIME_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Daniel: ${userMessage.slice(0, 500)}\n\nJasmin: ${assistantResponse.slice(0, 500)}`,
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

    const preferences = JSON.parse(cleaned) as RealtimePreference[];
    if (!Array.isArray(preferences) || preferences.length === 0) return;

    for (const pref of preferences) {
      const category = `preference_${pref.category}`;
      const existing = await findDuplicateLearning(
        "jasmin",
        category,
        pref.content,
        null,
      );

      if (existing) {
        const newConfidence = Math.min(
          existing.confidence + CONFIDENCE_INCREMENT,
          MAX_CONFIDENCE,
        );
        await updateLearningConfidence(existing.id, newConfidence);
        log.info(
          { id: existing.id, oldConf: existing.confidence, newConf: newConfidence },
          "Realtime: boosted existing preference",
        );
      } else {
        await addLearning({
          agent_id: "jasmin",
          category,
          content: pref.content,
          confidence: pref.confidence,
        });
        log.info(
          { category, content: pref.content },
          "Realtime: saved new preference",
        );
      }
    }
  } catch (err) {
    log.warn({ err }, "Realtime preference extraction failed");
  }
}

// ---------------------------------------------------------------------------
// Public API — called fire-and-forget from runner.ts
// ---------------------------------------------------------------------------

export async function detectAndLearn(
  userMessage: string,
  assistantResponse: string,
): Promise<void> {
  if (!hasPreferenceSignal(userMessage)) return;
  await extractAndSave(userMessage, assistantResponse);
}
