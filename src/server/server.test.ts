import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapters } from "../adapters/types.js";
import { startServer, type RunningServer } from "./server.js";
import { FsProjectStore } from "../stores/fsStore.js";

const A = "https://a/1";
const bodyA = "中国咖啡市场规模约 1,200 亿元(2025 年)。行业边界包括现磨与即饮。产业链上游为咖啡豆贸易。竞争格局集中度提升。";

const fakeAdapters = (slow = false): Adapters => ({
  search: { search: async () => [{ url: A, title: "A", snippet: "" }] },
  page: {
    fetch: async (url) => {
      if (slow) await new Promise((r) => setTimeout(r, 200));
      return { url, status: 200, contentType: "text/html", html: "<p>x</p>" };
    },
  },
  parser: { parse: async () => ({ bodyText: bodyA, parseStatus: "ok" }) },
  model: {
    extractClaims: async () => ({
      claims: [
        {
          statement: "市场规模约 1200 亿元(2025)",
          kind: "fact" as const,
          quote: "市场规模约 1,200 亿元",
          calibration: { entity: "中国咖啡市场", period: "2025", unit: "亿元", value: 1200 },
        },
        { statement: "行业边界包括现磨与即饮", kind: "fact" as const, quote: "行业边界包括现磨与即饮" },
        { statement: "产业链上游为咖啡豆贸易", kind: "fact" as const, quote: "产业链上游为咖啡豆贸易" },
        { statement: "竞争格局集中度提升", kind: "fact" as const, quote: "竞争格局集中度提升" },
      ],
      cost: 0.01,
    }),
    runStage: async (stage) =>
      stage === "plan"
        ? { output: { questions: [{ id: "q1", question: "市场规模" }] }, cost: 0.01 }
        : stage === "outline"
          ? { output: { title: "增量研究报告", sections: [{ id: "s1", title: "市场规模", bullets: [] }] }, cost: 0.01 }
          : stage === "analyze"
            ? { output: { findings: [], gaps: [] }, cost: 0.01 }
            : stage === "draft"
              ? { output: { reportMd: "# 行业研究\n\n## 市场口径表\nx\n## 行业结构\ny\n## 趋势与风险\nz" }, cost: 0.01 }
              : { output: { issues: [], counterexampleChecked: true }, cost: 0.01 },
  },
});

describe("本地 HTTP 服务", () => {
  let srv: RunningServer;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "dr-srv-"));
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters() });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(async () => {
    await srv.close();
  });

  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, json: async () => res.json() as Promise<Record<string, any>>, res };
  };
  const post = (path: string, body: unknown) =>
    api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("仅绑定 127.0.0.1", () => {
    expect(srv.server.address()).toMatchObject({ address: "127.0.0.1" });
  });

  it("创建 → 计划预览 → 运行 → 发布 → 成果包/导出/快照/设置,全流程可走通", async () => {
    const created = await post("/api/projects", {
      module: "industry",
      goal: "中国咖啡行业研究",
      scope: { summary: "s", queries: [] },
    });
    const projectId = (await created.json()).id as string;
    expect(projectId).toMatch(/^p-/);

    const list = await api("/api/projects");
    expect((await list.json()).projects.some((p: { id: string }) => p.id === projectId)).toBe(true);

    const preview = await post(`/api/projects/${projectId}/plan-preview`, {
      module: "industry",
      goal: "中国咖啡行业研究",
      scope: { summary: "s", queries: [] },
    });
    expect((await preview.json()).plan.questions[0].question).toBe("市场规模");

    const runReq = {
      id: "req-srv",
      module: "industry",
      goal: "中国咖啡行业研究",
      scope: { summary: "s", queries: [] },
    };
    const started = await post(`/api/projects/${projectId}/runs`, {
      request: runReq,
      plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }] },
    });
    expect((await started.json()).started).toBe(true);

    let runs: any[] = [];
    for (let i = 0; i < 50; i++) {
      const detail = await api(`/api/projects/${projectId}`);
      runs = (await detail.json()).runs;
      if (runs.some((r) => r.requestId === "req-srv" && r.status !== "running")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const finished = runs.find((r) => r.requestId === "req-srv");
    expect(finished.status).toBe("published");

    const published = await post(`/api/projects/${projectId}/publish`, { runId: finished.id });
    expect((await published.json()).version).toBe(1);

    const bundleRes = await api(`/api/projects/${projectId}/versions/1/bundle`);
    expect((await bundleRes.json()).claims.length).toBe(4);

    const exportRes = await fetch(`${base}/api/projects/${projectId}/versions/1/export`);
    expect(exportRes.headers.get("content-type")).toBe("application/zip");
    const entries = Object.keys(unzipSync(new Uint8Array(await exportRes.arrayBuffer())));
    expect(entries).toContain("report.md");
    expect(entries).toContain("report.html");
    expect(entries).toContain("manifest.json");

    const snap = await fetch(
      `${base}/api/projects/${projectId}/snapshots?sid=${encodeURIComponent(`snap:${A}`)}`,
    );
    expect(snap.headers.get("content-type")).toContain("text/plain");
    expect(await snap.text()).toContain("1,200 亿元");

    const settings = await api("/api/settings");
    const settingsText = JSON.stringify(await settings.json());
    expect(settingsText).not.toMatch(/api[-_]?key|secret|token|password/i);

    const rejected = await post("/api/settings", { modelApiKey: "x" });
    expect(rejected.status).toBe(400);
    const saved = await post("/api/settings", { model: { provider: "minimax-cn", modelId: "MiniMax-M2.7" } });
    expect(saved.status).toBe(200);
  });

  it("阶段失败可见:适配器抛错时 run 落为 failed 并带错误信息(失败不冒充完成)", async () => {
    await srv.close();
    const failing: Adapters = {
      ...fakeAdapters(),
      search: { search: async () => { throw new Error("搜索服务不可用"); } },
    };
    srv = await startServer({ dataDir, makeAdapters: () => failing });
    base = `http://127.0.0.1:${srv.port}`;

    const created = await post("/api/projects", { module: "industry", goal: "失败可见性", scope: { summary: "s", queries: [] } });
    const projectId = (await created.json()).id as string;
    await post(`/api/projects/${projectId}/runs`, { request: { id: "req-fail", module: "industry", goal: "失败可见性", scope: { summary: "s", queries: [] } } });

    let failed: any;
    for (let i = 0; i < 40; i++) {
      const detail = await api(`/api/projects/${projectId}`);
      failed = (await detail.json()).runs.find((r: any) => r.requestId === "req-fail");
      if (failed) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("搜索服务不可用");
  });

  it("重跑:读原请求换档位预算,生成新请求 ID;原运行进行中则拒绝", async () => {
    // 前序用例把服务换成了失败型适配器,这里恢复正常 fake 再测
    await srv.close();
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters() });
    base = `http://127.0.0.1:${srv.port}`;
    const created = await post("/api/projects", {
      module: "industry", goal: "预算档位重跑", scope: { summary: "s", queries: ["市场规模"] },
    });
    const projectId = (await created.json()).id as string;
    const store = FsProjectStore.open(join(dataDir, "projects", projectId));
    await store.saveRequest({
      id: "req-orig", module: "industry", goal: "预算档位重跑",
      scope: { summary: "s", queries: ["市场规模"] }, attachments: [],
      budget: { maxSearches: 8, maxFetches: 12 },
    });
    await store.saveRun({
      id: "run-orig", requestId: "req-orig", stage: "gather", status: "running",
      checkpoints: [], usage: { searches: 0, fetches: 0, costEstimate: 0, wallMs: 0 },
    });

    // 原运行进行中:重跑被拒绝
    const busy = await post(`/api/projects/${projectId}/runs/rerun`, { requestId: "req-orig", budgetTier: "high" });
    expect(busy.status).toBe(409);

    // 原运行结束后重跑:成功启动,新请求落盘带档位、不带旧 budget
    const orig = await store.findRunByRequestId("req-orig");
    await store.saveRun({ ...orig!, status: "published" });
    const rer = await post(`/api/projects/${projectId}/runs/rerun`, { requestId: "req-orig", budgetTier: "high" });
    const rerJson = await rer.json();
    expect(rerJson.started).toBe(true);
    expect(rerJson.requestId).not.toBe("req-orig");

    let rerun: any;
    for (let i = 0; i < 100; i++) {
      const runs = (await (await api(`/api/projects/${projectId}`)).json()).runs;
      rerun = runs.find((r: any) => r.requestId === rerJson.requestId);
      if (rerun && rerun.status !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(["published", "limited"]).toContain(rerun?.status);

    const saved = await store.readRequest(rerJson.requestId);
    expect(saved?.budgetTier).toBe("high");
    expect(saved?.budget).toBeUndefined();
    expect(saved?.scope.queries).toEqual(["市场规模"]);
    expect(saved?.goal).toBe("预算档位重跑");
  });

  it("启动即落运行记录:POST runs 后立即可见(不等待轮询),进程中断也不无痕消失", async () => {
    await srv.close();
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters(true) });
    base = `http://127.0.0.1:${srv.port}`;
    const created = await post("/api/projects", { module: "industry", goal: "可见性", scope: { summary: "s", queries: [] } });
    const projectId = (await created.json()).id as string;
    await post(`/api/projects/${projectId}/runs`, {
      request: { id: "req-visible", module: "industry", goal: "可见性", scope: { summary: "s", queries: [] } },
      plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }] },
    });
    const detail = await api(`/api/projects/${projectId}`);
    const run = (await detail.json()).runs.find((r: any) => r.requestId === "req-visible");
    expect(run?.status).toBe("running");
    await post(`/api/projects/${projectId}/runs/cancel`, { requestId: "req-visible" });
  });

  it("启动清扫:上次服务中断遗留的 running 记录标记为 failed", async () => {
    const created = await post("/api/projects", { module: "industry", goal: "僵尸清扫", scope: { summary: "s", queries: [] } });
    const projectId = (await created.json()).id as string;
    const dir = join(dataDir, "projects", projectId);
    const store = FsProjectStore.open(dir);
    await store.saveRun({
      id: "zombie-run", requestId: "req-zombie", stage: "gather", status: "running",
      checkpoints: [], usage: { searches: 1, fetches: 1, costEstimate: 0, wallMs: 100 },
    });
    await srv.close();
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters() });
    base = `http://127.0.0.1:${srv.port}`;
    const detail = await api(`/api/projects/${projectId}`);
    const run = (await detail.json()).runs.find((r: any) => r.requestId === "req-zombie");
    expect(run?.status).toBe("failed");
    expect(String(run?.error)).toContain("服务中断");
  });

  it("取消与恢复:取消中止运行,恢复自检查点续跑到发布", async () => {
    const created = await post("/api/projects", {
      module: "industry",
      goal: "慢任务",
      scope: { summary: "s", queries: [] },
    });
    const projectId = (await created.json()).id as string;
    await srv.close();
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters(true) });
    base = `http://127.0.0.1:${srv.port}`;

    const runReq = { id: "req-slow", module: "industry", goal: "慢任务", scope: { summary: "s", queries: [] } };
    await post(`/api/projects/${projectId}/runs`, {
      request: runReq,
      plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }, { id: "q2", question: "门店数", status: "open" }] },
    });
    await new Promise((r) => setTimeout(r, 80));
    const cancelled = await post(`/api/projects/${projectId}/runs/cancel`, { requestId: "req-slow" });
    expect(cancelled.status).toBe(200);

    let status = "";
    for (let i = 0; i < 60; i++) {
      const detail = await api(`/api/projects/${projectId}`);
      const run = (await detail.json()).runs.find((r: any) => r.requestId === "req-slow");
      status = run?.status ?? "";
      if (status === "cancelled") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status).toBe("cancelled");

    await post(`/api/projects/${projectId}/runs/resume`, {
      requestId: "req-slow",
      plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }, { id: "q2", question: "门店数", status: "open" }] },
    });
    for (let i = 0; i < 80; i++) {
      const detail = await api(`/api/projects/${projectId}`);
      const run = (await detail.json()).runs.find((r: any) => r.requestId === "req-slow");
      status = run?.status ?? "";
      if (status === "published" || status === "limited") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status).toBe("published");
  }, 20_000);

  it("恢复沿原 runId 不产生第二条记录(不静默全量重跑)", async () => {
    const created = await post("/api/projects", { module: "industry", goal: "恢复单记录", scope: { summary: "s", queries: [] } });
    const projectId = (await created.json()).id as string;
    const runReq = { id: "req-resume-one", module: "industry", goal: "恢复单记录", scope: { summary: "s", queries: [] } };
    await post(`/api/projects/${projectId}/runs`, {
      request: runReq,
      plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }] },
    });
    await new Promise((r) => setTimeout(r, 80));
    await post(`/api/projects/${projectId}/runs/cancel`, { requestId: "req-resume-one" });
    let before: any;
    for (let i = 0; i < 60; i++) {
      const detail = await api(`/api/projects/${projectId}`);
      before = (await detail.json()).runs.find((r: any) => r.requestId === "req-resume-one");
      if (before?.status === "cancelled") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(before?.status).toBe("cancelled");

    const resumed = await post(`/api/projects/${projectId}/runs/resume`, {
      requestId: "req-resume-one",
      plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }] },
    });
    expect(resumed.status).toBe(200);

    let runs: any[] = [];
    for (let i = 0; i < 80; i++) {
      const detail = await api(`/api/projects/${projectId}`);
      runs = (await detail.json()).runs.filter((r: any) => r.requestId === "req-resume-one");
      if (runs.length > 0 && ["published", "limited"].includes(runs[0]?.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(before.id);
  }, 20_000);

describe("增量预览(2.1 追问扩展)", () => {
  it("已完成 run 可作基准:计划/框架预览返回 base 摘要;无 incrementalOf 行为不变", async () => {
    await srv.close();
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters() });
    base = `http://127.0.0.1:${srv.port}`;
    const created = await post("/api/projects", { module: "industry", goal: "增量基准", scope: { summary: "s", queries: [] } });
    const projectId = (await created.json()).id as string;
    await post(`/api/projects/${projectId}/runs`, {
      request: { id: "req-inc-1", module: "industry", goal: "增量基准", scope: { summary: "s", queries: [] } },
      plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }] },
    });
    let baseRun: any;
    for (let i = 0; i < 80; i++) {
      const detail = await api(`/api/projects/${projectId}`);
      baseRun = (await detail.json()).runs.find((r: any) => r.requestId === "req-inc-1");
      if (["published", "limited"].includes(baseRun?.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(["published", "limited"]).toContain(baseRun?.status);

    const planRes = await post(`/api/projects/${projectId}/plan-preview`, {
      goal: "追问近况",
      scope: { summary: "s", queries: [] },
      module: "industry",
      incrementalOf: { runId: baseRun.id, requestId: "req-inc-1" },
    });
    expect(planRes.status).toBe(200);
    const planBody = await planRes.json();
    expect(planBody.base).toMatchObject({
      runId: baseRun.id,
      answeredQuestions: expect.any(Number),
      evidence: expect.any(Number),
      snapshots: expect.any(Number),
      claims: expect.any(Number),
    });
    expect(planBody.base.answeredQuestions).toBeGreaterThanOrEqual(1);
    expect(planBody.base.evidence).toBeGreaterThanOrEqual(1);

    const outlineRes = await post(`/api/projects/${projectId}/outline-preview`, {
      goal: "追问近况",
      scope: { summary: "s", queries: [] },
      questions: ["近一个季度变化"],
      module: "industry",
      incrementalOf: { runId: baseRun.id, requestId: "req-inc-1" },
    });
    expect(outlineRes.status).toBe(200);
    const outlineBody = await outlineRes.json();
    expect(outlineBody.base?.runId).toBe(baseRun.id);
    expect(outlineBody.outline.sections.length).toBeGreaterThanOrEqual(1);

    const plainRes = await post(`/api/projects/${projectId}/plan-preview`, {
      goal: "普通预览", scope: { summary: "s", queries: [] }, module: "industry",
    });
    expect(plainRes.status).toBe(200);
    expect((await plainRes.json()).base).toBeUndefined();
  }, 20_000);

  it("不存在/未完成的基准被拒(4xx)", async () => {
    const created = await post("/api/projects", { module: "industry", goal: "非法基准", scope: { summary: "s", queries: [] } });
    const projectId = (await created.json()).id as string;
    // 不存在
    const missing = await post(`/api/projects/${projectId}/plan-preview`, {
      goal: "g", scope: { summary: "s", queries: [] }, module: "industry",
      incrementalOf: { runId: "run-nope", requestId: "req-nope" },
    });
    expect([400, 404]).toContain(missing.status);
    // 已取消(未完成)的 run 作基准被拒——直接落一条 cancelled 记录(确定性,无时序依赖)
    const dir = join(dataDir, "projects", projectId);
    await FsProjectStore.open(dir).saveRun({
      id: "run-cancelled-base", requestId: "req-cancelled-base", stage: "gather", status: "cancelled",
      checkpoints: [], usage: { searches: 1, fetches: 1, costEstimate: 0, wallMs: 100 },
    });
    const res = await post(`/api/projects/${projectId}/plan-preview`, {
      goal: "g", scope: { summary: "s", queries: [] }, module: "industry",
      incrementalOf: { runId: "run-cancelled-base", requestId: "req-cancelled-base" },
    });
    expect(res.status).toBe(409);
    // 同一校验覆盖运行启动端点:对未完成基准直接发起增量 run 被拒,不产生新 run
    const started = await post(`/api/projects/${projectId}/runs`, {
      request: {
        id: "req-start-bad-base", module: "industry", goal: "非法基准", scope: { summary: "s", queries: [] },
        incrementalOf: { runId: "run-cancelled-base", requestId: "req-cancelled-base" },
      },
      plan: { questions: [{ id: "q1", question: "x", status: "open" }] },
    });
    expect(started.status).toBe(409);
  }, 20_000);

  it("2.1 执行中干预:instruct 入队落盘、间隙消费、干预历史落 run;非 running 409/非法 400", async () => {
    await srv.close();
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters(true) });
    base = `http://127.0.0.1:${srv.port}`;
    const created = await post("/api/projects", { module: "industry", goal: "干预端到端", scope: { summary: "s", queries: [] } });
    const projectId = (await created.json()).id as string;
    const runReq = { id: "req-ins-e2e", module: "industry", goal: "干预端到端", scope: { summary: "s", queries: [] } };
    await post(`/api/projects/${projectId}/runs`, {
      request: runReq,
      plan: {
        questions: [
          { id: "q1", question: "市场规模", status: "open" },
          { id: "q2", question: "门店数量", status: "open" },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 120));
    const skipRes = await post(`/api/projects/${projectId}/runs/instruct`, {
      requestId: "req-ins-e2e",
      instruction: { type: "skip-question", questionId: "q2" },
    });
    expect(skipRes.status).toBe(200);
    expect((await skipRes.json()).queued).toBe(true);
    const addRes = await post(`/api/projects/${projectId}/runs/instruct`, {
      requestId: "req-ins-e2e",
      instruction: { type: "add-questions", questions: ["竞争格局"] },
    });
    expect(addRes.status).toBe(200);
    const badRes = await post(`/api/projects/${projectId}/runs/instruct`, {
      requestId: "req-ins-e2e",
      instruction: { type: "add-questions", questions: [] },
    });
    expect(badRes.status).toBe(400);

    let run: any;
    for (let i = 0; i < 120; i++) {
      const detail = await api(`/api/projects/${projectId}`);
      run = (await detail.json()).runs.find((r: any) => r.requestId === "req-ins-e2e");
      if (["published", "limited"].includes(run?.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(["published", "limited"]).toContain(run?.status);
    expect(run?.interventions).toHaveLength(2);
    expect(run?.interventions?.map((i: any) => i.effect)).toEqual(["applied", "applied"]);
    expect(run?.progress?.skipped).toBe(1);
    // 队列已清空(pending 文件被 drain 重写)
    const store = FsProjectStore.open(join(dataDir, "projects", projectId));
    expect(await store.readPendingInstructions(run.id)).toEqual([]);
    // 已完成的 run 不可再干预
    const after = await post(`/api/projects/${projectId}/runs/instruct`, {
      requestId: "req-ins-e2e",
      instruction: { type: "skip-question" },
    });
    expect(after.status).toBe(409);
  }, 30_000);

  it("2.1 干预落盘跨取消恢复:pending 指令在 resume 后继续被消费", async () => {
    await srv.close();
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters(true) });
    base = `http://127.0.0.1:${srv.port}`;
    const created = await post("/api/projects", { module: "industry", goal: "干预恢复", scope: { summary: "s", queries: [] } });
    const projectId = (await created.json()).id as string;
    await post(`/api/projects/${projectId}/runs`, {
      request: { id: "req-ins-resume", module: "industry", goal: "干预恢复", scope: { summary: "s", queries: [] } },
      plan: {
        questions: [
          { id: "q1", question: "市场规模", status: "open" },
          { id: "q2", question: "门店数量", status: "open" },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 100));
    const insRes = await post(`/api/projects/${projectId}/runs/instruct`, {
      requestId: "req-ins-resume",
      instruction: { type: "add-questions", questions: ["竞争格局"] },
    });
    expect(insRes.status).toBe(200);
    await post(`/api/projects/${projectId}/runs/cancel`, { requestId: "req-ins-resume" });
    let before: any;
    for (let i = 0; i < 60; i++) {
      const detail = await api(`/api/projects/${projectId}`);
      before = (await detail.json()).runs.find((r: any) => r.requestId === "req-ins-resume");
      if (before?.status === "cancelled") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(before?.status).toBe("cancelled");

    await post(`/api/projects/${projectId}/runs/resume`, {
      requestId: "req-ins-resume",
      plan: {
        questions: [
          { id: "q1", question: "市场规模", status: "open" },
          { id: "q2", question: "门店数量", status: "open" },
        ],
      },
    });
    let run: any;
    for (let i = 0; i < 120; i++) {
      const detail = await api(`/api/projects/${projectId}`);
      run = (await detail.json()).runs.find((r: any) => r.requestId === "req-ins-resume");
      if (["published", "limited"].includes(run?.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(["published", "limited"]).toContain(run?.status);
    expect(run?.interventions?.some((i: any) => i.instruction.type === "add-questions" && i.effect === "applied")).toBe(true);
    expect(run?.usage.searches).toBeGreaterThanOrEqual(2);
  }, 30_000);
});
});


describe("settings 配置合并", () => {
  it("POST 只覆盖提及的键:search 链路保留;链式 model 只换链首", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "dr-srv-cfg-"));
    const { writeFileSync, readFileSync } = await import("node:fs");
    writeFileSync(
      join(dataDir, "config.json"),
      JSON.stringify({
        model: [
          { provider: "minimax-cn", modelId: "MiniMax-M3" },
          { provider: "xiaomi-token-plan-cn", modelId: "mimo-v2.5-pro" },
        ],
        search: [{ type: "minimax-mcp" }, { type: "xiaomi-websearch" }],
      }),
    );
    const srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters() });
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: { provider: "minimax-cn", modelId: "MiniMax-M2.7" } }),
      });
      expect(res.status).toBe(200);
      const merged = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")) as Record<string, unknown>;
      // 搜索链必须保留——此前整文件覆盖导致 plan-preview 500 的根因
      expect(merged.search).toEqual([{ type: "minimax-mcp" }, { type: "xiaomi-websearch" }]);
      expect(merged.model).toEqual([
        { provider: "minimax-cn", modelId: "MiniMax-M2.7" },
        { provider: "xiaomi-token-plan-cn", modelId: "mimo-v2.5-pro" },
      ]);
    } finally {
      await srv.close();
    }
  });
});

describe("项目归档", () => {
  it("归档后 status=archived 且仍在列表;恢复回 active;均落审计", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "dr-srv-arch-"));
    const srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters() });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const created = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ module: "brand", goal: "归档测试", scope: { summary: "s", queries: [] } }),
      });
      const { id } = (await created.json()) as { id: string };

      await fetch(`${base}/api/projects/${id}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      let detail = (await (await fetch(`${base}/api/projects/${id}`)).json()) as { meta: { status?: string } };
      expect(detail.meta.status).toBe("archived");

      await fetch(`${base}/api/projects/${id}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      detail = (await (await fetch(`${base}/api/projects/${id}`)).json()) as { meta: { status?: string } };
      expect(detail.meta.status).toBe("active");

      const { readFileSync } = await import("node:fs");
      const audit = readFileSync(join(dataDir, "projects", id, "audit.jsonl"), "utf8");
      expect(audit).toContain('"archived"');
      expect(audit).toContain('"unarchived"');
    } finally {
      await srv.close();
    }
  });
});
