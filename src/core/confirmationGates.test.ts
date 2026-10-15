import { describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { ResearchRequestSchema, type ResearchRequest, type ResearchRun, type ReportOutline } from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import type { MemoryStore } from "../stores/memory.js";
import { runResearch, type RunOptions } from "./runResearch.js";
import type { PlanOutput, StageName } from "./stages.js";
import { scriptedRunAgent } from "../adapters/testing.js";

/**
 * P2-3 T1 编排器确认门:gates 下 plan 产出→返回式门→confirm(编辑)续跑→outline 门→
 * confirm→gather;编辑版生效;CLI/测试无 gates 旧行为不变(D1/KA4)。
 */

const bodies: Record<string, string> = {
  "https://a/1": "中国咖啡市场规模约 1,200 亿元(2025 年)。",
};

interface StageCall {
  stage: StageName;
  input: Record<string, unknown>;
}

const gateFakes = (stageCalls: StageCall[], searchQueries: string[]): Adapters => ({
  search: {
    search: async (q) => {
      searchQueries.push(q);
      return [{ url: "https://a/1", title: "A", snippet: "" }];
    },
  },
  page: {
    fetch: async (url): Promise<FetchedPage> => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }),
  },
  parser: { parse: async (page) => ({ bodyText: bodies[page.url] ?? "", parseStatus: "ok" }) },
  model: {
    extractClaims: async () => ({
      claims: [{ statement: "市场规模约 1200 亿元(2025)", kind: "fact" as const, quote: "市场规模约 1,200 亿元" }],
      usage: { modelCalls: 1, outputTokens: 16 },
    }),
    runAgent: scriptedRunAgent(),
    runStage: async (stage, input) => {
      stageCalls.push({ stage, input: input as Record<string, unknown> });
      if (stage === "plan") {
        return {
          output: { questions: [{ id: "q1", question: "原始问题", status: "open" }] },
          usage: { modelCalls: 1, outputTokens: 16 },
        };
      }
      if (stage === "outline") {
        return {
          output: { title: "原始框架", sections: [{ id: "s1", title: "市场规模", bullets: [] }] },
          usage: { modelCalls: 1, outputTokens: 16 },
        };
      }
      if (stage === "analyze") return { output: { findings: [], gaps: [] }, usage: { modelCalls: 1, outputTokens: 16 } };
      if (stage === "draft" || stage === "polish") {
        return { output: { reportMd: "# 报告" }, usage: { modelCalls: 1, outputTokens: 16 } };
      }
      return { output: { issues: [], counterexampleChecked: true }, usage: { modelCalls: 1, outputTokens: 16 } };
    },
  },
});

const GATES: RunOptions = { gates: { plan: true, outline: true } };

const mkRequest = (over: Partial<ResearchRequest> = {}) =>
  ResearchRequestSchema.parse({ id: "req-gate", module: "industry", goal: "门流研究", scope: { summary: "s", queries: [] }, ...over });

/** 模拟 routes 层 plan 门 confirm:追加编辑版 checkpoint + CAS 置回 running 并清 gate 字段(R1-3)。 */
const confirmPlanGate = async (store: MemoryStore, gated: ResearchRun, edited: PlanOutput) => {
  await store.saveCheckpoint({ runId: gated.id, stage: "plan", data: edited, completedAt: new Date().toISOString() });
  await store.saveRun({ ...gated, status: "running", gate: undefined });
};

describe("编排器确认门(P2-3 T1)", () => {
  it("gates 全流:plan 门→confirm(编辑)→outline 门→confirm→完成,编辑版生效", async () => {
    const store = createMemoryStore();
    const stageCalls: StageCall[] = [];
    const searchQueries: string[] = [];
    const adapters = gateFakes(stageCalls, searchQueries);
    const request = mkRequest();

    // ① 起:plan 产出后落返回式门
    const first = await runResearch(request, adapters, store, GATES);
    expect(first.run.status).toBe("awaiting-confirmation");
    expect(first.run.gate).toEqual({ kind: "plan" });
    expect(first.run.stage).toBe("plan"); // R1-1:门落盘时 stage 保持 plan
    expect(first.bundle).toBeNull();
    expect((await store.checkpoints(first.run.id)).some((c) => c.stage === "plan")).toBe(true);

    // ② plan confirm(编辑一问):续跑进 outline 门,门输入=编辑版问题(关键回归)
    const edited: PlanOutput = { questions: [{ id: "q1", question: "编辑后问题", status: "open" }] };
    await confirmPlanGate(store, first.run, edited);
    const second = await runResearch(request, adapters, store, { ...GATES, plan: edited });
    expect(second.run.id).toBe(first.run.id); // 沿用原 runId,不新起(KA1)
    expect(second.run.status).toBe("awaiting-confirmation");
    expect(second.run.gate).toEqual({ kind: "outline" });
    expect(second.run.stage).toBe("plan"); // R1-1:两道门 stage 均保持 plan
    const outlineCall = stageCalls.find((c) => c.stage === "outline");
    expect(outlineCall?.input.questions).toEqual(["编辑后问题"]);
    expect(stageCalls.filter((c) => c.stage === "plan")).toHaveLength(1); // plan 不重跑
    expect((await store.checkpoints(second.run.id)).some((c) => c.stage === "outline")).toBe(true);

    // ③ outline confirm:注入 request.outline(R1-2)后直跑到发布
    const outlinePayload: ReportOutline = {
      title: "编辑后框架",
      sections: [{ id: "s1", title: "市场规模", bullets: [] }],
    };
    const third = await runResearch(mkRequest({ outline: outlinePayload }), adapters, store, GATES);
    expect(["published", "limited"]).toContain(third.run.status);
    expect(third.run.gate).toBeUndefined();
    expect(stageCalls.filter((c) => c.stage === "plan")).toHaveLength(1);
    expect(stageCalls.filter((c) => c.stage === "outline")).toHaveLength(1);
    const draftCall = stageCalls.filter((c) => c.stage === "draft").at(-1);
    expect(draftCall?.input.outline).toEqual(outlinePayload); // 草稿按确认后的框架展开
    expect(searchQueries).toContain("编辑后问题"); // 采证问题=编辑版(经 find-last 恢复)
    expect(third.run.usage.modelCalls).toBeGreaterThan(first.run.usage.modelCalls); // 计量跨段累计(P2-2 不回零)
  });

  it("无 gates 旧行为:一次直跑到完成,不设门、不跑 outline 阶段", async () => {
    const stageCalls: StageCall[] = [];
    const adapters = gateFakes(stageCalls, []);
    const { run } = await runResearch(mkRequest({ id: "req-legacy" }), adapters, createMemoryStore(), {});
    expect(["published", "limited"]).toContain(run.status);
    expect(run.gate).toBeUndefined();
    expect(stageCalls.some((c) => c.stage === "outline")).toBe(false);
    expect(stageCalls.filter((c) => c.stage === "plan")).toHaveLength(1);
  });

  it("增量追问走门:plan 输入带基准已答问题,6 问截断;outline 输入带基准框架", async () => {
    const store = createMemoryStore();
    const baseOutline: ReportOutline = { title: "基准框架", sections: [{ id: "s1", title: "市场规模", bullets: [] }] };
    // 基准 run:问题已答 + 框架进 bundle(走全管线,stopAfter 产物不含 outline)
    const base = await runResearch(
      mkRequest({ id: "req-base", outline: baseOutline }),
      gateFakes([], []),
      store,
      { plan: { questions: [{ id: "q1", question: "基准问题", status: "open" }] } },
    );
    expect(["published", "limited"]).toContain(base.run.status);

    // 增量 run 走 plan 门:fake plan 产出 8 问 → 截断到 6
    const stageCalls: StageCall[] = [];
    const adapters = gateFakes(stageCalls, []);
    const adapters8Q: Adapters = {
      ...adapters,
      model: {
        ...adapters.model,
        runAgent: scriptedRunAgent(),
        runStage: async (stage, input) => {
          if (stage === "plan") {
            stageCalls.push({ stage, input: input as Record<string, unknown> });
            return {
              output: {
                questions: Array.from({ length: 8 }, (_, i) => ({ id: `q${i + 1}`, question: `新问题 ${i + 1}`, status: "open" })),
              },
              usage: { modelCalls: 1, outputTokens: 16 },
            };
          }
          return adapters.model.runStage(stage, input, "k");
        },
      },
    };
    const incRequest = mkRequest({
      id: "req-inc-gate",
      incrementalOf: { runId: base.run.id, requestId: "req-base" },
    });
    const gated = await runResearch(incRequest, adapters8Q, store, GATES);
    expect(gated.run.status).toBe("awaiting-confirmation");
    expect(gated.run.gate).toEqual({ kind: "plan" });
    const planInput = stageCalls.find((c) => c.stage === "plan")!.input;
    expect(planInput.incremental).toMatchObject({
      answeredQuestions: ["基准问题"],
      newQuestionBudget: 6,
    });
    const planCp = (await store.checkpoints(gated.run.id)).findLast((c) => c.stage === "plan");
    expect((planCp!.data as PlanOutput).questions).toHaveLength(6); // R1-8:增量 6 问上限

    // confirm 后 outline 门:输入带基准框架(baseOutline)与已答问题
    const edited: PlanOutput = { questions: (planCp!.data as PlanOutput).questions };
    await confirmPlanGate(store, gated.run, edited);
    const outlineRun = await runResearch(incRequest, adapters, store, { ...GATES, plan: edited });
    expect(outlineRun.run.gate).toEqual({ kind: "outline" });
    const outlineInput = stageCalls.find((c) => c.stage === "outline")!.input;
    expect(outlineInput.incremental).toMatchObject({
      baseOutline: baseOutline,
      answeredQuestions: ["基准问题"],
    });
    expect(outlineInput.questions).toHaveLength(6);
  });
});
