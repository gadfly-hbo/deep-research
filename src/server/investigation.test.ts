import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapters } from "../adapters/types.js";
import { scriptedRunAgent } from "../adapters/testing.js";
import { FsProjectStore } from "../stores/fsStore.js";
import { startServer, type RunningServer } from "./server.js";

/**
 * P2-4 T3:调查事件端点——since 游标增量(≤500/响应)、空事件 200+空数组(UI 空态依赖)、
 * 404=run 不存在、questions 分组头清单(最新 gather/plan checkpoint)。
 */

const bodyA = "中国咖啡市场规模约 1,200 亿元(2025 年)。";
const USAGE = { modelCalls: 1, outputTokens: 16 };

const fakeAdapters = (): Adapters => ({
  search: { search: async () => [{ url: "https://a/1", title: "A", snippet: "" }] },
  page: { fetch: async (url) => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }) },
  parser: { parse: async () => ({ bodyText: bodyA, parseStatus: "ok" }) },
  model: {
    extractClaims: async () => ({
      claims: [{ statement: "市场规模约 1200 亿元(2025)", kind: "fact" as const, quote: "市场规模约 1,200 亿元" }],
      usage: { ...USAGE },
    }),
    runAgent: scriptedRunAgent(),
    runStage: async (stage) =>
      stage === "plan"
        ? { output: { questions: [{ id: "q1", question: "市场规模" }] }, usage: { ...USAGE } }
        : stage === "outline"
          ? { output: { title: "报告", sections: [{ id: "s1", title: "市场规模", bullets: [] }] }, usage: { ...USAGE } }
          : stage === "analyze"
            ? { output: { findings: [], gaps: [] }, usage: { ...USAGE } }
            : stage === "draft"
              ? { output: { reportMd: "# 报告\n\n## 市场规模\nx" }, usage: { ...USAGE } }
              : { output: { issues: [], counterexampleChecked: true }, usage: { ...USAGE } },
  },
});

describe("调查事件端点(P2-4 T3)", () => {
  let srv: RunningServer;
  let base: string;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "dr-inv-"));
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters() });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(async () => {
    await srv.close();
  });

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: async () => (await res.json()) as Record<string, any> };
  };
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, json: async () => (await res.json()) as Record<string, any> };
  };

  it("门流跑完后:全量事件(query→fetch→verdict)+questions 分组头;since 增量;404;空事件 200", async () => {
    const created = await post("/api/projects", { module: "industry", goal: "调查端点", scope: { summary: "s", queries: [] } });
    const projectId = (await created.json()).id as string;
    await post(`/api/projects/${projectId}/runs`, {
      request: { id: "req-inv", module: "industry", goal: "调查端点", scope: { summary: "s", queries: [] } },
    });
    const findRun = async () => {
      const detail = await get(`/api/projects/${projectId}`);
      return ((await detail.json()).runs as any[]).find((r) => r.requestId === "req-inv");
    };
    // 双门确认(plan checkpoint 随 gates 落盘 → questions 清单可回)
    let run: any;
    for (let i = 0; i < 100; i++) {
      run = await findRun();
      if (run?.status === "awaiting-confirmation") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await post(`/api/projects/${projectId}/runs/${run.id}/gate/confirm`, {
      payload: { questions: [{ id: "q1", question: "市场规模", status: "open" }] },
    });
    for (let i = 0; i < 100; i++) {
      run = await findRun();
      if (run?.status === "awaiting-confirmation" && run.gate?.kind === "outline") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await post(`/api/projects/${projectId}/runs/${run.id}/gate/confirm`, {
      payload: { title: "报告", sections: [{ id: "s1", title: "市场规模", bullets: [] }] },
    });
    for (let i = 0; i < 120; i++) {
      run = await findRun();
      if (run && ["published", "limited"].includes(run.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(["published", "limited"]).toContain(run.status);

    const inv = await get(`/api/projects/${projectId}/runs/${run.id}/investigation`);
    expect(inv.status).toBe(200);
    const body = await inv.json();
    const kinds = body.events.map((e: any) => e.kind);
    expect(kinds).toEqual(["query", "fetch", "verdict"]);
    const fetchEv = body.events[1];
    expect(fetchEv.sid).toBe("snap:https://a/1");
    expect(fetchEv.title).toBe("https://a/1"); // fake parser 无标题,回退 url
    expect(fetchEv.qid).toBe("q1");
    const verdict = body.events[2];
    expect(verdict.sufficient).toBe(true);
    // questions 分组头:gather checkpoint 的最终状态
    expect(body.questions).toEqual([{ id: "q1", question: "市场规模", status: "answered" }]);

    // since 增量:游标取尾 seq
    const lastSeq = body.events[2].seq;
    const delta = await get(`/api/projects/${projectId}/runs/${run.id}/investigation?since=${lastSeq}`);
    expect((await delta.json()).events).toEqual([]);
    const delta2 = await get(`/api/projects/${projectId}/runs/${run.id}/investigation?since=${body.events[0].seq}`);
    expect((await delta2.json()).events.map((e: any) => e.kind)).toEqual(["fetch", "verdict"]);

    // 404:run 不存在
    expect((await get(`/api/projects/${projectId}/runs/run-nope/investigation`)).status).toBe(404);

    // 空事件:无调查的 run → 200 + 空数组(UI 空态依赖)
    const store = FsProjectStore.open(join(dataDir, "projects", projectId));
    await store.saveRun({
      id: "run-empty", requestId: "req-empty", stage: "plan", status: "cancelled",
      checkpoints: [], usage: { searches: 0, fetches: 0, modelCalls: 0, outputTokens: 0, wallMs: 0 },
    });
    const empty = await get(`/api/projects/${projectId}/runs/run-empty/investigation`);
    expect(empty.status).toBe(200);
    const emptyBody = await empty.json();
    expect(emptyBody.events).toEqual([]);
    expect(emptyBody.questions).toEqual([]);
  }, 30_000);

  it("窗口上限:单响应 ≤500 条,since 续拉", async () => {
    const created = await post("/api/projects", { module: "industry", goal: "窗口", scope: { summary: "s", queries: [] } });
    const projectId = (await created.json()).id as string;
    const store = FsProjectStore.open(join(dataDir, "projects", projectId));
    await store.saveRun({
      id: "run-many", requestId: "req-many", stage: "gather", status: "running",
      checkpoints: [], usage: { searches: 0, fetches: 0, modelCalls: 0, outputTokens: 0, wallMs: 0 },
    });
    for (let i = 0; i < 505; i++) {
      await store.appendInvestigation("run-many", { qid: "q1", kind: "read", summary: `读取 ${i}` });
    }
    const page1 = await get(`/api/projects/${projectId}/runs/run-many/investigation`);
    const p1 = await page1.json();
    expect(p1.events).toHaveLength(500);
    expect(p1.events[0].seq).toBe(1);
    const page2 = await get(`/api/projects/${projectId}/runs/run-many/investigation?since=${p1.events[499].seq}`);
    expect((await page2.json()).events.map((e: any) => e.seq)).toEqual([501, 502, 503, 504, 505]);
  }, 20_000);
});
