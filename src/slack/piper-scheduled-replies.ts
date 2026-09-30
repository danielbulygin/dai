import { findSession } from '../memory/sessions.js';

/** Stored in the existing DAI session summary; contains no competing task state. */
export const SCHEDULED_MOVES_MARKER = '[piper-scheduled-my-moves:v1]';

export async function scheduledReplyClarification(channel: string, threadTs: string, text: string): Promise<string | undefined> {
  if (!/^\s*(done|not mine|still blocked|blocked on client)[.!]?\s*$/i.test(text)) return;
  const session = await findSession(channel, threadTs, 'piper');
  if (!session?.summary?.startsWith(SCHEDULED_MOVES_MARKER)) return;
  return 'Which task does this update refer to? Reply with its number, task name, or link from this moves message so I can check the exact task.';
}
