import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapters } from "../adapters/types.js";
import { scriptedRunAgent } from "../adapters/testing.js";
import { startServer, type RunningServer } from "./server.js";
import { FsProjectStore } from "../stores/fsStore.js";

// P1-3 T0:HTTP 表征测试(.flow/prd.md Testing 节 T1–T12)。
// 钉住 server.ts 的**现状**行为(即使现状可议,如畸形 JSON→500、非法 id→500),
// 为路由域拆分 + RunRegistry 抽取重构提供回归安全网;重构批次不得改变这些行为。

const A = "https://a/1";
const bodyA = "中国咖啡市场规模约 1,200 亿元(2025 年)。行业边界包括现磨与即饮。产业链上游为咖啡豆贸易。竞争格局集中度提升。";

// 与 server.test.ts 相同的假适配器(复制而非 import,避免测试文件间耦合)
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
      usage: { modelCalls: 1, outputTokens: 16 },
    }),
    runAgent: scriptedRunAgent(),
    runStage: async (stage) =>
      stage === "plan"
        ? { output: { questions: [{ id: "q1", question: "市场规模" }] }, usage: { modelCalls: 1, outputTokens: 16 } }
        : stage === "outline"
          ? { output: { title: "增量研究报告", sections: [{ id: "s1", title: "市场规模", bullets: [] }] }, usage: { modelCalls: 1, outputTokens: 16 } }
          : stage === "analyze"
            ? { output: { findings: [], gaps: [] }, usage: { modelCalls: 1, outputTokens: 16 } }
            : stage === "draft"
              ? { output: { reportMd: "# 行业研究\n\n## 市场口径表\nx\n## 行业结构\ny\n## 趋势与风险\nz" }, usage: { modelCalls: 1, outputTokens: 16 } }
              : { output: { issues: [], counterexampleChecked: true }, usage: { modelCalls: 1, outputTokens: 16 } },
  },
});

// P2-4:采证三件在 executor 内已 error-as-value(search 抛错不再击杀 run),
// 失败落盘改用 extractClaims 抛错作向量(后置批量提取不被吞,仍触发 runOnProject 拒绝)
const failingAdapters = (message: string): Adapters => ({
  ...fakeAdapters(),
  model: {
    ...fakeAdapters().model,
    extractClaims: async () => {
      throw new Error(message);
    },
  },
});

const PLAN = { questions: [{ id: "q1", question: "市场规模", status: "open" }] };
const PLAN2 = {
  questions: [
    { id: "q1", question: "市场规模", status: "open" },
    { id: "q2", question: "门店数", status: "open" },
  ],
};

interface Ctx {
  srv: RunningServer;
  base: string;
  dataDir: string;
}

const startWith = async (makeAdapters: () => Adapters): Promise<Ctx> => {
  const dataDir = mkdtempSync(join(tmpdir(), "dr-char-"));
  const srv = await startServer({ dataDir, makeAdapters });
  return { srv, dataDir, base: `http://127.0.0.1:${srv.port}` };
};

const http = (base: string) => {
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, json: async () => (await res.json()) as Record<string, any>, res };
  };
  const post = (path: string, body: unknown) =>
    api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { api, post };
};

const createProject = async (base: string, goal: string): Promise<string> => {
  const res = await http(base).post("/api/projects", {
    module: "industry",
    goal,
    scope: { summary: "s", queries: [] },
  });
  return (await res.json()).id as string;
};

// 轮询项目详情直到目标 run 满足条件(参考 server.test.ts 的等待落盘模式)
const waitForRun = async (
  base: string,
  projectId: string,
  requestId: string,
  pred: (run: any) => boolean,
  label: string,
): Promise<any> => {
  for (let i = 0; i < 160; i++) {
    const res = await fetch(`${base}/api/projects/${projectId}`);
    const detail = (await res.json()) as { runs: any[] };
    const run = detail.runs.find((r) => r.requestId === requestId);
    if (run && pred(run)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待 run 状态超时(${label}): ${requestId}`);
};

describe("T1 launch 后流水线失败落盘", () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await startWith(() => failingAdapters("T1 搜索服务不可用"));
  });
  afterAll(async () => {
    await ctx.srv.close();
  });

  it("T1:落全新 failed 记录(stage=gather、checkpoints 空、usage 全零、error 带消息)", async () => {
    const { post } = http(ctx.base);
    const projectId = await createProject(ctx.base, "T1 失败落盘");
    const started = await post(`/api/projects/${projectId}/runs`, {
      request: { id: "req-t1", module: "industry", goal: "T1 失败落盘", scope: { summary: "s", queries: [] } },
      plan: PLAN,
    });
    expect(started.status).toBe(200);

    const run = await waitForRun(ctx.base, projectId, "req-t1", (r) => r.status === "failed", "failed");
    expect(run.requestId).toBe("req-t1");
    expect(run.status).toBe("failed");
    expect(run.stage).toBe("gather");
    expect(run.checkpoints).toEqual([]);
    expect(run.usage).toEqual({ searches: 0, fetches: 0, modelCalls: 0, outputTokens: 0, wallMs: 0 }); // P2-2 契约变更:成本→计量
    expect(run.error).toContain("T1 搜索服务不可用");
  });
});

describe("T2 resume 后流水线失败展开合并", () => {
  let ctx: Ctx;
  // makeAdapters 在每次请求时现取:launch 用慢适配器,resume 前换成失败适配器
  let current: Adapters;
  beforeAll(async () => {
    current = fakeAdapters(true);
    ctx = await startWith(() => current);
  });
  afterAll(async () => {
    await ctx.srv.close();
  });

  it("T2:原记录 status=failed、error 新增、id/requestId 不变、checkpoints 沿用、usage 不归零", async () => {
    const { post } = http(ctx.base);
    const projectId = await createProject(ctx.base, "T2 恢复失败");
    await post(`/api/projects/${projectId}/runs`, {
      request: { id: "req-t2", module: "industry", goal: "T2 恢复失败", scope: { summary: "s", queries: [] } },
      plan: PLAN2,
    });
    // 等 q1 完成落盘(usage.searches>=1)再取消:保证"usage 不归零"断言针对的是真实非零值
    await waitForRun(ctx.base, projectId, "req-t2", (r) => r.usage?.searches >= 1, "searches>=1");
    const cancelled = await post(`/api/projects/${projectId}/runs/cancel`, { requestId: "req-t2" });
    expect(cancelled.status).toBe(200);
    const before = await waitForRun(ctx.base, projectId, "req-t2", (r) => r.status === "cancelled", "cancelled");
    expect(before.error).toBeUndefined();

    current = failingAdapters("T2 恢复后搜索失败");
    const resumed = await post(`/api/projects/${projectId}/runs/resume`, { requestId: "req-t2", plan: PLAN2 });
    expect(resumed.status).toBe(200);
    const resumedBody = await resumed.json();
    expect(resumedBody.resumed).toBe(true);
    expect(resumedBody.runId).toBe(before.id);

    const after = await waitForRun(ctx.base, projectId, "req-t2", (r) => r.status === "failed", "failed");
    expect(after.id).toBe(before.id);
    expect(after.requestId).toBe("req-t2");
    expect(after.status).toBe("failed");
    expect(after.error).toContain("T2 恢复后搜索失败");
    expect(after.checkpoints).toEqual(before.checkpoints);
    expect(after.usage).toEqual(before.usage);
    expect(after.usage.searches).toBeGreaterThanOrEqual(1);
  }, 20_000);
});

describe("T3 formal 端点形状", () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await startWith(() => fakeAdapters());
  });
  afterAll(async () => {
    await ctx.srv.close();
  });

  it("T3:POST formal 200;json=inline;html/pptx=attachment;未生成 404 带文案", async () => {
    const { post, api } = http(ctx.base);
    const projectId = await createProject(ctx.base, "T3 正式报告");
    await post(`/api/projects/${projectId}/runs`, {
      request: { id: "req-t3-a", module: "industry", goal: "T3 正式报告", scope: { summary: "s", queries: [] } },
      plan: PLAN,
    });
    const run1 = await waitForRun(ctx.base, projectId, "req-t3-a", (r) => ["published", "limited"].includes(r.status), "run1");
    const pub1 = await post(`/api/projects/${projectId}/publish`, { runId: run1.id });
    expect(pub1.status).toBe(200);
    expect((await pub1.json()).version).toBe(1);

    const formal = await post(`/api/projects/${projectId}/versions/1/formal`, {});
    expect(formal.status).toBe(200);
    const formalBody = await formal.json();
    expect(formalBody.version).toBe(1);
    expect(formalBody.formats).toEqual(["html", "md", "pptx", "json"]);

    const jsonRes = await fetch(`${ctx.base}/api/projects/${projectId}/versions/1/formal/json`);
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(jsonRes.headers.get("content-disposition")).toBe('inline; filename="research-v1-formal.json"');

    const htmlRes = await fetch(`${ctx.base}/api/projects/${projectId}/versions/1/formal/html`);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(htmlRes.headers.get("content-disposition")).toBe('attachment; filename="research-v1.html"');

    const mdRes = await fetch(`${ctx.base}/api/projects/${projectId}/versions/1/formal/md`);
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(mdRes.headers.get("content-disposition")).toBe('attachment; filename="research-v1.md"');
    expect((await mdRes.text()).startsWith("# ")).toBe(true);

    const pptxRes = await fetch(`${ctx.base}/api/projects/${projectId}/versions/1/formal/pptx`);
    expect(pptxRes.status).toBe(200);
    expect(pptxRes.headers.get("content-disposition")).toBe('attachment; filename="research-v1.pptx"');

    // 第二个 run 发布为 v2,但不 POST formal:产物未生成 → 404 + 提示文案
    await post(`/api/projects/${projectId}/runs`, {
      request: { id: "req-t3-b", module: "industry", goal: "T3 正式报告", scope: { summary: "s", queries: [] } },
      plan: PLAN,
    });
    const run2 = await waitForRun(ctx.base, projectId, "req-t3-b", (r) => ["published", "limited"].includes(r.status), "run2");
    const pub2 = await post(`/api/projects/${projectId}/publish`, { runId: run2.id });
    expect(pub2.status).toBe(200);
    expect((await pub2.json()).version).toBe(2);

    const missing = await api(`/api/projects/${projectId}/versions/2/formal/html`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("正式报告尚未生成: v2(先 POST /versions/2/formal)");
  }, 30_000);
});

describe("T4 静态文件与 SPA 回退", () => {
  let ctx: Ctx;
  beforeAll(async () => {
    // 夹具相对 process.cwd()(仓库根);ui-dist 已 gitignore,不污染工作树;不清理
    const uiDist = join(process.cwd(), "ui-dist");
    mkdirSync(uiDist, { recursive: true });
    // index.html 仅当不存在时写入,不覆盖本机真实构建产物
    const indexPath = join(uiDist, "index.html");
    if (!existsSync(indexPath)) {
      writeFileSync(indexPath, "<!doctype html><html><body>characterization fixture</body></html>\n");
    }
    writeFileSync(join(uiDist, "__char-fixture.js"), "globalThis.__charFixture = 1;\n");
    writeFileSync(join(uiDist, "__char-fixture.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n');
    ctx = await startWith(() => fakeAdapters());
  });
  afterAll(async () => {
    await ctx.srv.close();
  });

  it("T4:存在资源按扩展名 content-type;未知非 api 路径回退 index.html(text/html)", async () => {
    const js = await fetch(`${ctx.base}/__char-fixture.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript");

    const svg = await fetch(`${ctx.base}/__char-fixture.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");

    const fallback = await fetch(`${ctx.base}/__char-nonexistent__`);
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });
});

describe("T5–T11 路由守卫与错误映射", () => {
  let ctx: Ctx;
  beforeAll(async () => {
    ctx = await startWith(() => fakeAdapters());
  });
  afterAll(async () => {
    await ctx.srv.close();
  });

  it("T5:catch-all 未匹配 /api/* → 404 带方法与路径文案", async () => {
    const { api } = http(ctx.base);
    const res = await api("/api/__nope__");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("未找到: GET /api/__nope__");
  });

  it("T6:畸形 JSON body → 500", async () => {
    const res = await fetch(`${ctx.base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });

  it("T7:非法项目 id → 500,且 id 校验先于子路由分发", async () => {
    const { post, api } = http(ctx.base);
    const bad = await post("/api/projects/bad!!/runs", {
      request: { id: "req-t7", module: "industry", goal: "g", scope: { summary: "s", queries: [] } },
      plan: PLAN,
    });
    expect(bad.status).toBe(500);
    expect((await bad.json()).error).toBe("非法项目 id: bad!!");

    // 非法 id + 不存在的子路径仍是 500 而非 404:projectDir 校验先于子路由匹配
    const unknownSub = await api("/api/projects/bad!!/whatever");
    expect(unknownSub.status).toBe(500);
    expect((await unknownSub.json()).error).toBe("非法项目 id: bad!!");
  });

  it("T8:cancel 无运行中 run → 404", async () => {
    const { post } = http(ctx.base);
    const projectId = await createProject(ctx.base, "T8 取消守卫");
    const res = await post(`/api/projects/${projectId}/runs/cancel`, { requestId: "req-nonexistent" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("没有正在运行的 run: req-nonexistent");
  });

  it("T9:resume 请求不存在 → 404;请求存在但无已取消运行 → 409", async () => {
    const { post } = http(ctx.base);
    const projectId = await createProject(ctx.base, "T9 恢复守卫");
    const missing = await post(`/api/projects/${projectId}/runs/resume`, { requestId: "req-nonexistent", plan: PLAN });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("找不到请求: req-nonexistent");

    // 直写一条从未运行的 request 记录:readRequest 命中但 findRunByRequestId 为空
    const store = FsProjectStore.open(join(ctx.dataDir, "projects", projectId));
    await store.saveRequest({
      id: "req-never-run",
      module: "industry",
      goal: "T9 恢复守卫",
      scope: { summary: "s", queries: [] },
      attachments: [],
    });
    const noRun = await post(`/api/projects/${projectId}/runs/resume`, { requestId: "req-never-run", plan: PLAN });
    expect(noRun.status).toBe(409);
    expect((await noRun.json()).error).toBe("没有可恢复的已取消运行: req-never-run");
  });

  it("T10:rerun 原请求不存在 → 404", async () => {
    const { post } = http(ctx.base);
    const projectId = await createProject(ctx.base, "T10 重跑守卫");
    const res = await post(`/api/projects/${projectId}/runs/rerun`, { requestId: "req-nonexistent" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("原始请求不存在(req-nonexistent),无法重跑");
  });

  it("T11:instruct 队列满(20)→ 第 21 次 409", async () => {
    const { post } = http(ctx.base);
    const projectId = await createProject(ctx.base, "T11 队列上限");
    // instruct 只按 requestId 查 running 状态的 run 记录,不查 controllers——直写记录即可确定性触发
    const store = FsProjectStore.open(join(ctx.dataDir, "projects", projectId));
    await store.saveRun({
      id: "run-t11",
      requestId: "req-t11",
      stage: "gather",
      status: "running",
      checkpoints: [],
      usage: { searches: 0, fetches: 0, modelCalls: 0, outputTokens: 0, wallMs: 0 },
    });
    for (let i = 1; i <= 20; i++) {
      const res = await post(`/api/projects/${projectId}/runs/instruct`, {
        requestId: "req-t11",
        instruction: { type: "skip-question", questionId: "q1" },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.queued).toBe(true);
      expect(body.pending).toBe(i);
    }
    const full = await post(`/api/projects/${projectId}/runs/instruct`, {
      requestId: "req-t11",
      instruction: { type: "skip-question", questionId: "q1" },
    });
    expect(full.status).toBe(409);
    expect((await full.json()).error).toBe("指令队列已满(20),请等待当前问题完成");
  });
});

describe("T12 resume 不注入复用资产", () => {
  let ctx: Ctx;
  let asset: { sourceId: string; versionId: string };
  beforeAll(async () => {
    ctx = await startWith(() => fakeAdapters(true));
    const reg = await http(ctx.base).post("/api/library/assets", {
      kind: "file",
      filename: "t12-画像.md",
      content: bodyA,
      reuseScope: "WORKSPACE_REUSABLE",
    });
    asset = (await reg.json()).results[0] as { sourceId: string; versionId: string };
  });
  afterAll(async () => {
    await ctx.srv.close();
  });

  it("T12:resume 后 /api/library/bindings?runId 的 usages 不增长", async () => {
    const { post, api } = http(ctx.base);
    const projectId = await createProject(ctx.base, "T12 复用恢复");
    const started = await post(`/api/projects/${projectId}/runs`, {
      request: { id: "req-t12", module: "industry", goal: "T12 复用恢复", scope: { summary: "s", queries: ["人群"] } },
      plan: PLAN2,
      selectedAssets: [{ sourceId: asset.sourceId, versionId: asset.versionId, purpose: "人群案例" }],
    });
    expect(started.status).toBe(200);
    expect((await started.json()).reuse.bound).toBe(1);

    const launched = await waitForRun(ctx.base, projectId, "req-t12", () => true, "exists");
    const runId = launched.id as string;
    // 等 launch 阶段的复用注入产生至少一条 usage(注入在 gather 采证前完成)
    const bindingsOf = async () =>
      (await (await api(`/api/library/bindings?runId=${runId}`)).json()) as { bindings: unknown[]; usages: unknown[] };
    let pre = await bindingsOf();
    for (let i = 0; i < 100 && pre.usages.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 50));
      pre = await bindingsOf();
    }
    expect(pre.bindings.length).toBe(1);
    expect(pre.usages.length).toBeGreaterThanOrEqual(1);

    const cancelled = await post(`/api/projects/${projectId}/runs/cancel`, { requestId: "req-t12" });
    expect(cancelled.status).toBe(200);
    await waitForRun(ctx.base, projectId, "req-t12", (r) => r.status === "cancelled", "cancelled");

    // 取消落定后为静止点:usage 只可能由注入块产生,不会再有在途写入
    const baseline = await bindingsOf();
    expect(baseline.usages.length).toBe(pre.usages.length);
    expect(baseline.bindings.length).toBe(pre.bindings.length);

    // 钉住现状:resume 不向 runOnProject 传 runId → runResearch 的复用注入门禁
    // (options.library && options.runId)为假,绑定资产注入与 usage 记录整体跳过;
    // 因此 resume 完成后 usages/bindings 均不得增长(D4/R1-Q5 保留行为,不是缺陷修复对象)
    const resumed = await post(`/api/projects/${projectId}/runs/resume`, { requestId: "req-t12", plan: PLAN2 });
    expect(resumed.status).toBe(200);
    await waitForRun(ctx.base, projectId, "req-t12", (r) => ["published", "limited"].includes(r.status), "done");

    const after = await bindingsOf();
    expect(after.usages.length).toBe(baseline.usages.length);
    expect(after.bindings.length).toBe(baseline.bindings.length);
  }, 30_000);
});
