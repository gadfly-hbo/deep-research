import { describe, expect, it } from "vitest";
import type { Adapters, ExtractedClaim, SearchHit } from "../adapters/types.js";
import { ResearchRequestSchema, type ResearchRequest } from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import { runResearch, type RunOptions } from "./runResearch.js";
import type { StageName } from "./stages.js";

interface FakeCfg {
  searchResults: Record<string, SearchHit[]>;
  bodies: Record<string, string>;
  extract: (url: string, call: number) => { claims: ExtractedClaim[]; cost: number };
  stage: (stage: StageName, call: number) => { output: unknown; cost: number };
  onSearch?: (q: string) => void;
}

function fakes(cfg: FakeCfg): Adapters {
  const extractCounts = new Map<string, number>();
  const stageCounts = new Map<StageName, number>();
  return {
    search: {
      search: async (q) => {
        cfg.onSearch?.(q);
        return cfg.searchResults[q] ?? [];
      },
    },
    page: {
      fetch: async (url) => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }),
    },
    parser: {
      parse: async (page) => ({ bodyText: cfg.bodies[page.url] ?? "", parseStatus: "ok" }),
    },
    model: {
      extractClaims: async ({ snapshot }) => {
        const n = extractCounts.get(snapshot.url) ?? 0;
        extractCounts.set(snapshot.url, n + 1);
        return cfg.extract(snapshot.url, n);
      },
      runStage: async (stage, _input, _key) => {
        const n = stageCounts.get(stage) ?? 0;
        stageCounts.set(stage, n + 1);
        return cfg.stage(stage, n);
      },
    },
  };
}

const A = "https://a/1";
const B = "https://b/2";
const baseRequest = (): ResearchRequest =>
  ResearchRequestSchema.parse({
    id: "req-1",
    module: "industry",
    goal: "中国咖啡行业研究",
    scope: { summary: "中国大陆 2025", queries: [] },
  });
const twoQuestions: RunOptions = {
  plan: {
    questions: [
      { id: "q1", question: "市场规模", status: "open" },
      { id: "q2", question: "门店数", status: "open" },
    ],
  },
};
const searchAB = { 市场规模: [{ url: A, title: "A", snippet: "" }], 门店数: [{ url: B, title: "B", snippet: "" }] };
const bodyA = "中国咖啡市场规模约 1,200 亿元(2025 年)。行业边界包括现磨与即饮。";
const bodyB = "2025 年现磨咖啡门店约 12 万家。产业链上游为咖啡豆贸易。竞争格局集中度提升。";
const cleanStages = (stage: StageName): { output: unknown; cost: number } =>
  stage === "analyze"
    ? { output: { findings: [{ questionId: "q1", summary: "规模已确认", claimIds: [] }], gaps: [] }, cost: 0.01 }
    : stage === "draft"
      ? { output: { reportMd: "# 中国咖啡行业研究\n\n## 市场口径表\n规模 1200 亿元。\n\n## 行业结构\n产业链结构。\n\n## 趋势与风险\n趋势。" }, cost: 0.01 }
      : { output: { issues: [], counterexampleChecked: true }, cost: 0.01 };

describe("runResearch 全流水线(plan → gather → analyze → draft → review → publish)", () => {
  it("端到端:确认计划后全流程跑通,正常交付,契约校验与检查点齐全", async () => {
    const store = createMemoryStore();
    const { run, bundle } = await runResearch(
      baseRequest(),
      fakes({
        searchResults: searchAB,
        bodies: { [A]: bodyA, [B]: bodyB },
        extract: (url) =>
          url === A
            ? { claims: [
                { statement: "市场规模约 1200 亿元(2025)", kind: "fact", quote: "市场规模约 1,200 亿元", calibration: { entity: "中国咖啡市场", period: "2025", unit: "亿元", value: 1200 } },
                { statement: "行业边界包括现磨与即饮", kind: "fact", quote: "行业边界包括现磨与即饮" },
              ], cost: 0.01 }
            : { claims: [
                { statement: "门店约 12 万家(2025)", kind: "fact", quote: "门店约 12 万家", calibration: { entity: "中国现磨咖啡门店数", period: "2025", unit: "万家", value: 12 } },
                { statement: "产业链上游为咖啡豆贸易", kind: "fact", quote: "产业链上游为咖啡豆贸易" },
                { statement: "竞争格局集中度提升", kind: "fact", quote: "竞争格局集中度提升" },
              ], cost: 0.01 },
        stage: (stage) => cleanStages(stage),
      }),
      store,
      twoQuestions,
    );
    expect(run.status).toBe("published");
    expect(bundle!.claims).toHaveLength(5);
    expect(bundle!.verdicts.every((v) => v.verdict === "quote-hit")).toBe(true);
    expect(bundle!.reportMd).toContain("# 中国咖啡行业研究");
    expect(bundle!.reportMd).toContain("## 主张状态与引用判定");
    expect(run.usage.searches).toBe(2);
    const stages = (await store.checkpoints(run.id)).map((c) => c.stage);
    for (const s of ["gather", "analyze", "draft", "review"]) expect(stages).toContain(s);
  });

  it("预算到顶:停止新调用,有限交付并列出未解决问题", async () => {
    const cappedReq: ResearchRequest = { ...baseRequest(), budget: { maxFetches: 1 } };
    const { run, bundle } = await runResearch(
      cappedReq,
      fakes({
        searchResults: searchAB,
        bodies: { [A]: bodyA, [B]: bodyB },
        extract: () => ({ claims: [{ statement: "s", kind: "fact", quote: "市场规模约 1,200 亿元" }], cost: 0.01 }),
        stage: (stage) => cleanStages(stage),
      }),
      createMemoryStore(),
      twoQuestions,
    );
    expect(run.status).toBe("limited");
    expect(run.usage.fetches).toBe(1);
    expect(bundle!.limitations.length).toBeGreaterThan(0);
    expect(bundle!.unresolved.some((u) => u.includes("门店数"))).toBe(true);
  });

  it("取消:采集中止,保留检查点语义,不产出成果包", async () => {
    const ctl = new AbortController();
    const searched: string[] = [];
    const { run, bundle } = await runResearch(
      baseRequest(),
      fakes({
        searchResults: searchAB,
        bodies: { [A]: bodyA, [B]: bodyB },
        extract: () => {
          ctl.abort();
          return { claims: [{ statement: "s", kind: "fact", quote: "市场规模约 1,200 亿元" }], cost: 0.01 };
        },
        stage: (stage) => cleanStages(stage),
        onSearch: (q) => searched.push(q),
      }),
      createMemoryStore(),
      { ...twoQuestions, signal: ctl.signal },
    );
    expect(run.status).toBe("cancelled");
    expect(bundle).toBeNull();
    expect(searched).toEqual(["市场规模"]);
  });

  it("恢复:取消后自最后完成阶段续跑,不重跑已完成调用", async () => {
    const store = createMemoryStore();
    const ctl = new AbortController();
    let searched = 0;
    const adapters = fakes({
      searchResults: searchAB,
      bodies: { [A]: bodyA, [B]: bodyB },
      extract: (url) =>
        url === A
          ? { claims: [
              { statement: "市场规模约 1200 亿元(2025)", kind: "fact", quote: "市场规模约 1,200 亿元", calibration: { entity: "中国咖啡市场", period: "2025", unit: "亿元", value: 1200 } },
              { statement: "行业边界包括现磨与即饮", kind: "fact", quote: "行业边界包括现磨与即饮" },
            ], cost: 0.01 }
          : { claims: [
              { statement: "门店约 12 万家(2025)", kind: "fact", quote: "门店约 12 万家", calibration: { entity: "中国现磨咖啡门店数", period: "2025", unit: "万家", value: 12 } },
              { statement: "产业链上游为咖啡豆贸易", kind: "fact", quote: "产业链上游为咖啡豆贸易" },
              { statement: "竞争格局集中度提升", kind: "fact", quote: "竞争格局集中度提升" },
            ], cost: 0.01 },
      stage: (stage) => {
        if (stage === "draft") ctl.abort();
        return cleanStages(stage);
      },
      onSearch: () => (searched += 1),
    });
    const first = await runResearch(baseRequest(), adapters, store, { ...twoQuestions, signal: ctl.signal });
    expect(first.run.status).toBe("cancelled");
    expect(searched).toBe(2);

    const second = await runResearch(baseRequest(), adapters, store, {
      ...twoQuestions,
      signal: new AbortController().signal,
    });
    expect(second.run.id).toBe(first.run.id);
    expect(second.run.status).toBe("published");
    expect(searched).toBe(2);
  });

  it("高风险注入:引用核查失败触发回环,只重采受影响问题,修复后复核发布", async () => {
    const searched: string[] = [];
    let reviewCalls = 0;
    const { run, bundle } = await runResearch(
      baseRequest(),
      fakes({
        searchResults: searchAB,
        bodies: { [A]: "实际市场规模数据为 1,200 亿元。", [B]: bodyB + "行业边界包括现磨与即饮。" },
        extract: (url, call) =>
          url === A && call === 0
            ? { claims: [{ statement: "市场规模数据", kind: "fact", quote: "不存在的数据" }], cost: 0.01 }
            : url === A
              ? { claims: [{ statement: "市场规模数据", kind: "fact", quote: "实际市场规模数据" }], cost: 0.01 }
              : { claims: [
                  { statement: "门店约 12 万家(2025)", kind: "fact", quote: "门店约 12 万家", calibration: { entity: "中国现磨咖啡门店数", period: "2025", unit: "万家", value: 12 } },
                  { statement: "行业边界包括现磨与即饮", kind: "fact", quote: "行业边界包括现磨与即饮" },
                  { statement: "产业链上游为咖啡豆贸易", kind: "fact", quote: "产业链上游为咖啡豆贸易" },
                  { statement: "竞争格局集中度提升", kind: "fact", quote: "竞争格局集中度提升" },
                ], cost: 0.01 },
        stage: (stage) => {
          if (stage !== "review") return cleanStages(stage);
          reviewCalls += 1;
          return reviewCalls === 1
            ? { output: { issues: [{ severity: "high", kind: "citation", detail: "引句与原文不符", targetQuestionId: "q1", fix: "regather" }], counterexampleChecked: true }, cost: 0.01 }
            : { output: { issues: [], counterexampleChecked: true }, cost: 0.01 };
        },
        onSearch: (q) => searched.push(q),
      }),
      createMemoryStore(),
      twoQuestions,
    );
    expect(run.status).toBe("published");
    expect(searched.filter((q) => q === "市场规模")).toHaveLength(2);
    expect(searched.filter((q) => q === "门店数")).toHaveLength(1);
    expect(bundle!.verdicts.every((v) => v.verdict === "quote-hit")).toBe(true);
    expect(bundle!.claims.find((c) => c.id.startsWith("cl:q1:"))!.kind).toBe("fact");
  });

  it("不可修复:回环耗尽后有限交付,失败关键结论降级为未验证", async () => {
    const { run, bundle } = await runResearch(
      baseRequest(),
      fakes({
        searchResults: searchAB,
        bodies: { [A]: "实际市场规模数据为 1,200 亿元。", [B]: bodyB },
        extract: (url) =>
          url === A
            ? { claims: [{ statement: "市场规模数据", kind: "fact", quote: "不存在的数据" }], cost: 0.01 }
            : { claims: [{ statement: "门店约 12 万家(2025)", kind: "fact", quote: "门店约 12 万家", calibration: { entity: "中国现磨咖啡门店数", period: "2025", unit: "万家", value: 12 } }], cost: 0.01 },
        stage: (stage) =>
          stage === "review"
            ? { output: { issues: [{ severity: "high", kind: "citation", detail: "引句与原文不符", targetQuestionId: "q1", fix: "regather" }], counterexampleChecked: true }, cost: 0.01 }
            : cleanStages(stage),
      }),
      createMemoryStore(),
      twoQuestions,
    );
    expect(run.status).toBe("limited");
    const aClaim = bundle!.claims.find((c) => c.id.startsWith("cl:q1:"))!;
    expect(aClaim.kind).toBe("unverified");
    expect(bundle!.limitations.some((l) => l.includes("引用核查未通过"))).toBe(true);
  });

  it("引句命中率 < 80%:有限交付,报告逐主张标注状态", async () => {
    const { run, bundle } = await runResearch(
      baseRequest(),
      fakes({
        searchResults: { 市场规模: [{ url: A, title: "A", snippet: "" }] },
        bodies: { [A]: bodyA },
        extract: () => ({
          claims: [
            { statement: "市场规模约 1200 亿元(2025)", kind: "fact", quote: "市场规模约 1,200 亿元" },
            { statement: "市场规模约 2000 亿元(2025)", kind: "fact", quote: "市场规模约 2,000 亿元" },
          ],
          cost: 0.01,
        }),
        stage: (stage) => cleanStages(stage),
      }),
      createMemoryStore(),
      { plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }] } },
    );
    expect(run.status).toBe("limited");
    expect(bundle!.reportMd).toContain("unverified|置信度:low");
    expect(bundle!.reportMd).toContain("quote-mismatch");
    expect(bundle!.claims.map((c) => c.kind).sort()).toEqual(["fact", "unverified"]);
  });

  it("口径冲突:同对象同期不同单位被检出并在报告中披露,披露后可正常发布", async () => {
    const { run, bundle } = await runResearch(
      baseRequest(),
      fakes({
        searchResults: searchAB,
        bodies: { [A]: bodyA, [B]: "按 170 百万美元口径折算。行业边界包括现磨与即饮。产业链上游为咖啡豆贸易。竞争格局集中度提升。" },
        extract: (url) =>
          url === A
            ? { claims: [{ statement: "市场规模约 1200 亿元(2025)", kind: "fact", quote: "市场规模约 1,200 亿元", calibration: { entity: "中国咖啡市场", period: "2025", unit: "亿元", value: 1200 } }], cost: 0.01 }
            : { claims: [
                { statement: "市场规模约 170 百万美元(2025)", kind: "fact", quote: "170 百万美元", calibration: { entity: "中国咖啡市场", period: "2025", unit: "百万美元", value: 170 } },
                { statement: "行业边界包括现磨与即饮", kind: "fact", quote: "行业边界包括现磨与即饮" },
                { statement: "产业链上游为咖啡豆贸易", kind: "fact", quote: "产业链上游为咖啡豆贸易" },
                { statement: "竞争格局集中度提升", kind: "fact", quote: "竞争格局集中度提升" },
              ], cost: 0.01 },
        stage: (stage) => cleanStages(stage),
      }),
      createMemoryStore(),
      twoQuestions,
    );
    expect(run.status).toBe("published");
    expect(bundle!.reportMd).toContain("## 口径冲突披露");
    expect(bundle!.reportMd).toContain("中国咖啡市场");
  });

  it("真实性核查:蕴涵失败/数值不符硬降级,跨源合并主张置信度 high,仅C级单源置信度 low", async () => {
    const U1 = "https://www.21jingji.com/article/a1";
    const U2 = "https://www.yicai.com/news/a2";
    const U3 = "https://zhuanlan.zhihu.com/p/a3";
    const U4 = "https://unknown.example.com/a4";
    const { run, bundle } = await runResearch(
      baseRequest(),
      fakes({
        searchResults: {
          规模与门店: [
            { url: U1, title: "21财经", snippet: "" },
            { url: U2, title: "一财", snippet: "" },
            { url: U3, title: "知乎", snippet: "" },
            { url: U4, title: "未知站", snippet: "" },
          ],
        },
        bodies: {
          [U1]: "森马门店数达1488家,居行业前列。市场规模约1,200亿元。",
          [U2]: "市场规模约1,200亿元。",
          [U3]: "门店口碑热度很高。",
          [U4]: "年营收约1,200亿元。",
        },
        extract: (url) => {
          if (url === U1)
            return {
              claims: [
                { statement: "森马门店数位居全国行业榜首", kind: "fact" as const, quote: "门店数达1488家,居行业前列" },
                { statement: "市场规模约1200亿元", kind: "fact" as const, quote: "市场规模约1,200亿元", calibration: { entity: "市场规模", period: "2025", unit: "亿元", value: 1200 } },
              ],
              cost: 0.01,
            };
          if (url === U2)
            return { claims: [{ statement: "市场规模约1200亿元", kind: "fact" as const, quote: "市场规模约1,200亿元", calibration: { entity: "市场规模", period: "2025", unit: "亿元", value: 1200 } }], cost: 0.01 };
          if (url === U3)
            return { claims: [{ statement: "门店口碑热度很高", kind: "fact" as const, quote: "门店口碑热度很高" }], cost: 0.01 };
          return { claims: [{ statement: "年营收999亿元", kind: "fact" as const, quote: "年营收约1,200亿元", calibration: { entity: "年营收", period: "2025", unit: "亿元", value: 999 } }], cost: 0.01 };
        },
        stage: (stage) => cleanStages(stage),
      }),
      createMemoryStore(),
      { plan: { questions: [{ id: "q1", question: "规模与门店", status: "open" }] } },
    );
    expect(run.status).toBe("limited");
    // 语义蕴涵失败:引句不支持转述 → 未验证
    const entailed = bundle!.claims.find((c) => c.statement.includes("行业榜首"))!;
    expect(entailed.kind).toBe("unverified");
    expect(bundle!.limitations.some((l) => l.includes("语义蕴涵未通过"))).toBe(true);
    // 数值复算:口径值与引句数字不一致 → 未验证
    const mismatch = bundle!.claims.find((c) => c.statement.includes("999"))!;
    expect(mismatch.kind).toBe("unverified");
    expect(bundle!.limitations.some((l) => l.includes("数值复算未通过"))).toBe(true);
    // 跨源合并:同口径同数值双源 → 仍为事实,置信度 high
    const merged = bundle!.claims.find((c) => c.statement === "市场规模约1200亿元")!;
    expect(merged.evidenceIds).toHaveLength(2);
    expect(merged.kind).toBe("fact");
    expect(merged.confidence).toBe("high");
    // 仅 C 级单源:不降级类型,置信度 low + 披露
    const weak = bundle!.claims.find((c) => c.statement === "门店口碑热度很高")!;
    expect(weak.kind).toBe("fact");
    expect(weak.confidence).toBe("low");
    expect(bundle!.limitations.some((l) => l.includes("C 级信源"))).toBe(true);
    // 快照携带信源等级
    expect(bundle!.snapshots.find((s) => s.url === U1)?.tier).toBe("B");
    expect(bundle!.snapshots.find((s) => s.url === U3)?.tier).toBe("C");
  });
});
