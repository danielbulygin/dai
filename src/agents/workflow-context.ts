import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

/**
 * Conditional workflow injection (master-plan A10).
 *
 * Ada's full upload/launch workflow (~345 lines) lives in
 * agents/ada/workflows/launch-workflow.md — a subdirectory, so loadExtras()
 * does NOT auto-inject it. It loads only when the conversation looks
 * launch-shaped, freeing prompt budget and attention for pure analysis turns.
 * INSTRUCTIONS.md keeps a hard-invariants stub that applies even when this
 * misses (never fabricate launches, never delete, always QC + verify).
 */

// Generous on purpose: a false positive costs ~9K cached tokens; a false
// negative costs the workflow. The deterministic launch-approval handler and
// the core-instructions stub backstop misses.
const LAUNCH_PATTERN =
  /\b(upload|launch|ad ?sets?|drive\.google|media.?library|ready.?to.?upload|batch|preview|paused|final ads|raw footage|rename|qc|creative[s]?|folder|campaign config|geo.?tier|lander|landing page swap|[A-Z]{2,5}x\d{3,5})\b/i;

const cache = new Map<string, string>();

export function detectLaunchShaped(texts: string[]): boolean {
  return texts.some((t) => t && LAUNCH_PATTERN.test(t));
}

/** Load agents/<agentPath>/workflows/launch-workflow.md if present. */
export function loadLaunchWorkflowExtra(
  agentPath: string,
): { name: string; content: string } | null {
  const path = join(process.cwd(), 'agents', agentPath, 'workflows', 'launch-workflow.md');
  try {
    let content = cache.get(path);
    if (content === undefined) {
      if (!existsSync(path)) return null;
      content = readFileSync(path, 'utf-8').trim();
      cache.set(path, content);
    }
    return content ? { name: 'workflow:launch', content } : null;
  } catch (err) {
    logger.warn({ err, path }, 'Failed to load launch workflow');
    return null;
  }
}
