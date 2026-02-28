import { getDaiSupabase } from "../../integrations/dai-supabase.js";
import { logger } from "../../utils/logger.js";

export async function updateMethodologyKnowledge(params: {
  id: string;
  account_code?: string;
  title?: string;
  category?: string;
  type?: string;
}): Promise<{ updated: boolean; id: string }> {
  try {
    const supabase = getDaiSupabase();

    const updates: Record<string, unknown> = {};
    if (params.account_code !== undefined) updates.account_code = params.account_code;
    if (params.title !== undefined) updates.title = params.title;
    if (params.category !== undefined) updates.category = params.category;
    if (params.type !== undefined) updates.type = params.type;

    if (Object.keys(updates).length === 0) {
      return { updated: false, id: params.id };
    }

    const { error } = await supabase
      .from("methodology_knowledge")
      .update(updates)
      .eq("id", params.id);

    if (error) {
      logger.error({ error, id: params.id }, "Failed to update methodology knowledge");
      return { updated: false, id: params.id };
    }

    logger.info({ id: params.id, updates: Object.keys(updates) }, "Updated methodology knowledge");
    return { updated: true, id: params.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg, id: params.id }, "updateMethodologyKnowledge failed");
    return { updated: false, id: params.id };
  }
}

export async function deleteMethodologyKnowledge(params: {
  id: string;
}): Promise<{ deleted: boolean; id: string }> {
  try {
    const supabase = getDaiSupabase();

    const { error } = await supabase
      .from("methodology_knowledge")
      .delete()
      .eq("id", params.id);

    if (error) {
      logger.error({ error, id: params.id }, "Failed to delete methodology knowledge");
      return { deleted: false, id: params.id };
    }

    logger.info({ id: params.id }, "Deleted methodology knowledge");
    return { deleted: true, id: params.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg, id: params.id }, "deleteMethodologyKnowledge failed");
    return { deleted: false, id: params.id };
  }
}

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
