/* U1 T2:名称路由——创建/改名/自动后缀/列表 runs 摘要(D1-D6,G1-2/G1-4/G1-5/G1-6)。
   缝:startServer+fetch 集成缝(server.test.ts 先例);种子 run 经 FsProjectStore 直落(避开异步管线时序)。 */
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapters } from "../adapters/types.js";
import { scriptedRunAgent } from "../adapters/testing.js";
import { startServer, type RunningServer } from "./server.js";
import { FsProjectStore } from "../stores/fsStore.js";
import type { ResearchRequest, ResearchRun } from "../contracts.js";

const fakeAdapters = (): Adapters => ({
  search: { search: async () => [{ url: "https://a/1", title: "A", snippet: "" }] },
  page: { fetch: async (url) => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }) },
  parser: { parse: async () => ({ bodyText: "中国咖啡市场规模约 1,200 亿元(2025 年)。", parseStatus: "ok" }) },
  model: {
    extractClaims: async () => ({ claims: [], usage: { modelCalls: 1, outputTokens: 16 } }),
    runStage: async (stage) => ({
      output:
        stage === "analyze" ? { findings: [], gaps: [] }
        : stage === "draft" ? { reportMd: "# r" }
        : stage === "outline" ? { title: "t", sections: [{ id: "s1", title: "S", bullets: [] }] }
        : stage === "plan" ? { questions: [{ id: "q1", question: "市场规模" }] }
        : { issues: [], counterexampleChecked: true },
      usage: { modelCalls: 1, outputTokens: 16 },
    }),
    runAgent: scriptedRunAgent(),
  },
});

const seedRun = (store: FsProjectStore, run: Partial<ResearchRun> & { id: string; requestId: string; status: ResearchRun["status"] }) =>
  store.saveRun({
    stage: "gather", checkpoints: [],
    usage: { searches: 0, fetches: 0, modelCalls: 0, outputTokens: 0, wallMs: 0 },
    ...run,
  } as ResearchRun);

const seedRequest = (store: FsProjectStore, request: Partial<ResearchRequest> & { id: string }) =>
  store.saveRequest({
    module: "industry", goal: "g", scope: { summary: "s", queries: [] }, attachments: [],
    ...request,
  } as ResearchRequest);

describe("U1 T2:项目名称(创建/校验/改名)", () => {
  let srv: RunningServer;
  let base: string;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "dr-u1-np-"));
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters() });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(async () => {
    await srv.close();
  });

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: async () => (await res.json()) as Record<string, any> };
  };
  const patch = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: async () => (await res.json()) as Record<string, any> };
  };
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, json: async () => (await res.json()) as Record<string, any> };
  };
  const mkProject = async (extra: Record<string, unknown> = {}) => {
    const r = await post("/api/projects", { module: "industry", goal: "中国咖啡行业研究", scope: { summary: "s", queries: [] }, ...extra });
    return String((await r.json()).id);
  };

  it("创建带 name → 列表/详情透出;空串=未命名;>60 → 400", async () => {
    const named = await mkProject({ name: "咖啡行业摸底" });
    const detail = await get(`/api/projects/${named}`);
    expect((await detail.json()).meta.name).toBe("咖啡行业摸底");
    const unnamed = await mkProject({ name: "   " });
    expect((await (await get(`/api/projects/${unnamed}`)).json()).meta.name).toBeUndefined();
    const bad = await post("/api/projects", { module: "industry", goal: "g", scope: { summary: "s", queries: [] }, name: "x".repeat(61) });
    expect(bad.status).toBe(400);
  });

  it("PATCH 项目改名:设置/清除(null);>60 → 400;清除后回退字段消失", async () => {
    const id = await mkProject();
    const set = await patch(`/api/projects/${id}`, { name: "改名后的项目" });
    expect(set.status).toBe(200);
    expect((await set.json()).name).toBe("改名后的项目");
    const cleared = await patch(`/api/projects/${id}`, { name: null });
    expect(cleared.status).toBe(200);
    expect((await (await get(`/api/projects/${id}`)).json()).meta.name).toBeUndefined();
    const bad = await patch(`/api/projects/${id}`, { name: "y".repeat(61) });
    expect(bad.status).toBe(400);
  });

  it("任务改名:终态 OK / awaiting OK(spread 保 name)/ running 409 同文案;清除与 400;audit 记 run-renamed", async () => {
    const id = await mkProject();
    const store = FsProjectStore.open(join(dataDir, "projects", id));
    await seedRun(store, { id: "run-fin", requestId: "req-fin", status: "limited" });
    await seedRun(store, { id: "run-await", requestId: "req-await", status: "awaiting-confirmation", gate: { kind: "plan" } });
    await seedRun(store, { id: "run-live", requestId: "req-live", status: "running" });

    const ok = await patch(`/api/projects/${id}/runs/run-fin/name`, { name: "任务甲" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).name).toBe("任务甲");
    const awaiting = await patch(`/api/projects/${id}/runs/run-await/name`, { name: "待确认任务" });
    expect(awaiting.status).toBe(200);
    const live = await patch(`/api/projects/${id}/runs/run-live/name`, { name: "不该成功" });
    expect(live.status).toBe(409);
    expect((await live.json()).error).toContain("运行进行中,处理后方可改名");

    const cleared = await patch(`/api/projects/${id}/runs/run-fin/name`, { name: null });
    expect(cleared.status).toBe(200);
    const runsAfter = (await (await get(`/api/projects/${id}`)).json()).runs as ResearchRun[];
    expect(runsAfter.find((r) => r.id === "run-fin")?.name).toBeUndefined();
    expect(runsAfter.find((r) => r.id === "run-await")?.name).toBe("待确认任务");
    const bad = await patch(`/api/projects/${id}/runs/run-fin/name`, { name: "z".repeat(61) });
    expect(bad.status).toBe(400);
  });

  it("rerun/followup 自动后缀(G1-6):有名继承+后缀;无名回退 requestId 前 8 位", async () => {
    const p1 = await mkProject();
    const s1 = FsProjectStore.open(join(dataDir, "projects", p1));
    await seedRequest(s1, { id: "req-rerun-a", name: "渠道摸底" });
    await seedRun(s1, { id: "run-rerun-a0", requestId: "req-rerun-a", status: "published" });
    const r1 = await post(`/api/projects/${p1}/runs/rerun`, { requestId: "req-rerun-a", budgetTier: "low" });
    expect(r1.status).toBe(200);
    const runs1 = (await (await get(`/api/projects/${p1}`)).json()).runs as ResearchRun[];
    const rerunRun = runs1.find((r) => r.id !== "run-rerun-a0");
    expect(rerunRun?.name).toBe("渠道摸底·重跑");

    const p2 = await mkProject();
    const s2 = FsProjectStore.open(join(dataDir, "projects", p2));
    await seedRequest(s2, { id: "req-rerun-b" });
    await seedRun(s2, { id: "run-rerun-b0", requestId: "req-rerun-b", status: "published" });
    const r2 = await post(`/api/projects/${p2}/runs/rerun`, { requestId: "req-rerun-b", budgetTier: "low" });
    expect(r2.status).toBe(200);
    const runs2 = (await (await get(`/api/projects/${p2}`)).json()).runs as ResearchRun[];
    expect(runs2.find((r) => r.id !== "run-rerun-b0")?.name).toBe("req-rerun-b".slice(0, 8) + "·重跑");

    const p3 = await mkProject();
    const s3 = FsProjectStore.open(join(dataDir, "projects", p3));
    await seedRequest(s3, { id: "req-fu-base" });
    await seedRun(s3, { id: "run-fu-0", requestId: "req-fu-base", status: "limited", name: "基准研究", progress: { answered: 1, open: 0, skipped: 0, total: 1 } });
    await s3.saveCheckpoint({ runId: "run-fu-0", stage: "gather", completedAt: "2026-10-18T00:00:00Z", data: { questions: [{ id: "q1", question: "市场规模", status: "answered" }] } });
    await s3.saveBundle({ runId: "run-fu-0", version: 0, reportMd: "# 基准研究", claims: [], evidence: [], snapshots: [], limitations: [], unresolved: [], verdicts: [] } as never);
    const r3 = await post(`/api/projects/${p3}/runs/followup`, { prompt: "追问渠道" });
    expect(r3.status).toBe(200);
    const runs3 = (await (await get(`/api/projects/${p3}`)).json()).runs as ResearchRun[];
    expect(runs3.find((r) => r.id !== "run-fu-0")?.name).toBe("基准研究·追问");
  }, 30_000);

  it("列表 runs 摘要(D1/G1-2):轻量形状 + mtime 倒序 + 空项目 runs=[]", async () => {
    const p = await mkProject();
    const s = FsProjectStore.open(join(dataDir, "projects", p));
    await seedRun(s, { id: "run-old", requestId: "req-old", status: "limited", name: "旧任务" });
    await seedRun(s, { id: "run-new", requestId: "req-new", status: "running" });
    const now = Date.now() / 1000;
    utimesSync(join(dataDir, "projects", p, "runs", "run-old", "run.json"), new Date(now - 500), new Date(now - 500));
    utimesSync(join(dataDir, "projects", p, "runs", "run-new", "run.json"), new Date(now), new Date(now));
    const empty = await mkProject();
    const list = await (await get("/api/projects")).json();
    const withRuns = (list.projects as Array<Record<string, any>>).find((x) => x.id === p)!;
    expect(Array.isArray(withRuns.runs)).toBe(true);
    expect(withRuns.runs.map((r: Record<string, any>) => r.id)).toEqual(["run-new", "run-old"]);
    const summary = withRuns.runs[1] as Record<string, any>;
    expect(summary).toMatchObject({ id: "run-old", requestId: "req-old", name: "旧任务", status: "limited", stage: "gather" });
    expect(typeof summary.updatedAt).toBe("number");
    expect(summary.checkpoints).toBeUndefined();
    expect(summary.usage).toBeUndefined();
    const emptyProject = (list.projects as Array<Record<string, any>>).find((x) => x.id === empty)!;
    expect(emptyProject.runs).toEqual([]);
  });
});
