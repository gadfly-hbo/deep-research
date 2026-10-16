import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { scriptedRunAgent } from "../adapters/testing.js";
import { startServer, type RunningServer } from "./server.js";

/** P2-6 T1:加注端点——200(同对象变异回显)/409(非 running/账本未注册)/400(zod)。 */

const bodyA = "中国咖啡市场规模约 1,200 亿元(2025 年)。";
const USAGE = { modelCalls: 1, outputTokens: 16 };

const fakeAdapters = (fetchDelayMs: number): Adapters => ({
  search: { search: async () => [{ url: "https://a/1", title: "A", snippet: "" }] },
  page: {
    fetch: async (url): Promise<FetchedPage> => {
      if (fetchDelayMs > 0) await new Promise((r) => setTimeout(r, fetchDelayMs));
      return { url, status: 200, contentType: "text/html", html: "<p>x</p>" };
    },
  },
  parser: { parse: async () => ({ bodyText: bodyA, parseStatus: "ok" }) },
  model: {
    extractClaims: async () => ({
      claims: [{ statement: "市场规模约 1200 亿元(2025)", kind: "fact" as const, quote: "市场规模约 1,200 亿元" }],
      usage: { ...USAGE },
    }),
    runAgent: scriptedRunAgent(),
    runStage: async (stage) =>
      stage === "plan"
        ? { output: { questions: [{ id: "q1", question: "市场规模" }, { id: "q2", question: "门店数量" }] }, usage: { ...USAGE } }
        : stage === "outline"
          ? { output: { title: "报告", sections: [{ id: "s1", title: "市场规模", bullets: [] }] }, usage: { ...USAGE } }
          : stage === "analyze"
            ? { output: { findings: [], gaps: [] }, usage: { ...USAGE } }
            : stage === "draft"
              ? { output: { reportMd: "# 报告\n\n## 市场规模\nx" }, usage: { ...USAGE } }
              : { output: { issues: [], counterexampleChecked: true }, usage: { ...USAGE } },
  },
});

describe("运行中加注端点(P2-6 T1)", () => {
  let srv: RunningServer;
  let base: string;

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "dr-topup-"));
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters(300) });
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
    return (await res.json()) as Record<string, any>;
  };

  it("running 中加注 200:同对象变异回显;完成后 409;未知/非法 409/400", async () => {
    const created = await post("/api/projects", { module: "industry", goal: "加注端点", scope: { summary: "s", queries: [] } });
    const projectId = (await created.json()).id as string;
    await post(`/api/projects/${projectId}/runs`, {
      request: {
        id: "req-topup", module: "industry", goal: "加注端点", scope: { summary: "s", queries: [] },
        budget: { maxSearches: 40, maxFetches: 80, maxWallMs: 90 * 60_000, maxParallel: 4 },
      },
      plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }, { id: "q2", question: "门店数量", status: "open" }] },
    });
    // 等待进入 running(带 plan 旧路径直进采证,慢抓取维持 running 窗口)
    let run: any;
    for (let i = 0; i < 100; i++) {
      const detail = await get(`/api/projects/${projectId}`);
      run = ((detail as any).runs ?? []).find((r: any) => r.requestId === "req-topup");
      if (run) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(run?.status).toBe("running");

    // (a) 200:同对象变异,回显累计后的上限(基线 40/80 + 10/20/5min)
    const ok = await post(`/api/projects/${projectId}/runs/${run.id}/budget`, {
      addSearches: 10, addFetches: 20, extendWallMs: 5 * 60_000,
    });
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody.topped).toBe(true);
    expect(okBody.budget).toMatchObject({ maxSearches: 50, maxFetches: 100 });

    // (b) 400:zod——空 body(无一键)/负数/非整数
    expect((await post(`/api/projects/${projectId}/runs/${run.id}/budget`, {})).status).toBe(400);
    expect((await post(`/api/projects/${projectId}/runs/${run.id}/budget`, { addSearches: -5 })).status).toBe(400);
    expect((await post(`/api/projects/${projectId}/runs/${run.id}/budget`, { addSearches: 1.5 })).status).toBe(400);

    // (c) 409:未知 runId
    expect((await post(`/api/projects/${projectId}/runs/run-nope/budget`, { addSearches: 1 })).status).toBe(409);

    // (d) 运行结束后 → 409
    let done: any;
    for (let i = 0; i < 200; i++) {
      const detail = await get(`/api/projects/${projectId}`);
      done = ((detail as any).runs ?? []).find((r: any) => r.requestId === "req-topup");
      if (done && done.status !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(["published", "limited"]).toContain(done.status);
    expect((await post(`/api/projects/${projectId}/runs/${done.id}/budget`, { addSearches: 1 })).status).toBe(409);
  }, 30_000);
});
