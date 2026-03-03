import { getDaiSupabase } from '../integrations/dai-supabase.js';
import { logger } from '../utils/logger.js';

export interface ClientAgentConfig {
  id: string;
  clientCode: string;
  channelId: string;
  displayName: string;
}

// ---------------------------------------------------------------------------
// Cache — simple Map with 5-minute TTL
// ---------------------------------------------------------------------------

interface CacheEntry {
  config: ClientAgentConfig | null;
  expiry: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

/**
 * Look up a client agent config by Slack channel ID.
 * Returns null if no client agent is mapped to this channel.
 * Results are cached for 5 minutes.
 */
export async function getClientAgentByChannel(
  channelId: string,
): Promise<ClientAgentConfig | null> {
  const now = Date.now();
  const cached = cache.get(channelId);
  if (cached && cached.expiry > now) {
    return cached.config;
  }

  try {
    const supabase = getDaiSupabase();
    const { data, error } = await supabase
      .from('client_agents')
      .select('id, client_code, channel_id, display_name')
      .eq('channel_id', channelId)
      .eq('is_active', true)
      .maybeSingle();

    if (error) {
      logger.error({ error, channelId }, 'Failed to look up client agent');
      return null;
    }

    const config: ClientAgentConfig | null = data
      ? {
          id: data.id as string,
          clientCode: data.client_code as string,
          channelId: data.channel_id as string,
          displayName: data.display_name as string,
        }
      : null;

    cache.set(channelId, { config, expiry: now + CACHE_TTL_MS });

    if (config) {
      logger.debug(
        { channelId, clientCode: config.clientCode },
        'Resolved client agent for channel',
      );
    }

    return config;
  } catch (err) {
    logger.error({ err, channelId }, 'getClientAgentByChannel failed');
    return null;
  }
}
