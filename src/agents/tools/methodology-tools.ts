import { getDaiSupabase } from "../../integrations/dai-supabase.js";
import { logger } from "../../utils/logger.js";

export async function searchMethodology(params: {
  query?: string;
  type?: string;
  accountCode?: string;
  category?: string;
  limit?: number;
}): Promise<string> {
  try {
    const resultLimit = params.limit ?? 20;
    logger.debug({ params }, "Searching methodology knowledge");
    const supabase = getDaiSupabase();

    const { data, error } = await supabase.rpc("search_methodology", {
      search_query: params.query ?? null,
      filter_type: params.type ?? null,
      filter_account: params.accountCode ?? null,
      filter_category: params.category ?? null,
      result_limit: resultLimit,
    });

    if (error) {
      logger.error({ error }, "Failed to search methodology");
      return JSON.stringify({ error: error.message });
    }

    logger.debug({ count: data?.length }, "Methodology search results");
    return JSON.stringify(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "searchMethodology failed");
    return JSON.stringify({ error: msg });
  }
}
