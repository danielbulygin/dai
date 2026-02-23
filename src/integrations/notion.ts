import { Client } from '@notionhq/client';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';

let _client: Client | null = null;

export function getNotion(): Client {
  if (_client) return _client;

  if (!env.NOTION_TOKEN) {
    throw new Error(
      'NOTION_TOKEN is not set. Configure it in .env to use Notion features.',
    );
  }

  logger.info('Initializing Notion client');
  _client = new Client({ auth: env.NOTION_TOKEN });
  return _client;
}
