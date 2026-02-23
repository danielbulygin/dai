import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";
import { logger } from "../utils/logger.js";

let _client: SupabaseClient | null = null;

export function getDaiSupabase(): SupabaseClient {
  if (_client) return _client;

  const url = env.DAI_SUPABASE_URL;
  const key = env.DAI_SUPABASE_SERVICE_KEY;

  if (!url || !key) {
    throw new Error(
      "DAI Supabase is not configured. Set DAI_SUPABASE_URL and DAI_SUPABASE_SERVICE_KEY environment variables.",
    );
  }

  logger.info("Initializing DAI Supabase client");
  _client = createClient(url, key);
  return _client;
}
