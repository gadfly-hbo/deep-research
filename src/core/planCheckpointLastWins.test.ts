import { describe, expect, it } from "vitest";
import type { Adapters } from "../adapters/types.js";
import { ResearchRequestSchema, type ResearchRun } from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import { runResearch } from "./runResearch.js";
import { scriptedRunAgent } from "../adapters/testing.js";

/**
 * P2-3 T0(KA1 陷阱钉死):plan checkpoint append-only——confirm 只追加新版本时,
 * 无 options.plan 的恢复必须取**最新**一版(find-last),否则编辑版被原版静默覆盖。
 */

const CANCELLED_RUN: ResearchRun = {
  id: "run-t0",
  requestId: "req-t0",
  stage: "plan",
  status: "cancelled",
  checkpoints: [],
  usage: { searches: 0, fetches: 0, modelCalls: 0, outputTokens: 0, wallMs: 0 },
};

const planCp = (version: number) => ({
  runId: "run-t0",
  stage: "plan" as const,
  data: { questions: [{ id: "q1", question: `问题 v${version}`, status: "open" as const }] },
  completedAt: new Date(2026, 0, 1, 0, 0, version).toISOString(),
});

describe("plan checkpoint 恢复取最新(find-last)", () => {
  it("两版 plan checkpoint 无 options.plan 恢复:采证用 v2(编辑版),plan 阶段不重跑", async () => {
    const store = createMemoryStore();
    await store.saveRun(CANCELLED_RUN);
    await store.saveCheckpoint(planCp(1));
    await store.saveCheckpoint(planCp(2));

    const searchQueries: string[] = [];
    const adapters: Adapters = {
      search: { search: async (q) => { searchQueries.push(q); return []; } },
      page: { fetch: async (url) => ({ url, status: 200, contentType: "text/html", html: "" }) },
      parser: { parse: async () => ({ bodyText: "", parseStatus: "failed" as const }) },
      model: {
        extractClaims: async () => ({ claims: [], usage: { modelCalls: 0, outputTokens: 0 } }),
        runAgent: scriptedRunAgent(),
        runStage: async (stage) => {
          if (stage === "plan") throw new Error("恢复路径不应重跑 plan");
          if (stage === "analyze") return { output: { findings: [], gaps: [] }, usage: { modelCalls: 1, outputTokens: 16 } };
          if (stage === "draft" || stage === "polish") return { output: { reportMd: "# 恢复" }, usage: { modelCalls: 1, outputTokens: 16 } };
          return { output: { issues: [], counterexampleChecked: true }, usage: { modelCalls: 1, outputTokens: 16 } };
        },
      },
    };
    const request = ResearchRequestSchema.parse({
      id: "req-t0",
      module: "industry",
      goal: "find-last 钉死",
      scope: { summary: "s", queries: [] },
    });
    const { run } = await runResearch(request, adapters, store, { stopAfter: "gather" });

    expect(run.id).toBe("run-t0"); // 恢复沿用原 runId
    expect(searchQueries).toEqual(["问题 v2"]); // 采证问题 = 最新一版 checkpoint
  });
});
