import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { apiKeyAuth } from './auth.js';
import { healthRouter } from './routes/health.js';
import { chatRouter } from './routes/chat.js';
import { conceptsRouter } from './routes/concepts.js';
import { notionWebhookRouter } from '../webhooks/notion.js';

export function startApiServer(): void {
  const port = env.API_PORT;
  const app = new Hono().basePath('/api');

  // CORS
  app.use(
    '*',
    cors({
      origin: [
        'https://bmad-lac.vercel.app',
        'http://localhost:3000',
        'http://localhost:3001',
      ],
      allowHeaders: ['Content-Type', 'X-API-Key'],
      allowMethods: ['GET', 'POST', 'OPTIONS'],
    }),
  );

  // Health check (no auth)
  app.route('/', healthRouter);

  // Notion webhook (no API key — verified via HMAC signature)
  app.route('/', notionWebhookRouter);

  // Authenticated routes
  app.use('/*', apiKeyAuth);
  app.route('/', chatRouter);
  app.route('/', conceptsRouter);

  try {
    serve({ fetch: app.fetch, port }, () => {
      logger.info({ port }, 'API server started');
    });
  } catch (err) {
    logger.warn({ err, port }, 'Failed to start API server — continuing without it');
  }
}
