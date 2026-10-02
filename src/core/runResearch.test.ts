import { describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { ResearchRequestSchema, type ResearchRequest, type ResearchRun, type RunInstruction } from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import { runResearch, type RunOptions } from "./runResearch.js";

const bodies: Record<string, string> = {
  "https://a/1": "中国咖啡市场规模约 1,200 亿元(2025 年)。",
  "https://b/2": "现磨咖啡门店数持续增长。",
  "https://c/3": "现磨咖啡门店结构持续优化。",
};

function fakeAdapters(fetchedUrls: string[] = [], hits?: Array<{ url: string; title: string; snippet: string }>): Adapters {
  return {
    search: {
      search: async () =>
        hits ?? [
          { url: "https://a/1", title: "A", snippet: "" },
          { url: "https://b/2", title: "B", snippet: "" },
        ],
    },
    page: {
      fetch: async (url): Promise<FetchedPage> => {
        fetchedUrls.push(url);
        return { url, status: 200, contentType: "text/html", html: "<p>x</p>" };
      },
    },
    parser: {
      parse: async (page) => ({ bodyText: bodies[page.url] ?? "", parseStatus: "ok" }),
    },
    model: {
      extractClaims: async ({ snapshot }) =>
        snapshot.url === "https://a/1"
          ? {
              claims: [
                {
                  statement: "中国咖啡市场规模约 1200 亿元(2025)",
                  kind: "fact" as const,
                  quote: "市场规模约 1,200 亿元",
                },
              ],
              cost: 0.01,
            }
          : {
              claims: [
                { statement: "门店数下降", kind: "inference" as const, quote: "门店数下降" },
              ],
              cost: 0.01,
            },
      runStage: async () => {
        throw new Error("gather-only 路径不应调用 runStage");
      },
    },
  };
}

const request: ResearchRequest = ResearchRequestSchema.parse({
  module: "industry",
  goal: "中国咖啡行业规模与结构",
  scope: { summary: "中国大陆 2025", queries: ["咖啡 市场规模"] },
});

const gatherOnly: RunOptions = {
  plan: { questions: [{ id: "q1", question: "咖啡 市场规模", status: "open" }] },
  stopAfter: "gather",
};

describe("runResearch(gather → verify 最小路径)", () => {
  it("采证 → 快照 → 主张 → 引用核查,产出可追溯成果包", async () => {
    const { run, bundle } = await runResearch(request, fakeAdapters(), createMemoryStore(), gatherOnly);
    expect(run.status).toBe("published");
    expect(run.usage).toMatchObject({ searches: 1, fetches: 2 });
    expect(bundle).not.toBeNull();
    expect(bundle!.version).toBe(0);
    expect(bundle!.snapshots).toHaveLength(2);
    expect(bundle!.snapshots.every((s) => s.parseStatus === "ok")).toBe(true);
    expect(bundle!.claims).toHaveLength(2);
    expect(bundle!.evidence[0].snapshotId).toBe("snap:https://a/1");
    expect(bundle!.verdicts.map((v) => v.verdict)).toEqual(["quote-hit", "quote-mismatch"]);
  });

  it("2.1 采证进度:每次落盘携带 progress,当前问题与计数随推进更新", async () => {
    const store = createMemoryStore();
    const savedRuns: ResearchRun[] = [];
    const origSave = store.saveRun;
    store.saveRun = async (r) => {
      savedRuns.push(r);
      return origSave(r);
    };
    const twoQuestions: RunOptions = {
      plan: {
        questions: [
          { id: "q1", question: "咖啡 市场规模", status: "open" },
          { id: "q2", question: "现磨 门店数量", status: "open" },
        ],
      },
      stopAfter: "gather",
    };
    const { run } = await runResearch(request, fakeAdapters(), store, twoQuestions);
    expect(run.progress).toMatchObject({ answered: 2, open: 0, skipped: 0, total: 2 });
    const duringGather = savedRuns.filter((r) => r.stage === "gather" && r.progress);
    expect(duringGather.some((r) => r.progress?.currentQuestionId === "q1")).toBe(true);
    expect(duringGather.some((r) => r.progress?.currentQuestionId === "q2")).toBe(true);
  });

  it("模型成本累计进 run.usage", async () => {
    const { run } = await runResearch(request, fakeAdapters(), createMemoryStore(), gatherOnly);
    expect(run.usage.costEstimate).toBeCloseTo(0.02);
  });

  it("抓取到达预算上限:停止新调用、有限交付并披露限制", async () => {
    const fetchedUrls: string[] = [];
    const capped: ResearchRequest = { ...request, budget: { maxFetches: 1 } };
    const { run, bundle } = await runResearch(capped, fakeAdapters(fetchedUrls), createMemoryStore(), gatherOnly);
    expect(fetchedUrls).toEqual(["https://a/1"]);
    expect(run.usage.fetches).toBe(1);
    expect(run.status).toBe("limited");
    expect(bundle!.limitations.length).toBeGreaterThan(0);
  });
});

describe("runResearch 增量追问(2.1)", () => {
  const baseRequest = ResearchRequestSchema.parse({
    id: "req-base",
    module: "industry",
    goal: "中国咖啡行业规模",
    scope: { summary: "中国大陆 2025", queries: ["咖啡 市场规模"] },
  });

  it("复用基准证据与快照:同 URL 不重抓,产出 reuseSummary 与采录时点披露", async () => {
    const store = createMemoryStore();
    const baseRun = await runResearch(baseRequest, fakeAdapters(), store, {
      plan: { questions: [{ id: "q1", question: "咖啡 市场规模", status: "open" }] },
      stopAfter: "gather",
    });
    expect(baseRun.run.status).toBe("published");

    const fetchedUrls: string[] = [];
    // 增量搜索命中:基准已有的 a/1(复用,不重抓) + 全新的 c/3(新抓)
    const incHits = [
      { url: "https://a/1", title: "A", snippet: "" },
      { url: "https://c/3", title: "C", snippet: "" },
    ];
    const incRequest = ResearchRequestSchema.parse({
      id: "req-inc",
      module: "industry",
      goal: "咖啡行业追问",
      scope: { summary: "中国大陆 2025", queries: ["门店数量"] },
      incrementalOf: { runId: baseRun.run.id, requestId: "req-base" },
    });
    const { run, bundle } = await runResearch(incRequest, fakeAdapters(fetchedUrls, incHits), store, {
      plan: { questions: [{ id: "q2", question: "现磨 门店数量", status: "open" }] },
      stopAfter: "gather",
    });
    expect(fetchedUrls).toEqual(["https://c/3"]);
    expect(run.derivedFromRunId).toBe(baseRun.run.id);
    expect(bundle?.derivedFromRunId).toBe(baseRun.run.id);
    expect(bundle?.reuseSummary).toMatchObject({
      baseRunId: baseRun.run.id,
      newQuestions: 1,
      reusedEvidence: expect.any(Number),
    });
    expect(bundle?.reuseSummary?.reusedEvidence ?? 0).toBeGreaterThanOrEqual(1);
    expect(bundle?.evidence.some((e) => e.quote.includes("市场规模"))).toBe(true);
    expect(bundle?.limitations.join("\n")).toContain("采录");
    // 2.1 增量标注:报告头部注明增量研究,基准主张带复用标记
    expect(bundle?.reportMd).toContain("增量研究");
    expect(bundle?.reportMd).toContain("基准复用");
  });

  it("基准成果包缺失:如实降级为无复用并披露,不击杀 run", async () => {
    const store = createMemoryStore();
    const incRequest = ResearchRequestSchema.parse({
      id: "req-inc-2",
      module: "industry",
      goal: "咖啡行业追问",
      scope: { summary: "s", queries: [] },
      incrementalOf: { runId: "run-missing", requestId: "req-none" },
    });
    const { run, bundle } = await runResearch(incRequest, fakeAdapters(), store, {
      plan: { questions: [{ id: "q1", question: "咖啡 市场规模", status: "open" }] },
      stopAfter: "gather",
    });
    expect(["published", "limited"]).toContain(run.status);
    expect(bundle?.limitations.join("\n")).toContain("基准");
    expect(bundle?.reuseSummary).toBeUndefined();
  });
});

describe("runResearch 执行中干预(2.1)", () => {
  const mkReq = (id: string) =>
    ResearchRequestSchema.parse({ id, module: "industry", goal: "干预测试", scope: { summary: "s", queries: [] } });

  it("skip 跳过当前问题、add 新增问题被采证、干预历史如实落 run", async () => {
    const batches: { id: string; submittedAt: string; instruction: RunInstruction }[][] = [
      [{ id: "ins-1", submittedAt: "2026-10-02T00:00:00.000Z", instruction: { type: "skip-question" } }],
      [{ id: "ins-2", submittedAt: "2026-10-02T00:00:00.000Z", instruction: { type: "add-questions", questions: ["门店结构"] } }],
    ];
    const poll = () => batches.shift() ?? [];
    const store = createMemoryStore();
    const { run, bundle } = await runResearch(mkReq("req-ins-1"), fakeAdapters(), store, {
      plan: {
        questions: [
          { id: "q1", question: "咖啡 市场规模", status: "open" },
          { id: "q2", question: "现磨 门店数量", status: "open" },
        ],
      },
      stopAfter: "gather",
      pollInstructions: poll,
    });
    // q1 被跳过,q2 与新增问题各搜一次
    expect(run.usage.searches).toBe(2);
    expect(run.progress?.skipped).toBe(1);
    expect(run.interventions).toHaveLength(2);
    expect(run.interventions?.[0]).toMatchObject({ instruction: { type: "skip-question" }, effect: "applied" });
    expect(run.interventions?.[1]?.effect).toBe("applied");
    expect(bundle?.unresolved.join("\n")).toContain("跳过");
  });

  it("refine-direction 注入剩余问题搜索;跳过已答问题判 invalid", async () => {
    const queries: string[] = [];
    const adapters = fakeAdapters();
    adapters.search.search = async (q) => {
      queries.push(q);
      return [{ url: "https://a/1", title: "A", snippet: "" }];
    };
    const batches: { id: string; submittedAt: string; instruction: RunInstruction }[][] = [
      [{ id: "ins-1", submittedAt: "2026-10-02T00:00:00.000Z", instruction: { type: "refine-direction", note: "重点看国内市场" } }],
      [
        { id: "ins-2", submittedAt: "2026-10-02T00:00:00.000Z", instruction: { type: "skip-question", questionId: "q1" } },
        { id: "ins-3", submittedAt: "2026-10-02T00:00:00.000Z", instruction: { type: "skip-question", questionId: "q2" } },
      ],
    ];
    const { run } = await runResearch(mkReq("req-ins-2"), adapters, createMemoryStore(), {
      plan: {
        questions: [
          { id: "q1", question: "咖啡 市场规模", status: "open" },
          { id: "q2", question: "现磨 门店数量", status: "open" },
        ],
      },
      stopAfter: "gather",
      pollInstructions: () => batches.shift() ?? [],
    });
    expect(queries[0]).toContain("重点看国内市场");
    const effects = run.interventions?.map((i) => `${i.instruction.type}:${(i.instruction as { questionId?: string }).questionId ?? "cur"}=${i.effect}`);
    expect(effects).toEqual(["refine-direction:cur=applied", "skip-question:q1=invalid", "skip-question:q2=applied"]);
  });

  it("skip 指向后续问题:该问题不采证、状态保持 skipped、干预与事实一致", async () => {
    const batches = [
      [{ id: "ins-1", submittedAt: "2026-10-02T00:00:00.000Z", instruction: { type: "skip-question" as const, questionId: "q3" } }],
    ];
    const { run, bundle } = await runResearch(
      ResearchRequestSchema.parse({ id: "req-ins-4", module: "industry", goal: "跳过后续", scope: { summary: "s", queries: [] } }),
      fakeAdapters(),
      createMemoryStore(),
      {
        plan: {
          questions: [
            { id: "q1", question: "咖啡 市场规模", status: "open" },
            { id: "q2", question: "现磨 门店数量", status: "open" },
            { id: "q3", question: "竞争格局", status: "open" },
          ],
        },
        stopAfter: "gather",
        pollInstructions: () => batches.shift() ?? [],
      },
    );
    // q1/q2 采证,q3 被跳过不搜索
    expect(run.usage.searches).toBe(2);
    expect(run.progress?.skipped).toBe(1);
    expect(run.interventions?.[0]?.effect).toBe("applied");
    expect(bundle?.unresolved.join("\n")).toContain("跳过");
  });

  it("增量检索全命中基准快照:问题如实披露未重复采证", async () => {
    const store = createMemoryStore();
    const baseRun = await runResearch(
      ResearchRequestSchema.parse({ id: "req-base2", module: "industry", goal: "基准", scope: { summary: "s", queries: [] } }),
      fakeAdapters(),
      store,
      { plan: { questions: [{ id: "q1", question: "咖啡 市场规模", status: "open" }] }, stopAfter: "gather" },
    );
    // 增量新问题的搜索只返回基准已采的 a/1
    const incHits = [{ url: "https://a/1", title: "A", snippet: "" }];
    const { bundle } = await runResearch(
      ResearchRequestSchema.parse({
        id: "req-inc3", module: "industry", goal: "追问", scope: { summary: "s", queries: [] },
        incrementalOf: { runId: baseRun.run.id, requestId: "req-base2" },
      }),
      fakeAdapters([], incHits),
      store,
      { plan: { questions: [{ id: "q2", question: "市场规模口径", status: "open" }] }, stopAfter: "gather" },
    );
    expect(bundle?.limitations.join("\n")).toContain("基准研究已采信源");
  });

  it("评审修复(regather)不复活用户已跳过的问题", async () => {
    const adapters = fakeAdapters();
    adapters.model.runStage = async (stage) =>
      stage === "analyze"
        ? { output: { findings: [], gaps: [] }, cost: 0.01 }
        : stage === "draft"
          ? { output: { reportMd: "# 报告" }, cost: 0.01 }
          : {
              output: {
                issues: [
                  { severity: "high" as const, kind: "gap" as const, detail: "补采竞争格局", targetQuestionId: "q3", fix: "regather" as const },
                ],
                counterexampleChecked: true,
              },
              cost: 0.01,
            };
    const batches = [
      [{ id: "ins-1", submittedAt: "2026-10-02T00:00:00.000Z", instruction: { type: "skip-question" as const, questionId: "q3" } }],
    ];
    const { run } = await runResearch(
      ResearchRequestSchema.parse({ id: "req-ins-5", module: "industry", goal: "评审不复活", scope: { summary: "s", queries: [] } }),
      adapters,
      createMemoryStore(),
      {
        plan: {
          questions: [
            { id: "q1", question: "咖啡 市场规模", status: "open" },
            { id: "q3", question: "竞争格局", status: "open" },
          ],
        },
        pollInstructions: () => batches.shift() ?? [],
      },
    );
    expect(run.progress?.skipped).toBe(1);
    expect(run.usage.searches).toBe(1); // 只有 q1;q3 保持 skipped 未被 regather 复活
  });

  it("add-source 文本入证据链挂当前问题;URL 抓取失败记 failed 不中断", async () => {
    const batches: { id: string; submittedAt: string; instruction: RunInstruction }[][] = [
      [
        { id: "ins-1", submittedAt: "2026-10-02T00:00:00.000Z", instruction: { type: "add-source", text: "补充材料:门店结构持续优化" } },
        { id: "ins-2", submittedAt: "2026-10-02T00:00:00.000Z", instruction: { type: "add-source", url: "https://x/fail" } },
      ],
    ];
    const adapters = fakeAdapters();
    adapters.page.fetch = async (url) =>
      url === "https://x/fail"
        ? { url, status: 500, contentType: "text/html", html: "" }
        : { url, status: 200, contentType: "text/html", html: "<p>x</p>" };
    const store = createMemoryStore();
    const { run, bundle } = await runResearch(mkReq("req-ins-3"), adapters, store, {
      plan: { questions: [{ id: "q1", question: "咖啡 市场规模", status: "open" }] },
      stopAfter: "gather",
      pollInstructions: () => batches.shift() ?? [],
    });
    expect(run.interventions?.map((i) => i.effect)).toEqual(["applied", "failed"]);
    expect(bundle?.snapshots.some((s) => s.url.startsWith("user-text://"))).toBe(true);
    expect(bundle?.limitations.join("\n")).toContain("补充信源");
    expect(["published", "limited"]).toContain(run.status);
  });
});
