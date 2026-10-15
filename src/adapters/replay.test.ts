import { describe, expect, it } from "vitest";
import type { Adapters, RecordedCall, Recording } from "./types.js";
import { replayAdapters } from "./replay.js";

const recording: Recording = [
  {
    key: "run-1:gather:search:0",
    kind: "search",
    response: { hits: [{ url: "https://example.com/a", title: "A", snippet: "…" }] },
  },
  {
    key: "run-1:gather:fetch:0",
    kind: "fetch",
    response: {
      page: { url: "https://example.com/a", status: 200, contentType: "text/html", html: "<p>x</p>" },
    },
  },
  {
    key: "run-1:gather:parse:0",
    kind: "parse",
    response: { doc: { bodyText: "正文", parseStatus: "ok" } },
  },
  {
    key: "run-1:gather:model:0",
    kind: "model",
    response: { claims: [{ statement: "s", kind: "fact", quote: "正文" }], usage: { modelCalls: 1, outputTokens: 16 } },
  },
];

describe("replayAdapters", () => {
  it("按调用键回放录制的搜索/抓取/解析/模型响应", async () => {
    const adapters = replayAdapters(recording);
    const search = await adapters.search.search("q", "run-1:gather:search:0");
    expect(search).toEqual([{ url: "https://example.com/a", title: "A", snippet: "…" }]);
    const page = await adapters.page.fetch("https://example.com/a", "run-1:gather:fetch:0");
    expect(page.status).toBe(200);
    const doc = await adapters.parser.parse(page, "run-1:gather:parse:0");
    expect(doc.bodyText).toBe("正文");
    const model = await adapters.model.extractClaims(
      {
        snapshot: {
          id: "s1",
          url: "https://example.com/a",
          title: "A",
          fetchedAt: "2026-09-21T00:00:00.000Z",
          bodyText: "正文",
          parseStatus: "ok",
          contentType: "text/html",
        },
      },
      "run-1:gather:model:0",
    );
    expect(model.claims).toHaveLength(1);
    expect(model.usage.modelCalls).toBe(1);
  });

  it("录制中不存在的调用键直接报错(暴露夹具缺口,不静默编造)", async () => {
    const adapters = replayAdapters(recording);
    await expect(adapters.search.search("q", "run-9:gather:search:0")).rejects.toThrow(
      /run-9:gather:search:0/,
    );
  });
});

describe("replayAdapters 旧录制兼容(PRD D4)", () => {
  const polishKey = "run-1:polish:0";

  it("stalePolishFallback=true:缺失 polish 调用降级为沿用草稿原文", async () => {
    const adapters = replayAdapters(recording, { stalePolishFallback: true });
    const result = await adapters.model.runStage("polish", { draftMd: "# 草稿" }, polishKey);
    expect(result).toEqual({ output: { reportMd: "# 草稿" }, usage: { modelCalls: 0, outputTokens: 0 } });
  });

  it("缺省(严格):缺失 polish 调用仍暴露夹具缺口", async () => {
    const adapters = replayAdapters(recording);
    await expect(adapters.model.runStage("polish", { draftMd: "# 草稿" }, polishKey)).rejects.toThrow(
      /录制夹具缺少调用/,
    );
  });

  it("fallback 只作用于 polish:其他 stage 缺失照常抛错", async () => {
    const adapters = replayAdapters(recording, { stalePolishFallback: true });
    await expect(adapters.model.runStage("draft", {}, "missing-key")).rejects.toThrow(
      /录制夹具缺少调用/,
    );
  });
});

describe("replayAdapters agent 形状(P2-4 R1-3)", () => {
  it("record→replay 全链再生:回合脚本驱动真 executor,快照/主张/调查事件一致", async () => {
    const { runResearch } = await import("../core/runResearch.js");
    const { createMemoryStore } = await import("../stores/memory.js");
    const { ResearchRequestSchema } = await import("../contracts.js");
    const { recordingAdapters } = await import("./recording.js");
    const { scriptedRunAgent } = await import("./testing.js");
    const bodyA = "中国咖啡市场规模约 1,200 亿元(2025 年)。";
    const usage = { modelCalls: 1, outputTokens: 16 };
    const live: Adapters = {
      search: { search: async () => [{ url: "https://a/1", title: "A", snippet: "" }] },
      page: { fetch: async (url) => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }) },
      parser: { parse: async () => ({ bodyText: bodyA, parseStatus: "ok" as const }) },
      model: {
        extractClaims: async () => ({
          claims: [{ statement: "市场规模约 1200 亿元(2025)", kind: "fact" as const, quote: "市场规模约 1,200 亿元" }],
          usage: { ...usage },
        }),
        runStage: async () => ({ output: { findings: [], gaps: [] }, usage: { ...usage } }),
        runAgent: scriptedRunAgent(),
      },
    };
    const request = ResearchRequestSchema.parse({
      id: "req-rep-agent", module: "industry", goal: "回放再生", scope: { summary: "s", queries: [] },
    });
    const options = {
      runId: "run-rep-agent",
      plan: { questions: [{ id: "q1", question: "咖啡 市场规模", status: "open" as const }] },
      stopAfter: "gather" as const,
    };
    // 录制侧:默认调查脚本经 recordingAdapters(agent 工具调用逐轮捕获)
    const calls: RecordedCall[] = [];
    const storeA = createMemoryStore();
    const rec = await runResearch(request, recordingAdapters(live, (c) => calls.push(c)), storeA, options);
    expect(calls.some((c) => c.kind === "agent")).toBe(true);
    const agentCall = calls.find((c) => c.kind === "agent")!.response as {
      turns: Array<{ tool: { name: string } }>;
      result: { status: string; text: string };
    };
    expect(agentCall.turns.map((t) => t.tool.name)).toEqual(["web_search", "fetch_page"]);
    expect(agentCall.result.status).toBe("succeeded");

    // 回放侧:录制脚本驱动真 executor → 快照/主张/调查事件全链再生
    const storeB = createMemoryStore();
    const rep = await runResearch(request, replayAdapters(calls), storeB, options);
    expect(rep.run.status).toBe(rec.run.status);
    // fetchedAt 为各次运行时点,比对时剥离
    const snapShape = (s: { id: string; url: string; title: string; bodyText: string; parseStatus: string }) =>
      `${s.id}|${s.url}|${s.title}|${s.bodyText}|${s.parseStatus}`;
    expect(rep.bundle!.snapshots.map(snapShape)).toEqual(rec.bundle!.snapshots.map(snapShape));
    expect(rep.bundle!.claims.map((c) => c.id)).toEqual(rec.bundle!.claims.map((c) => c.id));
    expect(rep.bundle!.evidence.map((e) => e.id)).toEqual(rec.bundle!.evidence.map((e) => e.id));
    const stripAt = (events: Array<{ seq: number; qid: string; kind: string; sid?: string }>) =>
      events.map((e) => `${e.seq}:${e.qid}:${e.kind}:${e.sid ?? ""}`);
    expect(stripAt(await storeB.readInvestigation("run-rep-agent"))).toEqual(
      stripAt(await storeA.readInvestigation("run-rep-agent")),
    );
  });

  it("agent 录制缺失/任务卡不匹配 → 暴露夹具缺口,不静默编造", async () => {
    const adapters = replayAdapters([
      { key: "k:agent:1", kind: "agent", response: { input: { prompt: "另一张任务卡", taskId: "t", toolExecution: "parallel" }, turns: [], result: { status: "succeeded", text: "x", usage: { modelCalls: 1, outputTokens: 1 } } } },
    ]);
    await expect(
      adapters.model.runAgent!(
        { prompt: "这张任务卡", taskId: "t", toolExecution: "parallel" },
        [],
        "k:agent:1",
      ),
    ).rejects.toThrow(/任务卡不匹配/);
    await expect(
      adapters.model.runAgent!({ prompt: "p", taskId: "t", toolExecution: "parallel" }, [], "missing"),
    ).rejects.toThrow(/录制夹具缺少调用/);
  });
});
