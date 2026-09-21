import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapters } from "../adapters/types.js";
import { ResearchRequestSchema } from "../contracts.js";
import { createProject, generateFormal, publishBundle, runOnProject, templateRequest } from "./projectService.js";
import type { StageName } from "../core/stages.js";

const tmp = () => mkdtempSync(join(tmpdir(), "dr-svc-"));

const A = "https://a/1";
const bodyA = "中国咖啡市场规模约 1,200 亿元(2025 年)。";

function fakes(extractClaims: { statement: string; quote: string }[]): Adapters {
  return {
    search: { search: async () => [{ url: A, title: "A", snippet: "" }] },
    page: { fetch: async (url) => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }) },
    parser: { parse: async () => ({ bodyText: bodyA, parseStatus: "ok" }) },
    model: {
      extractClaims: async () => ({
        claims: extractClaims.map((c) => ({ statement: c.statement, kind: "fact" as const, quote: c.quote })),
        cost: 0.01,
      }),
      runStage: async (stage: StageName) =>
        stage === "analyze"
          ? { output: { findings: [], gaps: [] }, cost: 0.01 }
          : stage === "draft"
            ? { output: { reportMd: "# 行业研究报告" }, cost: 0.01 }
            : { output: { issues: [], counterexampleChecked: true }, cost: 0.01 },
    },
  };
}

const plan = { questions: [{ id: "q1", question: "市场规模", status: "open" as const }] };

describe("projectService(版本与生命周期)", () => {
  it("发布生成不可变版本;同一 run 二次发布被拒绝", async () => {
    const dir = createProject(tmp(), {
      module: "industry",
      goal: "中国咖啡行业研究",
      scope: { summary: "s", queries: [] },
    });
    const request = ResearchRequestSchema.parse({
      id: "req-a",
      module: "industry",
      goal: "中国咖啡行业研究",
      scope: { summary: "s", queries: [] },
    });
    const { run } = await runOnProject(dir, request, fakes([{ statement: "市场规模约 1200 亿元(2025)", quote: "市场规模约 1,200 亿元" }]), { plan });
    const first = await publishBundle(dir, run.id);
    expect(first.version).toBe(1);
    expect(existsSync(join(dir, "reports", "v1", "bundle.json"))).toBe(true);
    expect(existsSync(join(dir, "reports", "v1", "report.md"))).toBe(true);
    await expect(publishBundle(dir, run.id)).rejects.toThrow(/已发布/);
  });

  it("补证后的新 run 发布为 v2,差异摘要含新增主张,且 v1 不被改动", async () => {
    const dir = createProject(tmp(), {
      module: "industry",
      goal: "中国咖啡行业研究",
      scope: { summary: "s", queries: [] },
    });
    const reqA = ResearchRequestSchema.parse({ id: "req-a", module: "industry", goal: "中国咖啡行业研究", scope: { summary: "s", queries: [] } });
    const first = await runOnProject(dir, reqA, fakes([{ statement: "市场规模约 1200 亿元(2025)", quote: "市场规模约 1,200 亿元" }]), { plan });
    await publishBundle(dir, first.run.id);

    const reqB = ResearchRequestSchema.parse({ id: "req-b", module: "industry", goal: "中国咖啡行业研究", scope: { summary: "s", queries: [] } });
    const second = await runOnProject(dir, reqB, fakes([
      { statement: "市场规模约 1200 亿元(2025)", quote: "市场规模约 1,200 亿元" },
      { statement: "现磨咖啡占比过半", quote: "市场规模约 1,200 亿元" },
    ]), { plan });
    const published = await publishBundle(dir, second.run.id);
    expect(published.version).toBe(2);
    const diff = published.diffSummary as { addedClaims: string[]; removedClaims: string[]; evidenceDelta: number };
    expect(diff.addedClaims).toContain("现磨咖啡占比过半");
    expect(diff.removedClaims).toEqual([]);
    expect(diff.evidenceDelta).toBe(1);
    const v1 = JSON.parse(readFileSync(join(dir, "reports", "v1", "bundle.json"), "utf8")) as { claims: unknown[] };
    expect(v1.claims).toHaveLength(1);
  });

  it("审计包含 published 事件与配置 hash;模板复用保留目标与范围", async () => {
    const dir = createProject(tmp(), {
      module: "industry",
      goal: "中国咖啡行业研究",
      scope: { summary: "s", queries: ["q"] },
    });
    const request = ResearchRequestSchema.parse({ id: "req-a", module: "industry", goal: "中国咖啡行业研究", scope: { summary: "s", queries: [] } });
    const { run } = await runOnProject(dir, request, fakes([{ statement: "市场规模约 1200 亿元(2025)", quote: "市场规模约 1,200 亿元" }]), { plan });
    await publishBundle(dir, run.id);
    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string; data: Record<string, unknown> });
    const published = audit.find((e) => e.event === "published");
    expect(published).toBeDefined();
    expect(typeof published!.data.configHash).toBe("string");
    expect((published!.data.configHash as string).length).toBe(64);

    const template = templateRequest(dir);
    expect(template.module).toBe("industry");
    expect(template.goal).toBe("中国咖啡行业研究");
    expect(template.scope).toEqual({ summary: "s", queries: ["q"] });
    expect(template.id).toBeUndefined();
  });
});

const OUTLINE = {
  title: "中国咖啡行业研究报告",
  subtitle: "规模与结构",
  sections: [{ id: "s1", title: "市场规模", purpose: "规模口径", bullets: ["市场规模"] }],
};

describe("报告框架与正式报告", () => {
  it("request.outline 进入草稿阶段输入,并回填到结果包", async () => {
    const seen: { draftInputs: unknown[] } = { draftInputs: [] };
    const dir = createProject(tmp(), { module: "industry", goal: "中国咖啡行业研究", scope: { summary: "s", queries: [] } });
    const adapters = fakes([{ statement: "市场规模约 1200 亿元(2025)", quote: "市场规模约 1,200 亿元" }]);
    adapters.model = {
      extractClaims: adapters.model.extractClaims,
      runStage: async (stage: StageName, input: unknown) => {
        if (stage === "draft") seen.draftInputs.push(input);
        return stage === "analyze"
          ? { output: { findings: [], gaps: [] }, cost: 0.01 }
          : stage === "draft"
            ? { output: { reportMd: "# 中国咖啡行业研究报告\n\n## 市场规模\n- 约 1200 亿元" }, cost: 0.01 }
            : { output: { issues: [], counterexampleChecked: true }, cost: 0.01 };
      },
    };
    const request = ResearchRequestSchema.parse({
      id: "req-ol",
      module: "industry",
      goal: "中国咖啡行业研究",
      scope: { summary: "s", queries: [] },
      outline: OUTLINE,
    });
    const { bundle } = await runOnProject(dir, request, adapters, { plan });
    expect(seen.draftInputs).toHaveLength(1);
    expect((seen.draftInputs[0] as { outline?: unknown }).outline).toEqual(OUTLINE);
    expect(bundle?.outline).toEqual(OUTLINE);
  });

  it("generateFormal 产出 formal.json/report.html/report.pptx 并记录审计", async () => {
    const dir = createProject(tmp(), { module: "brand", goal: "森马经营研究", scope: { summary: "s", queries: [] } });
    const request = ResearchRequestSchema.parse({ id: "req-f", module: "brand", goal: "森马经营研究", scope: { summary: "s", queries: [] }, outline: OUTLINE });
    const { run } = await runOnProject(dir, request, fakes([{ statement: "市场规模约 1200 亿元(2025)", quote: "市场规模约 1,200 亿元" }]), { plan });
    await publishBundle(dir, run.id);
    const fakeModel: Adapters["model"] = {
      extractClaims: async () => ({ claims: [], cost: 0 }),
      runStage: async () => ({
        output: { executiveSummary: ["咖啡市场持续增长"], sectionHighlights: [{ sectionId: "s1", bullets: ["规模约 1200 亿元"] }] },
        cost: 0.005,
      }),
    };
    const result = await generateFormal(dir, 1, fakeModel);
    expect(result.summarySource).toBe("model");
    const formalDir = join(dir, "reports", "v1", "formal");
    expect(existsSync(join(formalDir, "formal.json"))).toBe(true);
    expect(existsSync(join(formalDir, "report.html"))).toBe(true);
    expect(existsSync(join(formalDir, "report.pptx"))).toBe(true);
    const formal = JSON.parse(readFileSync(join(formalDir, "formal.json"), "utf8")) as { executiveSummary: string[]; sections: unknown[] };
    expect(formal.executiveSummary).toEqual(["咖啡市场持续增长"]);
    expect(formal.sections.length).toBeGreaterThan(0);
    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8");
    expect(audit).toContain('"formal"');
  });

  it("模型不可用时正式报告走确定性兜底,仍完整产出", async () => {
    const dir = createProject(tmp(), { module: "industry", goal: "中国咖啡行业研究", scope: { summary: "s", queries: [] } });
    const request = ResearchRequestSchema.parse({ id: "req-fb", module: "industry", goal: "中国咖啡行业研究", scope: { summary: "s", queries: [] } });
    const { run } = await runOnProject(dir, request, fakes([{ statement: "市场规模约 1200 亿元(2025)", quote: "市场规模约 1,200 亿元" }]), { plan });
    await publishBundle(dir, run.id);
    const brokenModel: Adapters["model"] = {
      extractClaims: async () => ({ claims: [], cost: 0 }),
      runStage: async () => {
        throw new Error("provider down");
      },
    };
    const result = await generateFormal(dir, 1, brokenModel);
    expect(result.summarySource).toBe("fallback");
    expect(existsSync(join(dir, "reports", "v1", "formal", "report.pptx"))).toBe(true);
  });
});
