import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapters } from "../adapters/types.js";
import { FsProjectStore } from "../stores/fsStore.js";
import { startServer, type RunningServer } from "./server.js";

/**
 * P2-3 T2 确认门端点:免 plan 启动→plan 门→confirm(编辑)→outline 门→confirm→完成;
 * GET/confirm/cancel 的 200-404-400-409;confirm×cancel 并发恰一胜;同项目 active-run 守卫;
 * outline 编辑版 cancel→resume 存活(R1-2 钉子)。
 */

const bodyA = "中国咖啡市场规模约 1,200 亿元(2025 年)。";

/** 测试内可调的延时开关:让 confirm 后的重启停在 running 窗口,竞态/cancel 场景确定化。 */
const timing = { outlineDelayMs: 0, fetchDelayMs: 0 };

const fakeAdapters = (searchQueries: string[]): Adapters => ({
  search: {
    search: async (q) => {
      searchQueries.push(q);
      return [{ url: "https://a/1", title: "A", snippet: "" }];
    },
  },
  page: {
    fetch: async (url) => {
      if (timing.fetchDelayMs > 0) await new Promise((r) => setTimeout(r, timing.fetchDelayMs));
      return { url, status: 200, contentType: "text/html", html: "<p>x</p>" };
    },
  },
  parser: { parse: async () => ({ bodyText: bodyA, parseStatus: "ok" }) },
  model: {
    extractClaims: async () => ({
      claims: [{ statement: "市场规模约 1200 亿元(2025)", kind: "fact" as const, quote: "市场规模约 1,200 亿元" }],
      usage: { modelCalls: 1, outputTokens: 16 },
    }),
    runStage: async (stage) => {
      if (stage === "outline" && timing.outlineDelayMs > 0) {
        await new Promise((r) => setTimeout(r, timing.outlineDelayMs));
      }
      return stage === "plan"
        ? { output: { questions: [{ id: "q1", question: "原始问题" }] }, usage: { modelCalls: 1, outputTokens: 16 } }
        : stage === "outline"
          ? { output: { title: "原始框架", sections: [{ id: "s1", title: "市场规模", bullets: [] }] }, usage: { modelCalls: 1, outputTokens: 16 } }
          : stage === "analyze"
            ? { output: { findings: [], gaps: [] }, usage: { modelCalls: 1, outputTokens: 16 } }
            : stage === "draft"
              ? { output: { reportMd: "# 行业研究\n\n## 市场规模\nx" }, usage: { modelCalls: 1, outputTokens: 16 } }
              : { output: { issues: [], counterexampleChecked: true }, usage: { modelCalls: 1, outputTokens: 16 } };
    },
  },
});

describe("确认门端点(P2-3 T2)", () => {
  let srv: RunningServer;
  let base: string;
  let dataDir: string;
  const searchQueries: string[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "dr-gate-"));
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters(searchQueries) });
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
  const createProject = async (goal: string): Promise<string> => {
    const created = await post("/api/projects", { module: "industry", goal, scope: { summary: "s", queries: [] } });
    return (await created.json()).id as string;
  };
  const waitRun = async (projectId: string, pred: (r: Record<string, any>) => boolean, what: string) => {
    for (let i = 0; i < 120; i++) {
      const detail = await get(`/api/projects/${projectId}`);
      const run = ((await detail.json()).runs ?? []).find((r: any) => r.requestId === "req-gate-e2e");
      if (run && pred(run)) return run;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`等待 run ${what} 超时`);
  };

  it("门流端到端:免 plan 启动→plan 门 GET→confirm(编辑)→outline 门→confirm→完成,编辑版生效", async () => {
    const projectId = await createProject("门流端到端");
    // 免 plan 启动:server 传 gates,plan 产出后落门返回
    const started = await post(`/api/projects/${projectId}/runs`, {
      request: { id: "req-gate-e2e", module: "industry", goal: "门流端到端", scope: { summary: "s", queries: [] } },
    });
    expect(started.status).toBe(200);
    expect((await started.json()).started).toBe(true);

    const planGated = await waitRun(projectId, (r) => r.status === "awaiting-confirmation", "plan 门");
    expect(planGated.gate).toEqual({ kind: "plan" });
    expect(planGated.stage).toBe("plan"); // R1-1:门落盘时 stage 保持 plan

    // GET 门契约(R1-5):kind/payload/context;非 awaiting 与未知 run → 404
    const gate = await get(`/api/projects/${projectId}/runs/${planGated.id}/gate`);
    expect(gate.status).toBe(200);
    const gateBody = await gate.json();
    expect(gateBody.kind).toBe("plan");
    expect(gateBody.payload.questions[0].question).toBe("原始问题");
    expect(gateBody.context).toMatchObject({ goal: "门流端到端", module: "industry" });
    expect(gateBody.incremental).toBeUndefined(); // 非增量 run 无摘要

    // confirm(编辑一问):400(坏载荷)→ 200(编辑版)
    const bad = await post(`/api/projects/${projectId}/runs/${planGated.id}/gate/confirm`, { payload: { questions: [] } });
    expect(bad.status).toBe(400);
    const confirmed = await post(`/api/projects/${projectId}/runs/${planGated.id}/gate/confirm`, {
      payload: { questions: [{ id: "q1", question: "编辑后问题", status: "open" }] },
    });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()).kind).toBe("plan");

    const outlineGated = await waitRun(projectId, (r) => r.status === "awaiting-confirmation" && r.gate?.kind === "outline", "outline 门");
    const outlineGate = await get(`/api/projects/${projectId}/runs/${outlineGated.id}/gate`);
    expect(outlineGate.status).toBe(200);
    const outlineBody = await outlineGate.json();
    expect(outlineBody.kind).toBe("outline");
    expect(outlineBody.payload.title).toBe("原始框架");

    const outlineConfirmed = await post(`/api/projects/${projectId}/runs/${outlineGated.id}/gate/confirm`, {
      payload: { title: "编辑后框架", sections: [{ id: "s1", title: "市场规模", bullets: [] }] },
    });
    expect(outlineConfirmed.status).toBe(200);

    const finished = await waitRun(projectId, (r) => ["published", "limited"].includes(r.status), "完成");
    expect(finished.gate).toBeUndefined();
    // 编辑版生效:采证问题=编辑后问题;草稿框架经 request.outline 进 bundle
    expect(searchQueries).toContain("编辑后问题");
    const store = FsProjectStore.open(join(dataDir, "projects", projectId));
    const bundle = await store.readBundle(finished.id);
    expect(bundle?.outline).toMatchObject({ title: "编辑后框架" });
    // 完成后:GET 门 404(非 awaiting)、confirm 404(无门身份)、同项目再启动被守卫 409
    expect((await get(`/api/projects/${projectId}/runs/${finished.id}/gate`)).status).toBe(404);
    const reconfirm = await post(`/api/projects/${projectId}/runs/${finished.id}/gate/confirm`, {
      payload: { questions: [{ id: "q1", question: "x", status: "open" }] },
    });
    expect(reconfirm.status).toBe(404);
  }, 30_000);

  it("守卫:同项目 running|awaiting 下 POST /runs 与 rerun 均 409;未知门端点 404/409", async () => {
    const projectId = await createProject("守卫");
    await post(`/api/projects/${projectId}/runs`, {
      request: { id: "req-g-guard", module: "industry", goal: "守卫", scope: { summary: "s", queries: [] } },
    });
    const gated = await (async () => {
      for (let i = 0; i < 120; i++) {
        const detail = await get(`/api/projects/${projectId}`);
        const run = ((await detail.json()).runs ?? []).find((r: any) => r.requestId === "req-g-guard");
        if (run?.status === "awaiting-confirmation") return run;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("等待守卫用例门超时");
    })();

    // awaiting 下:新启动与 rerun 都被服务端拒绝(含直落 cancelled 基准的 rerun 404 分支不触发)
    const second = await post(`/api/projects/${projectId}/runs`, {
      request: { id: "req-g-2", module: "industry", goal: "守卫", scope: { summary: "s", queries: [] } },
    });
    expect(second.status).toBe(409);
    // rerun 需要原始请求存在:awaiting 的 run 有落盘请求,但项目级守卫先于重跑启动
    const rerun = await post(`/api/projects/${projectId}/runs/rerun`, { requestId: "req-g-guard" });
    expect(rerun.status).toBe(409);

    // 未知 runId:GET/confirm/cancel 404
    expect((await get(`/api/projects/${projectId}/runs/run-nope/gate`)).status).toBe(404);
    expect((await post(`/api/projects/${projectId}/runs/run-nope/gate/confirm`, { payload: {} })).status).toBe(404);
    expect((await post(`/api/projects/${projectId}/runs/run-nope/gate/cancel`, {})).status).toBe(404);

    // 清场:gate/cancel → cancelled(既有语义,可再 resume);对 cancelled 再 confirm → 409
    const cancelled = await post(`/api/projects/${projectId}/runs/${gated.id}/gate/cancel`, {});
    expect(cancelled.status).toBe(200);
    const afterCancel = await post(`/api/projects/${projectId}/runs/${gated.id}/gate/cancel`, {});
    expect(afterCancel.status).toBe(409); // 已非 awaiting,条件写拒绝
    const confirmCancelled = await post(`/api/projects/${projectId}/runs/${gated.id}/gate/confirm`, {
      payload: { questions: [{ id: "q1", question: "x", status: "open" }] },
    });
    expect(confirmCancelled.status).toBe(409);
  }, 20_000);

  it("confirm×cancel 并发恰一胜:同一道门上一个 200 一个 409,终态二选一", async () => {
    const projectId = await createProject("并发");
    await post(`/api/projects/${projectId}/runs`, {
      request: { id: "req-g-race", module: "industry", goal: "并发", scope: { summary: "s", queries: [] } },
    });
    let gated: any;
    for (let i = 0; i < 120; i++) {
      const detail = await get(`/api/projects/${projectId}`);
      gated = ((await detail.json()).runs ?? []).find((r: any) => r.requestId === "req-g-race");
      if (gated?.status === "awaiting-confirmation") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(gated?.status).toBe("awaiting-confirmation");

    // outline 阶段拖慢:confirm 胜者重启后停在 running 窗口,迟到的 cancel 必见 running;
    // 反之 cancel 先入锁则 confirm 必见 cancelled——两种交错都恰一胜
    timing.outlineDelayMs = 400;
    try {
      const confirmP = post(`/api/projects/${projectId}/runs/${gated.id}/gate/confirm`, {
        payload: { questions: [{ id: "q1", question: "并发问题", status: "open" }] },
      });
      const cancelP = post(`/api/projects/${projectId}/runs/${gated.id}/gate/cancel`, {});
      const [confirmRes, cancelRes] = await Promise.all([confirmP, cancelP]);
      expect([confirmRes.status, cancelRes.status].sort((a, b) => a - b)).toEqual([200, 409]);

      let final: any;
      for (let i = 0; i < 160; i++) {
        const detail = await get(`/api/projects/${projectId}`);
        final = ((await detail.json()).runs ?? []).find((r: any) => r.requestId === "req-g-race");
        if (final && ["cancelled", "awaiting-confirmation", "published", "limited"].includes(final.status)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (confirmRes.status === 200) {
        expect(final.status).toBe("awaiting-confirmation"); // confirm 胜→400ms 后停在 outline 门
        expect(final.gate?.kind).toBe("outline");
      } else {
        expect(final.status).toBe("cancelled"); // cancel 胜→终态 cancelled(可再 resume)
      }
    } finally {
      timing.outlineDelayMs = 0;
    }
  }, 20_000);

  it("R1-2 钉子:outline 确认→cancel→resume,draft 用编辑版框架", async () => {
    const projectId = await createProject("outline 编辑存活");
    const reqId = "req-g-r12";
    await post(`/api/projects/${projectId}/runs`, {
      request: { id: reqId, module: "industry", goal: "outline 编辑存活", scope: { summary: "s", queries: [] } },
    });
    const waitStatus = async (pred: (r: any) => boolean, what: string) => {
      for (let i = 0; i < 120; i++) {
        const detail = await get(`/api/projects/${projectId}`);
        const run = ((await detail.json()).runs ?? []).find((r: any) => r.requestId === reqId);
        if (run && pred(run)) return run;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`等待 ${what} 超时`);
    };
    await waitStatus((r) => r.status === "awaiting-confirmation" && r.gate?.kind === "plan", "plan 门");
    const store = FsProjectStore.open(join(dataDir, "projects", projectId));
    // 两道门都确认(outline 用编辑版)
    const runs1 = await store.listRuns();
    const planRun = runs1.find((r) => r.requestId === reqId)!;
    await post(`/api/projects/${projectId}/runs/${planRun.id}/gate/confirm`, {
      payload: { questions: [{ id: "q1", question: "市场规模", status: "open" }] },
    });
    const outlineRun = await waitStatus((r) => r.status === "awaiting-confirmation" && r.gate?.kind === "outline", "outline 门");
    const editedOutline = { title: "存活框架", sections: [{ id: "s1", title: "市场规模", bullets: [] }] };
    // 慢速抓取先就位:confirm 后的重启从第一抓起就停在 gather,取消可命中运行中的管线
    timing.fetchDelayMs = 200;
    const confirmed = await post(`/api/projects/${projectId}/runs/${outlineRun.id}/gate/confirm`, { payload: editedOutline });
    expect(confirmed.status).toBe(200);

    await new Promise((r) => setTimeout(r, 80));
    await post(`/api/projects/${projectId}/runs/cancel`, { requestId: reqId });
    await waitStatus((r) => r.status === "cancelled", "取消");
    timing.fetchDelayMs = 0;

    const resumed = await post(`/api/projects/${projectId}/runs/resume`, { requestId: reqId });
    expect(resumed.status).toBe(200);

    const done = await waitStatus((r) => ["published", "limited"].includes(r.status), "恢复完成");
    const bundle = await store.readBundle(done.id);
    expect(bundle?.outline).toMatchObject({ title: "存活框架" }); // 恢复权威源=request 文件
    expect(done.id).toBe(outlineRun.id); // 全程沿用原 runId
  }, 30_000);
});
