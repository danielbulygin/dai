import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";
import { logger } from "../utils/logger.js";

let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error(
      "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables.",
    );
  }

  logger.info("Initializing Supabase client");
  _client = createClient(url, key);
  return _client;
}
