import { describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { scriptedRunAgent } from "../adapters/testing.js";
import { ResearchRequestSchema, type ResearchRequest } from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import type { MemoryStore } from "../stores/memory.js";
import { runResearch } from "./runResearch.js";
import type { StageName } from "./stages.js";

/**
 * P2-4 T2:编排器 gather agent 化——runAgent 逐问调查、executor error-as-value、
 * 共享快照双问归属展开(C4 对拍)、调查事件侧车、verdict 后验。
 */

const bodies: Record<string, string> = {
  "https://a/1": "中国咖啡市场规模约 1,200 亿元(2025 年)。",
  "https://b/2": "现磨咖啡门店数持续增长。",
};
const USAGE = { modelCalls: 1, outputTokens: 16 };

interface LogRow { name: string; result: unknown }

const fakes = (
  scripts: Parameters<typeof scriptedRunAgent>[0],
  log: LogRow[] = [],
  prompts: string[] = [],
  opts: { hits?: Array<{ url: string; title: string; snippet: string }> } = {},
): Adapters => ({
  search: {
    search: async () =>
      opts.hits ?? [
        { url: "https://a/1", title: "A", snippet: "" },
        { url: "https://b/2", title: "B", snippet: "" },
      ],
  },
  page: {
    fetch: async (url): Promise<FetchedPage> => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }),
  },
  parser: { parse: async (page) => ({ bodyText: bodies[page.url] ?? "", parseStatus: "ok" as const }) },
  model: {
    extractClaims: async ({ snapshot }) => ({
      claims: [
        {
          statement: `${snapshot.url} 的主张`,
          kind: "fact" as const,
          quote: (bodies[snapshot.url] ?? "正文").slice(0, 8),
        },
      ],
      usage: { ...USAGE },
    }),
    runStage: async (stage: StageName) =>
      stage === "analyze"
        ? { output: { findings: [], gaps: [] }, usage: { ...USAGE } }
        : stage === "draft" || stage === "polish"
          ? { output: { reportMd: "# 报告\n\n## 市场口径表\nx" }, usage: { ...USAGE } }
          : { output: { issues: [], counterexampleChecked: true }, usage: { ...USAGE } },
    runAgent: scriptedRunAgent(scripts, { log, onPrompt: (p) => prompts.push(p) }),
  },
});

const mkRequest = (over: Partial<ResearchRequest> = {}): ResearchRequest =>
  ResearchRequestSchema.parse({ id: "req-agent", module: "industry", goal: "咖啡行业", scope: { summary: "s", queries: [] }, ...over });

const SUFFICIENT = '{"sufficient":true,"note":"已取得口径"}';

describe("gather agent 化(P2-4 T2)", () => {
  it("C4 对拍:同 URL 双问各自 attach——主张键按 qid 展开,investigation 记录 qid→sid 映射", async () => {
    const store = createMemoryStore();
    const log: LogRow[] = [];
    const prompts: string[] = [];
    const adapters = fakes(
      [
        {
          match: "市场规模",
          turns: [
            { tool: { name: "web_search", args: { query: "市场规模" } } },
            { tool: { name: "fetch_page", args: { url: "https://a/1" } } },
            { text: SUFFICIENT },
          ],
        },
        {
          match: "门店数量",
          turns: [
            { tool: { name: "fetch_page", args: { url: "https://a/1" } } }, // 共享快照:q2 抓同一 URL
            { text: SUFFICIENT },
          ],
        },
      ],
      log,
      prompts,
    );
    const { run, bundle } = await runResearch(mkRequest(), adapters, store, {
      runId: "run-agent",
      plan: {
        questions: [
          { id: "q1", question: "市场规模", status: "open" },
          { id: "q2", question: "门店数量", status: "open" },
        ],
      },
      stopAfter: "gather",
    });
    // 双问主张键各自展开(共享快照不丢另一问同源主张)
    expect(bundle!.claims.map((c) => c.id).sort()).toEqual(["cl:q1:snap:https://a/1:0", "cl:q2:snap:https://a/1:0"]);
    expect(bundle!.evidence.map((e) => e.id).sort()).toEqual(["ev:q1:snap:https://a/1:0", "ev:q2:snap:https://a/1:0"]);
    expect(bundle!.snapshots).toHaveLength(1); // 同 id 快照去重
    // investigation 侧车:两问的 fetch 事件都指向同一 sid
    const events = await store.readInvestigation("run-agent");
    expect(events.filter((e) => e.kind === "fetch")).toHaveLength(2);
    const fetchQids = new Set(events.filter((e) => e.kind === "fetch").map((e) => e.qid));
    expect(fetchQids).toEqual(new Set(["q1", "q2"]));
    // 任务卡六段+证据规则段(修复后七段)(R1-5)
    expect(prompts[0]).toContain("【研究问题】市场规模");
    expect(prompts[0]).toContain("【研究目标与范围】");
    expect(prompts[0]).toContain("【已答问题】");
    expect(prompts[0]).toContain("【已有快照(勿重抓)】");
    expect(prompts[0]).toContain("【预算余量】");
    expect(prompts[0]).toContain("【输出契约】");
  });

  it("配额=1 error-as-value:超配抓取返回错误值,模型收束、run 不死(fetches 恰 1)", async () => {
    const store = createMemoryStore();
    const log: LogRow[] = [];
    const adapters = fakes(
      [
        {
          match: "市场规模",
          turns: [
            { tool: { name: "web_search", args: { query: "x" } } },
            { tool: { name: "fetch_page", args: { url: "https://a/1" } } },
            { tool: { name: "fetch_page", args: { url: "https://b/2" } } }, // 超顶:应得错误值而非抛错
            { text: SUFFICIENT },
          ],
        },
      ],
      log,
    );
    const { run, bundle } = await runResearch(mkRequest({ budget: { maxFetches: 1 } }), adapters, store, {
      runId: "run-agent",
      plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }] },
      stopAfter: "gather",
    });
    expect(run.usage.fetches).toBe(1);
    expect(bundle!.snapshots).toHaveLength(1);
    const overQuota = log.find((r) => r.name === "fetch_page" && (r.result as { error?: string }).error);
    expect((overQuota?.result as { error?: string; note?: string }).error).toBe("question-quota-exhausted");
    // capped → 有限交付;问不死(非 failed)
    expect(run.status).toBe("limited");
    expect(run.error).toBeUndefined();
  });

  it("assertPublicUrl 私网拒绝(C3):executor 返回错误值,不落快照、问存活", async () => {
    const store = createMemoryStore();
    const log: LogRow[] = [];
    const adapters = fakes(
      [
        {
          match: "市场规模",
          turns: [
            { tool: { name: "fetch_page", args: { url: "http://192.168.1.1/inner" } } },
            { text: SUFFICIENT },
          ],
        },
      ],
      log,
    );
    const { run, bundle } = await runResearch(mkRequest(), adapters, store, {
      runId: "run-agent",
      plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }] },
      stopAfter: "gather",
    });
    const rejected = log.find((r) => r.name === "fetch_page");
    expect((rejected?.result as { error?: string }).error).toBe("url-rejected");
    expect(bundle!.snapshots).toHaveLength(0);
    expect(run.usage.fetches).toBe(0);
    expect(run.status).toBe("published"); // 未触 capped 的 stopAfter 直交付;问 unanswered 但 run 收束
  });

  it("共享假件 e2e:默认调查脚本全链(search→fetch→snapshot→extract→analyze)", async () => {
    const store: MemoryStore = createMemoryStore();
    const adapters = fakes([], [], [], { hits: [{ url: "https://a/1", title: "A", snippet: "" }] });
    const { run, bundle } = await runResearch(mkRequest(), adapters, store, {
      runId: "run-agent",
      plan: { questions: [{ id: "q1", question: "咖啡 市场规模", status: "open" }] },
    });
    expect(["published", "limited"]).toContain(run.status);
    expect(bundle!.snapshots).toHaveLength(1);
    expect(bundle!.claims.length).toBeGreaterThanOrEqual(1);
    // 调查时间线:query → fetch → verdict(带 sufficient/note)
    const events = await store.readInvestigation("run-agent");
    expect(events.map((e) => e.kind)).toEqual(["query", "fetch", "verdict"]);
    const verdict = events.find((e) => e.kind === "verdict")!;
    expect(verdict.sufficient).toBe(true);
    expect(verdict.qid).toBe("q1");
    expect(run.progress).toMatchObject({ answered: 1, total: 1 });
  });

  it("verdict 后验:终局非 JSON → sufficient=false + limitation;问不死", async () => {
    const store = createMemoryStore();
    const adapters = fakes([
      { match: "市场规模", turns: [{ text: "这不是 JSON 结论" }] },
    ]);
    const { run, bundle } = await runResearch(mkRequest(), adapters, store, {
      runId: "run-agent",
      plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }] },
      stopAfter: "gather",
    });
    expect(run.progress).toMatchObject({ answered: 0, total: 1 });
    expect(bundle!.limitations.join("\n")).toContain("无法解析");
  });

  it("regather 前旧证据清理复现:补采轮后无重复 ev:qid: 证据", async () => {
    const store = createMemoryStore();
    const regatherStage = (stage: StageName) =>
      stage === "review"
        ? {
            output: {
              issues: [
                { severity: "high" as const, kind: "gap" as const, detail: "补采", targetQuestionId: "q1", fix: "regather" as const },
              ],
              counterexampleChecked: true,
            },
            usage: { ...USAGE },
          }
        : stage === "analyze"
          ? { output: { findings: [], gaps: [] }, usage: { ...USAGE } }
          : stage === "draft" || stage === "polish"
            ? { output: { reportMd: "# 报告\n\n## 市场口径表\nx" }, usage: { ...USAGE } }
            : { output: { issues: [], counterexampleChecked: true }, usage: { ...USAGE } };
    const adapters = fakes([], [], [], { hits: [{ url: "https://a/1", title: "A", snippet: "" }] });
    (adapters.model as { runStage: unknown }).runStage = regatherStage;
    const { bundle } = await runResearch(mkRequest(), adapters, store, {
      plan: { questions: [{ id: "q1", question: "咖啡 市场规模", status: "open" }] },
    });
    const evIds = bundle!.evidence.filter((e) => e.id.startsWith("ev:q1:")).map((e) => e.id);
    expect(evIds).toEqual(["ev:q1:snap:https://a/1:0"]); // 两轮采证各一次,清理后无重复
  });
});

describe("REVIEW 收尾钉子(P2-4)", () => {
  it("S2:livePage 抓取超时常量=20s(低于 toolTimeoutMs 30s,消竞速;源常量钉死防回漂)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../adapters/live.ts", import.meta.url), "utf8");
    expect(src).toMatch(/FETCH_TIMEOUT_MS\s*=\s*20_000/);
  });
});
