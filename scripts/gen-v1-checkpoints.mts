// 一次性生成 testdata/v1-checkpoints.json(P0-1 T2 夹具;capped 场景,plan+gather 两条 checkpoint)
import { writeFileSync } from "node:fs";
import { runResearch } from "../src/core/runResearch.js";
import { createMemoryStore } from "../src/stores/memory.js";
import { ResearchRequestSchema } from "../src/contracts.js";
import type { Adapters } from "../src/adapters/types.js";

const fakes: Adapters = {
  search: {
    search: async () => [
      { url: "https://gov.cn/a", title: "官方统计", snippet: "" },
      { url: "https://iresearch.com.cn/r", title: "行业报告", snippet: "" },
    ],
  },
  page: { fetch: async (url) => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }) },
  parser: {
    parse: async () => ({
      bodyText: "中国咖啡市场规模约 1,200 亿元(2025 年)。",
      parseStatus: "ok" as const,
    }),
  },
  model: {
    extractClaims: async () => ({
      claims: [
        {
          statement: "中国咖啡市场规模约 1,200 亿元(2025 年)",
          kind: "fact" as const,
          quote: "中国咖啡市场规模约 1,200 亿元(2025 年)",
          calibration: { entity: "中国咖啡市场", period: "2025", unit: "亿元", value: 1200 },
        },
      ],
      cost: 0.01,
    }),
    runStage: async (stage) => {
      if (stage === "plan") {
        return {
          output: { questions: [{ id: "q1", question: "咖啡市场规模与口径", status: "open" }] },
          cost: 0.01,
        };
      }
      throw new Error(`stopAfter:gather 不应调用 ${stage}`);
    },
  },
};

const store = createMemoryStore();
const request = ResearchRequestSchema.parse({
  id: "req-v1",
  module: "industry",
  goal: "中国咖啡行业规模",
  scope: { summary: "中国大陆 2025", queries: ["咖啡 市场规模"] },
  budget: { maxFetches: 1 },
});
const { run } = await runResearch(request, fakes, store, {
  runId: "run-v1",
  stopAfter: "gather",
});
if (run.status !== "limited") throw new Error(`预期 capped→limited,实得 ${run.status}`);
const cps = await store.checkpoints("run-v1");
const frozen = cps.filter((c) => c.stage === "plan" || c.stage === "gather");
if (frozen.length !== 2) throw new Error(`预期 2 条 checkpoint,实得 ${frozen.length}`);
writeFileSync("testdata/v1-checkpoints.json", JSON.stringify(frozen, null, 2));
const gather = frozen.find((c) => c.stage === "gather")!;
console.log("gather keys:", Object.keys(gather.data as object).sort().join(","));
console.log("capped:", (gather.data as { capped: boolean }).capped);
