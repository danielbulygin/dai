import {
  createSession,
  findSession,
  endSession,
  getSession,
} from "../memory/sessions.js";
import type { Session } from "../memory/sessions.js";

/**
 * Retrieve an existing active session for the given channel + thread + agent
 * combination, or create a new one.
 *
 * Session key strategy:
 *   - channel_id + thread_ts + agent_id uniquely identify a conversation.
 *   - If an active session is found, it is returned as-is.
 *   - Otherwise a new session is created.
 */
export async function getOrCreateSession(params: {
  agentId: string;
  channelId: string;
  threadTs?: string;
  userId: string;
}): Promise<Session> {
  const { agentId, channelId, threadTs, userId } = params;

  const existing = await findSession(channelId, threadTs ?? null, agentId);
  if (existing) {
    return existing;
  }

  return await createSession({
    agent_id: agentId,
    channel_id: channelId,
    thread_ts: threadTs ?? null,
    user_id: userId,
  });
}

/**
 * End a session if it has been idle for longer than `idleMinutes`.
 *
 * Returns `true` if the session was ended, `false` if it is still within
 * the idle window or was already ended.
 *
 * @param sessionId - The session ID to check.
 * @param idleMinutes - Maximum idle time before auto-ending (default 30).
 */
export async function endSessionIfIdle(
  sessionId: string,
  idleMinutes = 30,
): Promise<boolean> {
  const session = await getSession(sessionId);

  if (!session) {
    return false;
  }

  if (session.status !== "active") {
    return false;
  }

  const updatedAt = new Date(session.updated_at + "Z");
  const now = new Date();
  const diffMs = now.getTime() - updatedAt.getTime();
  const diffMinutes = diffMs / (1000 * 60);

  if (diffMinutes < idleMinutes) {
    return false;
  }

  await endSession(sessionId, `Auto-ended after ${idleMinutes} minutes of inactivity`);
  return true;
}
