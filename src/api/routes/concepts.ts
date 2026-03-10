import { Hono } from 'hono';
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
    `\nFor each concept, provide a JSON array with objects containing:`,
    `- title: short concept name`,
    `- format_code: one of F01-F17`,
    `- angle_code: one of A01-A15`,
    `- hooks: array of 3 hook lines`,
    `- target_emotion: the core emotion to evoke`,
    `- rationale: 1-2 sentences on why this concept works`,
    `\nRespond ONLY with a JSON object: { "concepts": [...] }`,
    `No markdown wrapping, no explanation — just the JSON.`,
  ]
    .filter(Boolean)
    .join('\n');

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
      },
    });

    // Parse the JSON from Maya's response
    const responseText = result.response || fullResponse;

    // Try to extract JSON from the response
    let concepts;
    try {
      // Try direct parse first
      concepts = JSON.parse(responseText);
    } catch {
      // Try to find JSON in the response
      const jsonMatch = responseText.match(/\{[\s\S]*"concepts"[\s\S]*\}/);
      if (jsonMatch) {
        concepts = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Could not parse concepts from response');
      }
    }

    return c.json(concepts);
  } catch (err) {
    logger.error({ err }, 'Concept generation error');
    return c.json({ error: 'Failed to generate concepts' }, 500);
  }
});
