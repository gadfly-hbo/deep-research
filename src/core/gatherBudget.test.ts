import { describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { ResearchRequestSchema } from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import { runResearch } from "./runResearch.js";
import type { StageName } from "./stages.js";

describe("gather 抓取预算按问题分配", () => {
  it("多问题时预算不被首个问题独占:每问获得均分配额", async () => {
    const fetched: string[] = [];
    const bodies: Record<string, string> = {};
    const hits = ["https://a/1", "https://b/2", "https://c/3"];
    for (const u of hits) bodies[u] = `正文:${u} 中国咖啡市场规模约 1,200 亿元(2025 年)。`;

    const adapters: Adapters = {
      search: {
        search: async (q) =>
          (q === "市场规模" ? hits : hits.map((h) => h.replace("a/1", "d/4").replace("b/2", "e/5").replace("c/3", "f/6"))).map((url) => ({ url, title: url, snippet: "" })),
      },
      page: {
        fetch: async (url): Promise<FetchedPage> => {
          fetched.push(url);
          return { url, status: 200, contentType: "text/html", html: "<p>x</p>" };
        },
      },
      parser: {
        parse: async (page) => ({ bodyText: bodies[page.url] ?? bodies["https://a/1"], parseStatus: "ok" }),
      },
      model: {
        extractClaims: async () => ({
          claims: [{ statement: "中国咖啡市场规模约 1200 亿元(2025)", kind: "fact" as const, quote: "中国咖啡市场规模约 1,200 亿元" }],
          cost: 0,
        }),
        runStage: async (stage: StageName) =>
          stage === "analyze"
            ? { output: { findings: [], gaps: [] }, cost: 0 }
            : stage === "draft"
              ? { output: { reportMd: "# r\n## 市场口径表\n## 行业结构\n## 趋势与风险" }, cost: 0 }
              : { output: { issues: [], counterexampleChecked: true }, cost: 0 },
      },
    };

    const request = ResearchRequestSchema.parse({
      id: "req-budget",
      module: "industry",
      goal: "中国咖啡行业研究",
      scope: { summary: "s", queries: [] },
      budget: { maxFetches: 4, maxParallel: 4 },
    });
    const { bundle } = await runResearch(request, adapters, createMemoryStore(), {
      plan: {
        questions: [
          { id: "q1", question: "市场规模", status: "open" },
          { id: "q2", question: "产业链", status: "open" },
        ],
      },
    });
    // 4 抓 2 问 → 每问 2,而不是 q1 独占 4、q2 颗粒无收
    expect(fetched.length).toBe(4);
    expect(fetched.filter((u) => u.startsWith("https://a") || u.startsWith("https://b") || u.startsWith("https://c")).length).toBe(2);
    expect(fetched.filter((u) => u.startsWith("https://d") || u.startsWith("https://e") || u.startsWith("https://f")).length).toBe(2);
    expect(bundle!.claims.length).toBeGreaterThanOrEqual(2);
  });
});
