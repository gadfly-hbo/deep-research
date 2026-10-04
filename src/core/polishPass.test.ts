import { describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { ResearchRequestSchema, type ResearchRequest } from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import { runResearch, type RunResult } from "./runResearch.js";

const DRAFT_MD = "# 报告草稿\n\n## 市场\nx";
const POLISHED_MD = "# 润色后报告\n\n## 市场\n充实后的正文";

function adapters(opts: {
  captured: Array<{ stage: string; input: unknown }>;
  polishOutput?: unknown;
}): Adapters {
  const { captured, polishOutput } = opts;
  return {
    search: { search: async () => [{ url: "https://a/1", title: "A", snippet: "" }] },
    page: {
      fetch: async (url): Promise<FetchedPage> => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }),
    },
    parser: {
      parse: async () => ({ bodyText: "素材正文,市场规模约 1,200 亿元,增长稳健。", parseStatus: "ok" as const }),
    },
    model: {
      extractClaims: async () => ({
        claims: [{ statement: "市场规模 1200 亿", kind: "fact" as const, quote: "市场规模约 1,200 亿元" }],
        cost: 0.01,
      }),
      runStage: async (stage, input) => {
        captured.push({ stage, input });
        if (stage === "analyze") return { output: { findings: [], gaps: [] }, cost: 0.01 };
        if (stage === "draft") return { output: { reportMd: DRAFT_MD }, cost: 0.01 };
        if (stage === "polish") return { output: polishOutput ?? { reportMd: POLISHED_MD }, cost: 0.02 };
        if (stage === "review") return { output: { issues: [], counterexampleChecked: true }, cost: 0.01 };
        throw new Error(`未预期的阶段: ${stage}`);
      },
    },
  };
}

const baseRequest = (over: Partial<ResearchRequest> = {}): ResearchRequest =>
  ResearchRequestSchema.parse({
    module: "industry",
    goal: "中国咖啡行业规模",
    scope: { summary: "中国大陆 2025", queries: ["咖啡 市场规模"] },
    ...over,
  });

const planOnly = { plan: { questions: [{ id: "q1", question: "咖啡 市场规模", status: "open" as const }] } };

describe("polish 润色 pass", () => {
  it("polish 在 draft 之后 review 之前执行,输入含草稿与素材包,产物进入评审", async () => {
    const captured: Array<{ stage: string; input: unknown }> = [];
    const { run, bundle } = await runResearch(
      baseRequest(),
      adapters({ captured }),
      createMemoryStore(),
      planOnly,
    );
    expect(bundle).not.toBeNull();
    const stages = captured.map((c) => c.stage);
    const iDraft = stages.indexOf("draft");
    const iPolish = stages.indexOf("polish");
    const iReview = stages.indexOf("review");
    expect(iDraft).toBeGreaterThanOrEqual(0);
    expect(iPolish).toBeGreaterThan(iDraft);
    expect(iReview).toBeGreaterThan(iPolish);
    const polishInput = captured[iPolish].input as { draftMd?: string; evidencePacks?: unknown };
    expect(polishInput.draftMd).toBe(DRAFT_MD);
    expect(Array.isArray(polishInput.evidencePacks)).toBe(true);
    // 评审吃的是润色后草稿
    const reviewInput = captured[iReview].input as { draftMd?: string };
    expect(reviewInput.draftMd).toBe(POLISHED_MD);
    expect(bundle!.reportMd).toContain("润色后报告");
    expect(captured.filter((c) => c.stage === "polish")).toHaveLength(1);
    // 润色成本计入 usage(0.01×4 + 0.02 polish = 0.06)
    expect(run.usage.costEstimate).toBeGreaterThanOrEqual(0.06);
  });

  it("polish:false 时跳过润色,评审直接吃草稿原文", async () => {
    const captured: Array<{ stage: string; input: unknown }> = [];
    const { bundle } = await runResearch(
      baseRequest({ polish: false }),
      adapters({ captured }),
      createMemoryStore(),
      planOnly,
    );
    expect(captured.some((c) => c.stage === "polish")).toBe(false);
    const reviewInput = captured.find((c) => c.stage === "review")!.input as { draftMd?: string };
    expect(reviewInput.draftMd).toBe(DRAFT_MD);
    expect(bundle!.reportMd).toContain("报告草稿");
  });

  it("polish 输出不合格 → 沿用草稿原文并披露限制", async () => {
    const captured: Array<{ stage: string; input: unknown }> = [];
    const { bundle }: RunResult = await runResearch(
      baseRequest(),
      adapters({ captured, polishOutput: { nope: 1 } }),
      createMemoryStore(),
      planOnly,
    );
    const reviewInput = captured.find((c) => c.stage === "review")!.input as { draftMd?: string };
    expect(reviewInput.draftMd).toBe(DRAFT_MD);
    expect(bundle!.limitations.some((l) => l.includes("润色"))).toBe(true);
  });
});

describe("polish 恢复语义", () => {
  it("polish:false 恢复含 polish checkpoint 的 run → 产物回退草稿原文", async () => {
    const store = createMemoryStore();
    const first: Array<{ stage: string; input: unknown }> = [];
    await runResearch(baseRequest({ id: "req-resume" }), adapters({ captured: first }), store, planOnly);
    // 模拟用户取消已完成 run 后携带 polish:false 恢复
    const prior = await store.findRunByRequestId("req-resume");
    await store.saveRun({ ...prior!, status: "cancelled" });
    const second: Array<{ stage: string; input: unknown }> = [];
    const { bundle } = await runResearch(
      baseRequest({ id: "req-resume", polish: false }),
      adapters({ captured: second }),
      store,
      planOnly,
    );
    expect(second.some((c) => c.stage === "polish")).toBe(false);
    expect(bundle!.reportMd).toContain("报告草稿");
    expect(bundle!.reportMd).not.toContain("润色后报告");
  });
});
