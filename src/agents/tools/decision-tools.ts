import { logDecision } from "../../memory/decisions.js";
import { logger } from "../../utils/logger.js";

export async function logDecisionTool(params: {
  account_code: string;
  decision_type: string;
  target: string;
  rationale: string;
  metrics_snapshot?: Record<string, unknown>;
  agent_id: string;
  session_id?: string;
}): Promise<{ ok: boolean; decision_id: string }> {
  try {
    const decision = await logDecision({
      agent_id: params.agent_id,
      account_code: params.account_code,
      decision_type: params.decision_type,
      target: params.target,
      rationale: params.rationale,
      metrics_snapshot: params.metrics_snapshot,
      session_id: params.session_id,
    });

    logger.info(
      { decisionId: decision.id, type: params.decision_type, target: params.target },
      "Decision logged",
    );

    return { ok: true, decision_id: decision.id };
  } catch (err) {
    logger.error({ error: err }, "Failed to log decision");
    return { ok: false, decision_id: "" };
  }
}
