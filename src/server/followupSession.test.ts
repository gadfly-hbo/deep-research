/* P2-5 T5:追问会话化——followup 端点 e2e、摘要模板、会话记忆(update 投递/首次真实 run/降级)。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Adapters } from "../adapters/types.js";
import { scriptedRunAgent } from "../adapters/testing.js";
import { startServer, type RunningServer } from "./server.js";
import { FsProjectStore } from "../stores/fsStore.js";
import { buildRunDigest, resolveSessionCandidates, readSessionDigests, writeSessionDigest, createProjectSessionRuntime } from "./sessionRuntime.js";
import type { ResearchRun, ResearchResultBundle } from "../contracts.js";

const bodyA = "中国咖啡市场规模约 1,200 亿元(2025 年)。行业边界包括现磨与即饮。产业链上游为咖啡豆贸易。竞争格局集中度提升。";

const fakeAdapters = (): Adapters => ({
  search: { search: async () => [{ url: "https://a/1", title: "A", snippet: "" }] },
  page: { fetch: async (url: string) => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }) },
  parser: { parse: async () => ({ bodyText: bodyA, parseStatus: "ok" }) },
  model: {
    extractClaims: async () => ({
      claims: [{ statement: "市场规模约 1200 亿元(2025)", kind: "fact" as const, quote: "市场规模约 1,200 亿元" }],
      usage: { modelCalls: 1, outputTokens: 16 },
    }),
    runStage: async (stage: string) =>
      stage === "plan"
        ? { output: { questions: [{ id: "q1", question: "原始问题" }] }, usage: { modelCalls: 1, outputTokens: 16 } }
        : stage === "outline"
          ? { output: { title: "原始框架", sections: [{ id: "s1", title: "市场规模", bullets: [] }] }, usage: { modelCalls: 1, outputTokens: 16 } }
          : stage === "analyze"
            ? { output: { findings: [], gaps: [] }, usage: { modelCalls: 1, outputTokens: 16 } }
            : stage === "draft"
              ? { output: { reportMd: "# 行业研究\n\n## 市场规模\nx" }, usage: { modelCalls: 1, outputTokens: 16 } }
              : { output: { issues: [], counterexampleChecked: true }, usage: { modelCalls: 1, outputTokens: 16 } },
    runAgent: scriptedRunAgent(),
  },
});

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const waitRun = async (base: string, projectId: string, requestId: string, pred: (r: any) => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    const d = (await (await fetch(`${base}/api/projects/${projectId}`)).json()) as any;
    const run = d.runs.find((r: any) => r.requestId === requestId);
    if (run && pred(run)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待超时(${label})`);
};

describe("buildRunDigest 摘要模板(R1-8)", () => {
  const run = (over: Partial<ResearchRun>): ResearchRun =>
    ResearchRun_parse({ id: "run-1", requestId: "req-1", stage: "gather", status: "limited", checkpoints: [], usage: { searches: 1, fetches: 1, modelCalls: 1, outputTokens: 1, wallMs: 1 }, progress: { answered: 2, open: 1, skipped: 1, total: 4 }, ...over });
  function ResearchRun_parse(o: any): ResearchRun { return o; }

  it("published/limited/cancelled/failed 四态各带状态标签;800B 硬顶", () => {
    const bundle = { claims: Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, statement: `主张${i}`.repeat(20), evidenceId: "e" })) } as unknown as ResearchResultBundle;
    const d = buildRunDigest(run({ status: "published" }), bundle);
    expect(d).toContain("[req-1] 完整交付");
    expect(d).toContain("2答/1未/1跳");
    expect(d.length).toBeLessThanOrEqual(800);
    expect(buildRunDigest(run({ status: "limited" }), null)).toContain("有限交付");
    expect(buildRunDigest(run({ status: "cancelled" }), null)).toContain("已取消");
    expect(buildRunDigest(run({ status: "failed", error: "模型中断" }), null)).toContain("中断");
  });
});

describe("会话研究记忆(D1/R1/R4)", () => {
  let dataDir: string;
  let auditPath: string;
  let rt: ReturnType<typeof createProjectSessionRuntime>;
  let projectDir: string;
  let modelCalls: number;

  const synthCandidates = () => {
    modelCalls = 0;
    const transport = async () => {
      modelCalls++;
      return { content: [{ kind: "text", text: "摘要已记录" }], stop: "complete" as const, usage: { inputTokens: 10, outputTokens: 5 } };
    };
    const model = {
      provider: "test", id: "t1", protocol: "anthropic-messages" as const,
      endpoint: "http://127.0.0.1:9", contextWindow: 100_000, maxOutputTokens: 4096, input: ["text" as const],
    } as import("pi-agent-runtime").ModelConfig;
    const transportFn = transport as import("pi-agent-runtime").ModelTransport;
    return [{ model, transport: transportFn }];
  };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "dr-p25-"));
    auditPath = join(dataDir, "model-audit.jsonl");
    projectDir = join(dataDir, "projects", "p-test1");
    const candidates = synthCandidates();
    rt = createProjectSessionRuntime({ projectDir, candidates, auditPath });
  });
  afterEach(() => { void rt; });

  const fakeResult = (id: string): { run: ResearchRun; bundle: ResearchResultBundle | null } => ({
    run: { id, requestId: `req-${id}`, stage: "gather", status: "limited", checkpoints: [], usage: { searches: 1, fetches: 1, modelCalls: 2, outputTokens: 20, wallMs: 100 }, progress: { answered: 1, open: 1, skipped: 0, total: 2 } } as ResearchRun,
    bundle: null,
  });

  it("R4 首次写=一次真实 run(恰 1 次模型);后续写=update 零模型;history 累积可读 tail K", async () => {
    await writeSessionDigest(rt, fakeResult("r1").run, null);
    expect(modelCalls).toBe(1); // 首条走 run()
    await writeSessionDigest(rt, fakeResult("r2").run, null);
    await writeSessionDigest(rt, fakeResult("r3").run, null);
    expect(modelCalls).toBe(1); // 后续 update 零模型(KA1 钉死)
    const digests = await readSessionDigests(rt, 3);
    expect(digests).toHaveLength(3);
    expect(digests[0]).toContain("req-r1");
    expect(digests[2]).toContain("req-r3");
    const k1 = await readSessionDigests(rt, 1);
    expect(k1).toHaveLength(1);
    expect(k1[0]).toContain("req-r3"); // tail
  });

  it("F1 单元:完成 run 恰 1 条摘要(update 路径无中间态)", async () => {
    await writeSessionDigest(rt, fakeResult("g1").run, null);
    await writeSessionDigest(rt, fakeResult("g2").run, null);
    const digests = await readSessionDigests(rt, 10);
    expect(digests.filter((d) => d.includes("req-g2"))).toHaveLength(1);
  });

  it("resolveSessionCandidates:真值表外+缺 key→null 降级", () => {
    expect(resolveSessionCandidates(undefined)).toBeNull();
    expect(resolveSessionCandidates([{ provider: "minimax-cn", modelId: "MiniMax-M3" }])).toBeNull(); // 无 key 环境
  });
});

describe("followup 端点 e2e(D2)", () => {
  let srv: RunningServer;
  let base: string;
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "dr-p25-e2e-"));
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters() });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterEach(async () => { await srv.close(); });

  it("404 无基准;409 active 守卫;200 免 plan 起跑→plan 门→确认→完成(derivedFromRunId)", async () => {
    const created = await post(base, "/api/projects", { module: "industry", goal: "追问测试", scope: { summary: "s", queries: [] } });
    const id = ((await created.json()) as { id: string }).id;

    const noBase = await post(base, `/api/projects/${id}/runs/followup`, { prompt: "追问" });
    expect(noBase.status).toBe(404);

    // 先完成一个基准 run(带 plan 旧路径直跑)
    const store = FsProjectStore.open(join(dataDir, "projects", id));
    await store.saveRequest({ id: "req-base", module: "industry", goal: "基准", scope: { summary: "s", queries: ["基准问题"] }, attachments: [] } as any);
    await store.saveRun({ id: "run-base", requestId: "req-base", stage: "gather", status: "published", checkpoints: [], usage: { searches: 1, fetches: 1, modelCalls: 1, outputTokens: 10, wallMs: 100 } } as any);
    await store.saveCheckpoint({ runId: "run-base", stage: "gather", data: { questions: [{ id: "q1", question: "基准问题", status: "answered" }] }, completedAt: new Date().toISOString() });
    await store.saveBundle({ runId: "run-base", goal: "基准", module: "industry", summary: "", reportMd: "# 基准", outline: null, claims: [], evidence: [], snapshots: [], limitations: [], reasonSummaries: [] } as any);

    const fu = await post(base, `/api/projects/${id}/runs/followup`, { prompt: "追问:渠道细分", baseRunId: "run-base" });
    expect(fu.status).toBe(200);
    const gate = await waitRun(base, id, (await (await fu.json() as any)).requestId, (r) => r.status === "awaiting-confirmation" && r.gate?.kind === "plan", "plan 门");
    expect(gate.derivedFromRunId).toBe("run-base");

    // active 守卫:门未决时再 followup → 409
    const conflict = await post(base, `/api/projects/${id}/runs/followup`, { prompt: "再追问" });
    expect(conflict.status).toBe(409);

    // 确认双门走完
    const c1 = await post(base, `/api/projects/${id}/runs/${gate.id}/gate/confirm`, { payload: { questions: [{ id: "q1", question: "追问问题", status: "open" }] } });
    expect(c1.status).toBe(200);
    const outlineGate = await waitRun(base, id, gate.requestId, (r) => r.status === "awaiting-confirmation" && r.gate?.kind === "outline", "outline 门");
    const c2 = await post(base, `/api/projects/${id}/runs/${outlineGate.id}/gate/confirm`, { payload: { title: "追问框架", sections: [{ id: "s1", title: "市场", bullets: [] }] } });
    expect(c2.status).toBe(200);
    const done = await waitRun(base, id, gate.requestId, (r) => ["published", "limited"].includes(r.status), "完成");
    expect(done.derivedFromRunId).toBe("run-base");
  }, 30_000);
});

describe("F1+F2 集成(REVIEW 复审建议)", () => {
  const synthCandidates = () => {
    const transport = (async () => ({
      content: [{ kind: "text", text: "摘要已记录" }],
      stop: "complete" as const,
      usage: { inputTokens: 10, outputTokens: 5 },
    })) as import("pi-agent-runtime").ModelTransport;
    const model = {
      provider: "test", id: "t1", protocol: "anthropic-messages" as const,
      endpoint: "http://127.0.0.1:9", contextWindow: 100_000, maxOutputTokens: 4096, input: ["text" as const],
    } as import("pi-agent-runtime").ModelConfig;
    return [{ model, transport }];
  };

  it("F1 集成:gates 下起 run→落 plan 门→摘要=0 条(gate 非终态不写);确认双门走完→摘要恰 1 条(终态)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "dr-p25-f1-"));
    const srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters(), sessionCandidates: synthCandidates() });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const created = await post(base, "/api/projects", { module: "industry", goal: "F1 集成", scope: { summary: "s", queries: [] } });
      const id = ((await created.json()) as { id: string }).id;
      await post(base, `/api/projects/${id}/runs`, { request: { id: "req-f1i", module: "industry", goal: "F1 集成", scope: { summary: "s", queries: [] } } });
      const gateRun = await waitRun(base, id, "req-f1i", (r) => r.status === "awaiting-confirmation" && r.gate?.kind === "plan", "plan 门");
      // 门后:会话应为空(gate 非终态不写摘要——历史仅首条初始化 run 不应发生,因 run 未完成)
      const rt = createProjectSessionRuntime({ projectDir: join(dataDir, "projects", id), candidates: synthCandidates(), auditPath: join(dataDir, "model-audit.jsonl") });
      expect(await readSessionDigests(rt, 10)).toHaveLength(0); // F1 核心:awaiting 状态零摘要
      // 确认双门走完
      await post(base, `/api/projects/${id}/runs/${gateRun.id}/gate/confirm`, { payload: { questions: [{ id: "q1", question: "F1 问题", status: "open" }] } });
      const og = await waitRun(base, id, "req-f1i", (r) => r.status === "awaiting-confirmation" && r.gate?.kind === "outline", "outline 门");
      await post(base, `/api/projects/${id}/runs/${og.id}/gate/confirm`, { payload: { title: "F1 框架", sections: [{ id: "s1", title: "市场", bullets: [] }] } });
      await waitRun(base, id, "req-f1i", (r) => ["published", "limited"].includes(r.status), "完成");
      await new Promise((r) => setTimeout(r, 200)); // 摘要异步写入
      const digests = await readSessionDigests(createProjectSessionRuntime({ projectDir: join(dataDir, "projects", id), candidates: synthCandidates(), auditPath: join(dataDir, "model-audit.jsonl") }), 10);
      expect(digests.filter((d) => d.includes("req-f1i"))).toHaveLength(1); // 终态恰 1 条
    } finally { await srv.close(); }
  }, 30_000);

  it("F2 集成:双已完成 run 无 baseRunId→默认取 mtime 最新", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "dr-p25-f2-"));
    const srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters() });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const created = await post(base, "/api/projects", { module: "industry", goal: "F2 双基准", scope: { summary: "s", queries: [] } });
      const id = ((await created.json()) as { id: string }).id;
      const store = FsProjectStore.open(join(dataDir, "projects", id));
      for (const [rid, reqId] of [["run-old", "req-old"], ["run-new", "req-new"]] as const) {
        await store.saveRequest({ id: reqId, module: "industry", goal: `基准${rid}`, scope: { summary: "s", queries: ["q"] }, attachments: [] } as any);
        await store.saveRun({ id: rid, requestId: reqId, stage: "gather", status: "published", checkpoints: [], usage: { searches: 1, fetches: 1, modelCalls: 1, outputTokens: 10, wallMs: 100 } } as any);
        await store.saveBundle({ runId: rid, goal: `基准${rid}`, module: "industry", summary: "", reportMd: `# 基准${rid}`, outline: null, claims: [], evidence: [], snapshots: [], limitations: [], reasonSummaries: [] } as any);
        await store.saveCheckpoint({ runId: rid, stage: "gather", data: { questions: [{ id: "q1", question: "q", status: "answered" }] }, completedAt: new Date().toISOString() });
        await new Promise((r) => setTimeout(r, 25)); // mtime 分辨
      }
      const fu = await post(base, `/api/projects/${id}/runs/followup`, { prompt: "默认应取 run-new" });
      expect(fu.status).toBe(200);
      const gate = await waitRun(base, id, (await (fu.json() as any)).requestId, (r) => r.status === "awaiting-confirmation" && r.gate?.kind === "plan", "门");
      expect(gate.derivedFromRunId).toBe("run-new"); // mtime 最新,非 UUID 序
      await post(base, `/api/projects/${id}/runs/${gate.id}/gate/cancel`, {});
    } finally { await srv.close(); }
  }, 30_000);
});
