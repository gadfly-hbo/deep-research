/* U1 T1:名称字段落盘/读回/编排器透传(G1-1 生死点 + K2 strip 陷阱钉死)。
   缝:FsProjectStore 存储缝(fsStore.test 先例)+ runResearch 唯一入口(budgetTopup fakes 先例)。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FetchedPage } from "../adapters/types.js";
import { scriptedRunAgent } from "../adapters/testing.js";
import { ResearchRequestSchema } from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import { FsProjectStore } from "../stores/fsStore.js";
import { runResearch } from "./runResearch.js";

const USAGE = { modelCalls: 1, outputTokens: 16 };

const fakes = {
  search: { search: async () => [{ url: "https://a/1", title: "A", snippet: "" }] },
  page: { fetch: async (url: string): Promise<FetchedPage> => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }) },
  parser: { parse: async () => ({ bodyText: "中国咖啡市场规模约 1,200 亿元(2025 年)。", parseStatus: "ok" as const }) },
  model: {
    extractClaims: async ({ snapshot }: { snapshot: { url: string } }) => ({
      claims: [{ statement: `${snapshot.url} 的主张`, kind: "fact" as const, quote: "市场规模" }],
      usage: { ...USAGE },
    }),
    runStage: async () => ({ output: { findings: [], gaps: [] }, usage: { ...USAGE } }),
    runAgent: scriptedRunAgent(),
  },
};

describe("U1 T1:名称字段落盘/读回", () => {
  it("run.json 往返:name 经 saveRun 落盘后 listRuns 读回存活(K2:readRun zod strip 陷阱)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dr-u1-rt-"));
    const store = FsProjectStore.create(dir, { module: "industry", goal: "g", scope: { summary: "s", queries: [] } });
    await store.saveRun({
      id: "run-n1", requestId: "req-n1", stage: "gather", status: "limited", checkpoints: [],
      usage: { searches: 0, fetches: 0, modelCalls: 0, outputTokens: 0, wallMs: 0 },
      name: "任务甲",
    });
    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].name).toBe("任务甲");
  });
});

describe("U1 T1:编排器 name 透传(G1-1:新鲜路径会重建 run 对象覆写预落记录)", () => {
  it("带 plan 免门直跑(同 rerun/宿主路径):run 记录落盘含 name", async () => {
    const store = createMemoryStore();
    const request = ResearchRequestSchema.parse({
      id: "req-naming-1", module: "industry", goal: "g", scope: { summary: "s", queries: [] }, name: "任务甲",
    });
    const { run } = await runResearch(request, fakes as never, store, {
      runId: "run-naming-1",
      plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }] },
      stopAfter: "gather",
    });
    expect(run.name).toBe("任务甲");
    const readBack = await store.findRunByRequestId("req-naming-1");
    expect(readBack?.name).toBe("任务甲");
  });

  it("恢复 spread 路径:name 随 prior 存活(防未来构造点丢字段)", async () => {
    const store = createMemoryStore();
    await store.saveRun({
      id: "run-naming-2", requestId: "req-naming-2", stage: "gather", status: "cancelled", checkpoints: ["gather"],
      usage: { searches: 1, fetches: 0, modelCalls: 1, outputTokens: 8, wallMs: 1 },
      name: "任务乙",
    });
    const request = ResearchRequestSchema.parse({
      id: "req-naming-2", module: "industry", goal: "g", scope: { summary: "s", queries: [] }, name: "任务乙",
    });
    const { run } = await runResearch(request, fakes as never, store, {
      runId: "run-naming-2",
      plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }] },
      stopAfter: "gather",
    });
    expect(run.name).toBe("任务乙");
  });
});
