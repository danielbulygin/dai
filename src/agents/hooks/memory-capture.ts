import { logger } from "../../utils/logger.js";
import { addObservation } from "../../memory/observations.js";

export interface ToolObservation {
  sessionId: string;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  importance: number;
}

/**
 * Set of tools whose output is too noisy to capture by default.
 * Read is skipped unless it errors; Glob and Grep produce high-volume results.
 */
const NOISY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
]);

/**
 * Default importance scores by tool name.
 * Higher values = more important to remember.
 */
const IMPORTANCE_MAP: Readonly<Record<string, number>> = {
  Write: 8,
  Edit: 8,
  Bash: 7,
  WebSearch: 6,
  WebFetch: 6,
};

const DEFAULT_IMPORTANCE = 5;
const MAX_SUMMARY_LENGTH = 500;

/**
 * Determine whether a tool invocation is worth remembering.
 *
 * Skips Read (unless error), Glob, and Grep because they produce
 * high-volume, low-signal output. Everything else is captured.
 */
export function shouldCapture(toolName: string): boolean {
  return !NOISY_TOOLS.has(toolName);
}

/**
 * Truncate a string to `maxLen` characters, appending an ellipsis if trimmed.
 */
function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Persist a tool observation to the memory database.
 *
 * - Truncates input/output summaries to 500 characters.
 * - Assigns importance based on tool type (Write/Edit=8, Bash=7, etc.).
 * - Delegates actual storage to `addObservation`.
 */
export function captureObservation(obs: ToolObservation): void {
  try {
    const importance = IMPORTANCE_MAP[obs.toolName] ?? DEFAULT_IMPORTANCE;
    const inputSummary = truncate(obs.inputSummary, MAX_SUMMARY_LENGTH);
    const outputSummary = truncate(obs.outputSummary, MAX_SUMMARY_LENGTH);

    addObservation({
      session_id: obs.sessionId,
      tool_name: obs.toolName,
      input_summary: inputSummary,
      output_summary: outputSummary,
      importance,
    });

    logger.debug(
      { sessionId: obs.sessionId, tool: obs.toolName, importance },
      "Captured tool observation",
    );
  } catch (err) {
    logger.error(
      { err, sessionId: obs.sessionId, tool: obs.toolName },
      "Failed to capture tool observation",
    );
  }
}
