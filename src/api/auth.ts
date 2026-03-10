import type { Context, Next } from 'hono';
import { env } from '../env.js';

export async function apiKeyAuth(c: Context, next: Next): Promise<Response | void> {
  const apiKey = env.STUDIO_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'API not configured' }, 503);
  }

  const provided = c.req.header('X-API-Key');
  if (!provided || provided !== apiKey) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
}
