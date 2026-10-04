import { describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { ResearchRequestSchema, type ResearchRequest } from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import { runResearch } from "./runResearch.js";

const request: ResearchRequest = ResearchRequestSchema.parse({
  module: "industry",
  goal: "中国咖啡行业规模",
  scope: { summary: "中国大陆 2025", queries: ["咖啡 市场规模"] },
});

/** 全链路假适配器:runStage 记录每次调用的 stage 名与输入。 */
function captureAdapters(captured: Array<{ stage: string; input: unknown }>): Adapters {
  return {
    search: {
      search: async () => [{ url: "https://a/1", title: "A", snippet: "" }],
    },
    page: {
      fetch: async (url): Promise<FetchedPage> => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }),
    },
    parser: {
      parse: async () => ({
        bodyText: "中国咖啡市场规模约 1,200 亿元(2025 年),连续多年保持双位数增长。",
        parseStatus: "ok" as const,
      }),
    },
    model: {
      extractClaims: async () => ({
        claims: [
          {
            statement: "中国咖啡市场规模约 1200 亿元(2025)",
            kind: "fact" as const,
            quote: "市场规模约 1,200 亿元",
          },
        ],
        cost: 0.01,
      }),
      runStage: async (stage, input) => {
        const reviewCount = captured.filter((c) => c.stage === "review").length;
        captured.push({ stage, input });
        if (stage === "analyze") return { output: { findings: [], gaps: [] }, cost: 0.01 };
        if (stage === "draft") return { output: { reportMd: "# 报告\n\n## 市场\nx" }, cost: 0.01 };
        // polish 与 draft 素材注入断言无关,原样回传即可
        if (stage === "polish") {
          const { draftMd } = input as { draftMd: string };
          return { output: { reportMd: draftMd }, cost: 0.01 };
        }
        if (stage === "review") {
          // 首轮给一条 high/rephrase 触发修复回环,次轮放行
          const first = reviewCount === 0;
          return {
            output: first
              ? { issues: [{ severity: "high", kind: "citation", detail: "引用单薄", fix: "rephrase" }], counterexampleChecked: true }
              : { issues: [], counterexampleChecked: true },
            cost: 0.01,
          };
        }
        throw new Error(`未预期的阶段: ${stage}`);
      },
    },
  };
}

const planOnly = { plan: { questions: [{ id: "q1", question: "咖啡 市场规模", status: "open" as const }] } };

describe("draft/rephrase 阶段的 writer 素材注入", () => {
  it("draft 输入含 evidencePacks,excerpt 来自快照正文且含引句", async () => {
    const captured: Array<{ stage: string; input: unknown }> = [];
    await runResearch(request, captureAdapters(captured), createMemoryStore(), planOnly);
    const draftCalls = captured.filter((c) => c.stage === "draft");
    expect(draftCalls.length).toBeGreaterThan(0);
    const input = draftCalls[0].input as { evidencePacks?: Array<{ questionId: string; notes: Array<{ excerpt: string; verbatim: boolean }> }> };
    expect(Array.isArray(input.evidencePacks)).toBe(true);
    const q1Pack = input.evidencePacks!.find((p) => p.questionId === "q1");
    expect(q1Pack).toBeDefined();
    expect(q1Pack!.notes.length).toBeGreaterThan(0);
    expect(q1Pack!.notes[0].verbatim).toBe(true);
    expect(q1Pack!.notes[0].excerpt).toContain("市场规模约 1,200 亿元");
  });

  it("review 回环 rephrase 修复的 draft 调用同样携带 evidencePacks", async () => {
    const captured: Array<{ stage: string; input: unknown }> = [];
    await runResearch(request, captureAdapters(captured), createMemoryStore(), planOnly);
    const draftCalls = captured.filter((c) => c.stage === "draft");
    expect(draftCalls.length).toBeGreaterThanOrEqual(2);
    const second = draftCalls[1].input as { evidencePacks?: unknown };
    expect(Array.isArray(second.evidencePacks)).toBe(true);
  });
});
