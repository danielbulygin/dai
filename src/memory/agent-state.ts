import { getDaiSupabase } from '../integrations/dai-supabase.js';
import { logger } from '../utils/logger.js';

/**
 * Generic key-value state for agents and scheduled jobs (agent_state table).
 * Lets a scheduled job remember what it said last time so it can post deltas
 * instead of repeating itself.
 */

export async function getAgentState<T>(key: string): Promise<T | null> {
  try {
    const { data, error } = await getDaiSupabase()
      .from('agent_state')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) throw error;
    return (data?.value as T) ?? null;
  } catch (err) {
    logger.warn({ err, key }, 'getAgentState failed');
    return null;
  }
}

export async function setAgentState(key: string, value: unknown): Promise<void> {
  try {
    const { error } = await getDaiSupabase()
      .from('agent_state')
      .upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) throw error;
  } catch (err) {
    logger.warn({ err, key }, 'setAgentState failed');
  }
}
