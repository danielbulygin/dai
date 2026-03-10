import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runAgent } from '../../agents/runner.js';
import { logger } from '../../utils/logger.js';

export const chatRouter = new Hono();

chatRouter.post('/chat', async (c) => {
  const body = await c.req.json<{
    userId: string;
    clientCode: string;
    briefId?: string;
    message: string;
    briefContext?: Record<string, unknown>;
  }>();

  const { userId, clientCode, briefId, message, briefContext } = body;

  if (!userId || !clientCode || !message) {
    return c.json({ error: 'userId, clientCode, and message are required' }, 400);
  }

  // Build the user message, injecting brief context if provided
  let userMessage = message;
  if (briefContext) {
    userMessage = `[Brief Context — the user is currently editing this brief]\n${JSON.stringify(briefContext, null, 2)}\n\n[User Message]\n${message}`;
  }

  logger.info({ userId, clientCode, briefId }, 'API chat request');

  return streamSSE(c, async (stream) => {
    try {
      const result = await runAgent({
        agentId: 'maya',
        userMessage,
        userId,
        channelId: `web:${userId}`,
        threadTs: briefId,
        onText: (text) => {
          stream.writeSSE({ event: 'text', data: text }).catch(() => {
            // Client disconnected
          });
        },
        onTurnReset: () => {
          stream.writeSSE({ event: 'turn_reset', data: '' }).catch(() => {});
        },
        onToolUse: (toolName) => {
          stream.writeSSE({ event: 'tool_use', data: toolName }).catch(() => {});
        },
      });

      await stream.writeSSE({
        event: 'done',
        data: JSON.stringify({
          sessionId: result.sessionId,
          turns: result.turns,
        }),
      });
    } catch (err) {
      logger.error({ err }, 'API chat error');
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ error: 'Internal server error' }),
      });
    }
  });
});
