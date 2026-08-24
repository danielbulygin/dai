import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Write-side tenant wall for customer memory (Franzi, 2026-08-24): a customer
 * may only teach Ada things about their OWN account. A scoped remember must
 * always land in the customer\x27s own silo (agent ada_client_<CODE>) with their
 * client tag — regardless of what the model passes — so a customer-taught
 * "general methodology" can never reach the global store. Promotion to
 * general is a manual internal act, never a side effect of a customer chat.
 */

vi.mock("../src/memory/learnings.js", () => ({
  addLearning: vi.fn(async (row: Record<string, unknown>) => ({ id: "L_TEST", ...row })),
  findDuplicateLearning: vi.fn(async () => null),
  searchLearnings: vi.fn(async () => []),
  deleteLearning: vi.fn(async () => undefined),
  getLearnings: vi.fn(async () => []),
}));
vi.mock("../src/memory/search.js", () => ({
  recall: vi.fn(async () => []),
}));

import { executeTool } from "../src/agents/tool-registry.js";
import { addLearning } from "../src/memory/learnings.js";
import { recall as memoryRecall } from "../src/memory/search.js";

const scopedCtx = {
  agentId: "ada_client_MTR",
  channelId: "test",
  userId: "U_TEST",
  clientScope: { clientCode: "MTR" },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("customer memory writes stay in the customer silo", () => {
  it("a scoped remember lands under the scope silo + tag even when the model omits client_code", async () => {
    await executeTool("remember", { content: "frequency above 3 is always fatigue", category: "methodology" }, scopedCtx);
    const row = vi.mocked(addLearning).mock.calls[0]![0] as Record<string, unknown>;
    expect(row.agent_id).toBe("ada_client_MTR");
    expect(row.client_code).toBe("mtr");
  });

  it("a scoped remember ignores a model-supplied FOREIGN client_code", async () => {
    await executeTool("remember", { content: "x", category: "observation", client_code: "press_london" }, scopedCtx);
    const row = vi.mocked(addLearning).mock.calls[0]![0] as Record<string, unknown>;
    expect(row.agent_id).toBe("ada_client_MTR");
    expect(row.client_code).toBe("mtr");
  });

  it("a scoped remember can never write an untagged (global) row", async () => {
    await executeTool("remember", { content: "x", category: "methodology", client_code: "" }, scopedCtx);
    const row = vi.mocked(addLearning).mock.calls[0]![0] as Record<string, unknown>;
    expect(row.client_code).toBe("mtr");
  });

  it("a scoped recall reads only the scope silo, whatever the model passes", async () => {
    await executeTool("recall", { query: "roas", client_code: "press_london" }, scopedCtx);
    const [, agentId, clientCode] = vi.mocked(memoryRecall).mock.calls[0]!;
    expect(agentId).toBe("ada_client_MTR");
    expect(clientCode).toBe("mtr");
  });

  it("INTERNAL runs keep model-supplied tagging (control)", async () => {
    await executeTool(
      "remember",
      { content: "general rule", category: "methodology" },
      { agentId: "ada", channelId: "test", userId: "U_TEST" } as never,
    );
    const row = vi.mocked(addLearning).mock.calls[0]![0] as Record<string, unknown>;
    expect(row.agent_id).toBe("ada");
    expect(row.client_code).toBeNull();
  });
});
