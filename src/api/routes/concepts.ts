import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runAgent } from '../../agents/runner.js';
import { logger } from '../../utils/logger.js';

export const conceptsRouter = new Hono();

conceptsRouter.post('/generate-concepts', async (c) => {
  const body = await c.req.json<{
    clientCode: string;
    dials: Record<string, number>;
    direction?: string;
    count?: number;
    briefType?: string;
  }>();

  const { clientCode, dials, direction, count = 5, briefType } = body;

  if (!clientCode || !dials) {
    return c.json({ error: 'clientCode and dials are required' }, 400);
  }

  logger.info({ clientCode, count, briefType }, 'API concept generation request');

  const dialDescriptions = Object.entries(dials)
    .map(([key, value]) => `${key}: ${value}/10`)
    .join(', ');

  const prompt = [
    `Generate ${count} creative ad concepts for client ${clientCode}.`,
    `\nDial settings: ${dialDescriptions}`,
    briefType ? `Brief type: ${briefType}` : '',
    direction ? `Creative direction: ${direction}` : '',
    `\nBefore generating, use your tools to understand the client's creative landscape:`,
    `1. Search methodology for relevant creative patterns`,
    `2. Check the creative audit and diversity score`,
    `\nThen generate concepts. For each concept, provide:`,
    `- title: short concept name`,
    `- format_code: one of F01-F17`,
    `- angle_code: one of A01-A15`,
    `- hooks: array of 3 hook lines`,
    `- target_emotion: the core emotion to evoke`,
    `- rationale: 1-2 sentences on why this concept works`,
    `\nAt the end, output the concepts as a JSON code block:`,
    '```json',
    '{ "concepts": [...] }',
    '```',
  ]
    .filter(Boolean)
    .join('\n');

  // Stream SSE so the frontend can show progress
  return streamSSE(c, async (stream) => {
    try {
      let fullResponse = '';

      const result = await runAgent({
        agentId: 'maya',
        userMessage: prompt,
        userId: 'studio-api',
        channelId: `web:studio-concepts`,
        threadTs: `concepts-${Date.now()}`,
        onText: (text) => {
          fullResponse += text;
          stream.writeSSE({ event: 'text', data: text }).catch(() => {});
        },
        onTurnReset: () => {
          fullResponse = '';
          stream.writeSSE({ event: 'turn_reset', data: '' }).catch(() => {});
        },
        onToolUse: (toolName) => {
          stream.writeSSE({ event: 'tool_use', data: toolName }).catch(() => {});
        },
      });

      // Parse the JSON from Maya's response
      const responseText = result.response || fullResponse;
      let concepts;
      try {
        // Try to find JSON code block
        const codeBlockMatch = responseText.match(/```json\s*([\s\S]*?)```/);
        if (codeBlockMatch) {
          concepts = JSON.parse(codeBlockMatch[1]);
        } else {
          // Try to find raw JSON object
          const jsonMatch = responseText.match(/\{[\s\S]*"concepts"[\s\S]*\}/);
          if (jsonMatch) {
            concepts = JSON.parse(jsonMatch[0]);
          } else {
            // Try direct parse
            concepts = JSON.parse(responseText);
          }
        }
      } catch {
        concepts = { concepts: [], error: 'Could not parse concepts from response' };
      }

      await stream.writeSSE({
        event: 'concepts',
        data: JSON.stringify(concepts),
      });

      await stream.writeSSE({ event: 'done', data: '' });
    } catch (err) {
      logger.error({ err }, 'Concept generation error');
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ error: 'Failed to generate concepts' }),
      });
    }
  });
});
