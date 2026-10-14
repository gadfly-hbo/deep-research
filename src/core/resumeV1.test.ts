/**
 * v1 checkpoint 恢复夹具测试(P0-1 验证基线,GRILL R1.2):
 * 锁住 RunState 序列化形状与 capped 恢复语义——RunState 字段被挪走/重命名时,
 * 旧版落盘的 checkpoint 恢复后必须仍然等价(尤其 capped=true → limited 不得反转为 published)。
 * 夹具由 scripts/gen-v1-checkpoints.mts 以重构前代码合成后手工冻结。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Adapters } from "../adapters/types.js";
import { ResearchRequestSchema, type ResearchRun } from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import type { Checkpoint } from "../stores/types.js";
import { runResearch } from "./runResearch.js";

const FIXTURE = fileURLToPath(new URL("../../testdata/v1-checkpoints.json", import.meta.url));

/** RunState 11 键白名单:任何人增删/重命名字段,此断言必红,须显式改夹具。 */
const RUNSTATE_KEYS = [
  "capped",
  "claimQuestions",
  "claims",
  "counterexampleChecked",
  "draftMd",
  "evidence",
  "findings",
  "limitations",
  "questions",
  "snapshots",
  "unresolved",
];

const CANCELLED_RUN: ResearchRun = {
  id: "run-v1",
  requestId: "req-v1",
  stage: "gather",
  status: "cancelled",
  checkpoints: [],
  usage: { searches: 1, fetches: 1, costEstimate: 0.02, wallMs: 1000 },
};

const resumeFakes = (searchCalls: string[]): Adapters => ({
  search: {
    search: async (query) => {
      searchCalls.push(query);
      return [];
    },
  },
  page: { fetch: async (url) => ({ url, status: 200, contentType: "text/html", html: "" }) },
  parser: { parse: async () => ({ bodyText: "", parseStatus: "failed" as const }) },
  model: {
    extractClaims: async () => ({ claims: [], cost: 0 }),
    runStage: async (stage) => {
      if (stage === "analyze") return { output: { findings: [], gaps: [] }, cost: 0.01 };
      if (stage === "draft" || stage === "polish") return { output: { reportMd: "# 恢复报告" }, cost: 0.01 };
      if (stage === "review") return { output: { issues: [], counterexampleChecked: true }, cost: 0.01 };
      throw new Error(`未预期 stage: ${stage}`);
    },
  },
});

describe("v1 checkpoint 恢复(形状与语义锁定)", () => {
  it("gather checkpoint 键集合 = RunState 11 键白名单", () => {
    const cps = JSON.parse(readFileSync(FIXTURE, "utf8")) as Checkpoint[];
    const gather = cps.find((c) => c.stage === "gather");
    expect(gather, "夹具须含 gather checkpoint").toBeDefined();
    expect(Object.keys(gather!.data as object).sort()).toEqual([...RUNSTATE_KEYS].sort());
    expect((gather!.data as { capped: boolean }).capped).toBe(true);
  });

  it("capped 的 v1 run 恢复后仍为 limited,且不再发起搜索", async () => {
    const cps = JSON.parse(readFileSync(FIXTURE, "utf8")) as Checkpoint[];
    const store = createMemoryStore();
    await store.saveRun(CANCELLED_RUN);
    for (const cp of cps) await store.saveCheckpoint(cp);

    const searchCalls: string[] = [];
    const request = ResearchRequestSchema.parse({
      id: "req-v1",
      module: "industry",
      goal: "中国咖啡行业规模",
      scope: { summary: "中国大陆 2025", queries: ["咖啡 市场规模"] },
    });
    const { run, bundle } = await runResearch(request, resumeFakes(searchCalls), store, {});

    expect(run.id).toBe("run-v1"); // 恢复沿用原 runId
    expect(run.status).toBe("limited"); // capped 不反转为 published
    expect(searchCalls).toEqual([]); // gather checkpoint 命中,恢复轮 0 次搜索
    expect(bundle).not.toBeNull();
    expect(bundle!.limitations.join("\n")).toContain("预算上限到达");
  });
});
