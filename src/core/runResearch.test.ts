import { describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { ResearchRequestSchema, type ResearchRequest } from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import { runResearch, type RunOptions } from "./runResearch.js";

const bodies: Record<string, string> = {
  "https://a/1": "中国咖啡市场规模约 1,200 亿元(2025 年)。",
  "https://b/2": "现磨咖啡门店数持续增长。",
};

function fakeAdapters(fetchedUrls: string[] = []): Adapters {
  return {
    search: {
      search: async () => [
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
