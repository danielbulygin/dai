import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/agents/sdk/runAgentSDK.js";

/**
 * Cross-tenant prompt wall (2026-08-24). The runner path has always skipped
 * client-context injection for client-scoped runs ("Client-scoped runs
 * already get theirs via the overlay"); the SDK path lost that guard, so a
 * Tinkers customer whose message merely MENTIONED an agency client ("laori",
 * "SS") got that client\x27s context file, methodology, KPI targets and
 * learnings injected into their prompt. These tests pin the wall.
 */

const laoriContext = readFileSync(join(process.cwd(), "agents", "ada", "clients", "LA.md"), "utf-8");
// A distinctive line from the real context file — if the file is ever
// restructured the INTERNAL test below fails first, telling us to re-pick.
const marker = laoriContext.split("\n").find((l) => l.startsWith("# "))!;

describe("client-context injection scope wall", () => {
  it("INTERNAL Ada gets a mentioned client\x27s context (control)", async () => {
    const prompt = await buildSystemPrompt({
      agentId: "ada",
      userMessage: "how is laori doing this week?",
      userId: "U_TEST",
      channelId: "internal-test",
    });
    expect(prompt).toContain(marker);
  });

  it("client-scoped Ada gets NO other client\x27s context, even when the message names one", async () => {
    const prompt = await buildSystemPrompt({
      agentId: "ada",
      userMessage: "how is laori doing this week? also press london and SS",
      userId: "U_TEST",
      channelId: "internal-test",
      clientScope: { clientCode: "MTR" },
    } as never);
    expect(prompt).not.toContain(marker);
  });
});
