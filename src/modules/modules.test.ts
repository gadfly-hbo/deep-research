import { describe, expect, it } from "vitest";
import type { Adapters, ExtractedClaim } from "../adapters/types.js";
import { ResearchRequestSchema, type ResearchRequest } from "../contracts.js";
import { runResearch } from "../core/runResearch.js";
import type { StageName } from "../core/stages.js";
import { createMemoryStore } from "../stores/memory.js";
import { brandConfig } from "./brand.js";
import { industryConfig } from "./industry.js";
import { getModuleConfig } from "./registry.js";

describe("研究模块配置(四件套完整性)", () => {
  it("品牌模块:定位/价格/渠道/竞品 + 品牌档案/竞品对比表/机会-风险-假设", () => {
    const cfg = getModuleConfig("brand");
    expect(cfg).toBe(brandConfig);
    expect(cfg.schemaVersion).toBe("1.0");
    expect(cfg.questionFramework.map((t) => t.title)).toEqual(["品牌定位", "产品价格", "渠道", "竞品"]);
    expect(cfg.reportTemplate.sections.map((s) => s.title)).toEqual(["品牌档案", "竞品对比表", "机会-风险-假设"]);
    expect(cfg.reportTemplate.sections.every((s) => s.required)).toBe(true);
    expect(cfg.sourceStrategy.validationRules.length).toBeGreaterThan(0);
  });

  it("行业模块:边界/规模口径/产业链/竞争 + 市场口径表/行业结构/趋势与风险", () => {
    const cfg = getModuleConfig("industry");
    expect(cfg).toBe(industryConfig);
    expect(cfg.questionFramework.map((t) => t.title)).toEqual(["行业边界", "规模口径", "产业链", "竞争"]);
    expect(cfg.reportTemplate.sections.map((s) => s.title)).toEqual(["市场口径表", "行业结构", "趋势与风险"]);
  });
});

const A = "https://a/1";
const B = "https://b/2";

function moduleFakes(cfg: {
  bodies: Record<string, string>;
  extracts: Record<string, ExtractedClaim[]>;
  draftMd: string;
}): Adapters {
  return {
    search: { search: async (q) => (q.includes("q1") ? [{ url: A, title: "A", snippet: "" }] : [{ url: B, title: "B", snippet: "" }]) },
    page: { fetch: async (url) => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }) },
    parser: { parse: async (page) => ({ bodyText: cfg.bodies[page.url] ?? "", parseStatus: "ok" }) },
    model: {
      extractClaims: async ({ snapshot }) => ({ claims: cfg.extracts[snapshot.url] ?? [], cost: 0.01 }),
      runStage: async (stage: StageName) =>
        stage === "analyze"
          ? { output: { findings: [], gaps: [] }, cost: 0.01 }
          : stage === "draft"
            ? { output: { reportMd: cfg.draftMd }, cost: 0.01 }
            : { output: { issues: [], counterexampleChecked: true }, cost: 0.01 },
    },
  };
}

const brandRequest = (): ResearchRequest =>
  ResearchRequestSchema.parse({ id: "req-brand", module: "brand", goal: "某消费电子品牌研究", scope: { summary: "中国市场 2025", queries: [] } });
const industryRequest = (): ResearchRequest =>
  ResearchRequestSchema.parse({ id: "req-ind", module: "industry", goal: "中国咖啡零售行业研究", scope: { summary: "中国大陆 2025", queries: [] } });
const plan = {
  questions: [
    { id: "q1", question: "q1 定位 价格 / 边界 规模口径", status: "open" as const },
    { id: "q2", question: "q2 渠道 竞品 / 产业链 竞争", status: "open" as const },
  ],
};

const brandBodyA = "品牌定位高端市场。主力产品价格 299 元。";
const brandBodyB = "线上渠道占比高。竞品 X 定价更低。";
const brandExtracts: Record<string, ExtractedClaim[]> = {
  [A]: [
    { statement: "品牌定位高端市场", kind: "fact", quote: "品牌定位高端市场" },
    { statement: "主力产品价格 299 元", kind: "fact", quote: "价格 299 元", calibration: { entity: "主力产品价格", period: "2025", unit: "元", value: 299 } },
  ],
  [B]: [
    { statement: "线上渠道占比高", kind: "fact", quote: "线上渠道占比高" },
    { statement: "竞品 X 定价更低", kind: "fact", quote: "竞品 X 定价更低" },
  ],
};

describe("品牌模块(模板字段与专项质量检查)", () => {
  it("章节齐全、主题覆盖、数值带口径 → 正常交付", async () => {
    const { run, bundle } = await runResearch(
      brandRequest(),
      moduleFakes({
        bodies: { [A]: brandBodyA, [B]: brandBodyB },
        extracts: brandExtracts,
        draftMd: "# 品牌研究报告\n\n## 品牌档案\n定位高端。\n\n## 竞品对比表\n对比。\n\n## 机会-风险-假设\n机会。",
      }),
      createMemoryStore(),
      { plan },
    );
    expect(run.status).toBe("published");
    expect(bundle!.reportMd).toContain("## 竞品对比表");
  });

  it("缺必备章节(竞品对比表)→ 有限交付并披露", async () => {
    const { run, bundle } = await runResearch(
      brandRequest(),
      moduleFakes({
        bodies: { [A]: brandBodyA, [B]: brandBodyB },
        extracts: brandExtracts,
        draftMd: "# 品牌研究报告\n\n## 品牌档案\n定位高端。\n\n## 机会-风险-假设\n机会。",
      }),
      createMemoryStore(),
      { plan },
    );
    expect(run.status).toBe("limited");
    expect(bundle!.limitations.some((l) => l.includes("竞品对比表"))).toBe(true);
  });
});

describe("行业模块(模板字段与专项质量检查)", () => {
  const indBodyA = "行业边界包括现磨与即饮。市场规模口径约 1,200 亿元(2025 年)。";
  const indBodyB = "产业链上游为咖啡豆贸易。竞争格局集中度提升。";
  const indExtracts: Record<string, ExtractedClaim[]> = {
    [A]: [
      { statement: "行业边界包括现磨与即饮", kind: "fact", quote: "行业边界包括现磨与即饮" },
      { statement: "市场规模口径约 1200 亿元(2025)", kind: "fact", quote: "规模口径约 1,200 亿元", calibration: { entity: "中国咖啡市场", period: "2025", unit: "亿元", value: 1200 } },
    ],
    [B]: [
      { statement: "产业链上游为咖啡豆贸易", kind: "fact", quote: "产业链上游为咖啡豆贸易" },
      { statement: "竞争格局集中度提升", kind: "fact", quote: "竞争格局集中度提升" },
    ],
  };

  it("市场口径表/行业结构/趋势与风险齐全 → 正常交付", async () => {
    const { run, bundle } = await runResearch(
      industryRequest(),
      moduleFakes({
        bodies: { [A]: indBodyA, [B]: indBodyB },
        extracts: indExtracts,
        draftMd: "# 行业研究报告\n\n## 市场口径表\n口径。\n\n## 行业结构\n结构。\n\n## 趋势与风险\n趋势。",
      }),
      createMemoryStore(),
      { plan },
    );
    expect(run.status).toBe("published");
    expect(bundle!.reportMd).toContain("## 市场口径表");
  });

  it("数值主张缺口径 → 专项规则违规,有限交付", async () => {
    const { run, bundle } = await runResearch(
      industryRequest(),
      moduleFakes({
        bodies: { [A]: indBodyA, [B]: indBodyB },
        extracts: {
          ...indExtracts,
          [A]: [
            { statement: "行业边界包括现磨与即饮", kind: "fact", quote: "行业边界包括现磨与即饮" },
            { statement: "市场规模口径约 1200 亿元(2025)", kind: "fact", quote: "规模口径约 1,200 亿元" },
          ],
        },
        draftMd: "# 行业研究报告\n\n## 市场口径表\n口径。\n\n## 行业结构\n结构。\n\n## 趋势与风险\n趋势。",
      }),
      createMemoryStore(),
      { plan },
    );
    expect(run.status).toBe("limited");
    expect(bundle!.limitations.some((l) => l.includes("numeric-claims-calibrated"))).toBe(true);
  });
});
