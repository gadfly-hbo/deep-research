import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import { createProject, publishBundle, runOnProject } from "../../app/projectService.js";
import {
  ResearchRequestSchema,
  RunInstructionSchema,
  type Intervention,
  type ResearchRequest,
} from "../../contracts.js";
import type { RunOptions } from "../../core/runResearch.js";
import { OutlineOutputSchema, PlanOutputSchema, type OutlineOutput, type PlanOutput } from "../../core/stages.js";
import type { AssetBinding } from "../../library/contracts.js";
import { bindAssets } from "../../library/reuse.js";
import { FsProjectStore } from "../../stores/fsStore.js";
import { json, PROJECT_ID, type Ctx } from "./http.js";
import { readSessionDigests } from "../sessionRuntime.js";
import { handleVersionRoutes } from "./versions.js";

// P1-3 T2:projectsRuns 域(附录 A 第 1–12 项)。HTTP 行为与拆分前逐位一致。
// T5:Ctx 已迁至 routes/http.ts(D2 启动级单例)。

const IncrementalRefSchema = z.object({ runId: z.string().min(1), requestId: z.string().min(1) });

/** P2-3:确认门常开组合——POST /runs body 无 plan 时由 server 传入(R1-4)。 */
const CONFIRM_GATES = { plan: true as const, outline: true as const };

/** 2.1 追问扩展:解析并校验增量基准——本项目内已完成(published/limited)的 run 及其成果包。 */
const resolveIncrementalBase = async (
  store: FsProjectStore,
  raw: unknown,
): Promise<
  | { error: string; status: number }
  | {
      base: {
        runId: string;
        summary: Record<string, unknown>;
        answeredQuestions: string[];
        outline: unknown;
      };
    }
> => {
  const ref = IncrementalRefSchema.safeParse(raw);
  if (!ref.success) return { status: 400, error: "incrementalOf 需含 runId 与 requestId" };
  const run = (await store.listRuns()).find((r) => r.id === ref.data.runId && r.requestId === ref.data.requestId);
  if (!run) return { status: 404, error: `基准 run 不属于本项目: ${ref.data.runId}` };
  if (run.status !== "published" && run.status !== "limited") {
    return {
      status: 409,
      error: `基准 run 未完成(${run.status});只有已完成(published/limited)的运行可作为增量基准`,
    };
  }
  const bundle = await store.readBundle(ref.data.runId);
  if (!bundle) return { status: 404, error: `基准成果包缺失: ${ref.data.runId}` };
  const cps = await store.checkpoints(ref.data.runId);
  const gatherCp = cps.find((c) => c.stage === "gather");
  const planCp = cps.find((c) => c.stage === "plan");
  const questions =
    (gatherCp?.data as { questions?: Array<{ question: string; status: string }> } | undefined)?.questions ??
    (planCp?.data as { questions?: Array<{ question: string; status: string }> } | undefined)?.questions ??
    [];
  const answeredQuestions = questions
    .filter((q) => q.status === "answered" || q.status === "partially")
    .map((q) => q.question);
  const lastFetchedAt = bundle.snapshots.reduce((m, s) => (s.fetchedAt > m ? s.fetchedAt : m), "");
  return {
    base: {
      runId: ref.data.runId,
      summary: {
        runId: ref.data.runId,
        answeredQuestions: answeredQuestions.length,
        evidence: bundle.evidence.length,
        snapshots: bundle.snapshots.length,
        claims: bundle.claims.length,
        lastFetchedAt,
      },
      answeredQuestions,
      outline: bundle.outline ?? null,
    },
  };
};

/** R2-2:内存 drain 为空直接返回 [] 不落盘;非空取空后重写 pending 文件(复刻原 drainFor 语义)。 */
const drainAndPersist =
  (ctx: Ctx, runId: string, dir: string): (() => Promise<Intervention[]>) =>
  async () => {
    const drained = ctx.registry.drain(runId);
    if (drained.length === 0) return [];
    await FsProjectStore.open(dir).savePendingInstructions(runId, []);
    return drained;
  };

/**
 * D4:launch/resume 同构骨架——acquire → void runOnProject(...) → catch(策略参数化) → finally release。
 * options 由各调用点自行构造(不对称保留:launch 传 runId,resume 不传——T12 钉住的现状)。
 * P2-6(R1-1/R1-5):runId 挂账本键空间(registerBudget/takeRefinement 闭包注入),finally 注销。
 */
const startPipeline = (
  ctx: Ctx,
  dir: string,
  request: ResearchRequest,
  options: RunOptions,
  runId: string,
  onFailure: (error: unknown) => Promise<void>,
): void => {
  const controller = ctx.registry.acquire(request.id ?? "");
  void runOnProject(dir, request, ctx.makeAdapters(), {
    ...options,
    signal: controller.signal,
    registerBudget: (b) => ctx.registry.registerBudget(runId, b),
    takeRefinement: () => ctx.registry.takeRefinement(runId),
    ...(ctx.onRunComplete ? { onRunComplete: ctx.onRunComplete(dir) } : {}),
  })
    .catch(onFailure)
    .finally(() => {
      ctx.registry.release(request.id ?? "");
      ctx.registry.unregisterBudget(runId);
    });
};

/** 运行启动核心:bindAssets 复用绑定 + 落 running 记录(launch 独有前奏)+ 挂后台流水线;/runs 与 /runs/rerun 共用。 */
const launchRun = async (
  ctx: Ctx,
  id: string,
  dir: string,
  request: ResearchRequest,
  plan: PlanOutput | undefined,
  selectedAssets?: unknown,
  gates?: RunOptions["gates"],
  sessionDigests?: string[],
): Promise<{
  runId: string;
  requestId: string;
  reuse: { bound: number; rejected: Array<{ sourceId: string; reason: string }> };
}> => {
  const runId = randomUUID();
  // 2.0 复用选择(§5.2):启动前服务端检查并固定版本绑定;越权项拒绝并回报
  let bindReport: { bound: number; rejected: Array<{ sourceId: string; reason: string }> } = {
    bound: 0,
    rejected: [],
  };
  if (Array.isArray(selectedAssets) && selectedAssets.length > 0) {
    const outcome = await bindAssets(ctx.library, {
      runId,
      projectId: id,
      idempotencyKey: `select-${runId}`,
      bindings: (selectedAssets as Array<Record<string, unknown>>).map((a) => ({
        sourceId: String(a.sourceId),
        versionId: String(a.versionId),
        purpose: String(a.purpose ?? "研究复用"),
        applicability: (a.applicability as AssetBinding["applicability"]) ?? "ELIGIBLE",
        asOf: a.asOf ? String(a.asOf) : undefined,
      })),
    });
    bindReport = { bound: outcome.bindings.length, rejected: outcome.rejected };
  }
  // 先落一条 running 记录:启动即可见,进程中断也不至于"无痕消失"
  await FsProjectStore.open(dir).saveRun({
    id: runId,
    requestId: request.id ?? runId,
    stage: "plan",
    status: "running",
    checkpoints: [],
    usage: { searches: 0, fetches: 0, modelCalls: 0, outputTokens: 0, wallMs: 0 },
  });
  startPipeline(
    ctx,
    dir,
    request,
    {
      plan,
      runId,
      gates,
      library: ctx.library,
      projectId: id,
      pollInstructions: drainAndPersist(ctx, runId, dir),
      ...(sessionDigests?.length ? { sessionDigests } : {}),
    },
    runId,
    async (error) => {
      // 失败不冒充完成:落一条 failed run 记录,带错误信息
      await FsProjectStore.open(dir).saveRun({
        id: runId,
        requestId: request.id ?? runId,
        stage: "gather",
        status: "failed",
        checkpoints: [],
        usage: { searches: 0, fetches: 0, modelCalls: 0, outputTokens: 0, wallMs: 0 },
        error: String(error instanceof Error ? error.message : error),
      });
    },
  );
  return { runId, requestId: request.id ?? "", reuse: bindReport };
};

/** 返回 true=已处理;false=落到后续域(versions/snapshots 子树、library、settings、静态、catch-all)。 */
export const handleProjectsRoutes = async (
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: any,
): Promise<boolean> => {
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/api/projects") {
    const root = join(ctx.dataDir, "projects");
    const projects = existsSync(root)
      ? readdirSync(root)
          .filter((id) => PROJECT_ID.test(id) && existsSync(join(root, id, "project.json")))
          .map((id) => FsProjectStore.open(join(root, id)).meta())
      : [];
    json(res, 200, { projects });
    return true;
  }

  if (method === "POST" && path === "/api/projects") {
    const dir = createProject(ctx.dataDir, {
      module: body.module,
      goal: body.goal,
      scope: body.scope,
    });
    json(res, 200, { dir, id: dir.split("/").pop() });
    return true;
  }

  const projectMatch = path.match(/^\/api\/projects\/([^/]+)(.*)$/);
  if (!projectMatch) return false;
  const [, id, rest] = projectMatch;
  // D1 怪癖逐位保留:任何 /api/projects/:id/* 先验 id(非法→抛出→外层 500),再做子路由分发(T7 钉住)
  const dir = ctx.projectDir(id);

  // P2-5(REVIEW F5):单 active-run 守卫单一收口——三处(POST /runs、rerun、followup)共用
  const assertNoActiveRun = async (action: string): Promise<{ status: 409; body: { error: string } } | null> => {
    const active = (await ctx.storeFor(id).listRuns()).find(
      (r) => r.status === "running" || r.status === "awaiting-confirmation",
    );
    return active
      ? { status: 409 as const, body: { error: `该项目存在进行中或待确认的运行(${active.requestId}),结束后才能${action}` } }
      : null;
  };

  // versions/snapshots 子树(T3,R2-1 交接):验 id 后委托 versions 域;未匹配的子路径由其返回 false 落回
  if (rest === "/snapshots" || rest.startsWith("/versions/")) {
    return handleVersionRoutes(ctx, res, { id, dir, rest, url, method });
  }

  if (method === "GET" && rest === "") {
    const s = ctx.storeFor(id);
    const meta = s.meta();
    // P1-4:formalGenerated 响应时计算(D1/KA1)——产物文件即事实源,零迁移;仅详情端点(R1-2)
    const versions = meta.versions.map((v) => ({
      ...v,
      formalGenerated: existsSync(join(dir, "reports", `v${v.version}`, "formal", "formal.json")),
    }));
    json(res, 200, {
      meta: { ...meta, versions },
      runs: await s.listRuns(),
      // P0-2:列表型响应剥离 bodyText(UI 从未消费;正文按需走 /snapshots?sid=)
      snapshots: (await s.listSnapshots()).map(({ bodyText: _omit, ...rest }) => rest),
    });
    return true;
  }

  // P2-3(裁决 3):plan-preview/outline-preview 预览端点已退役——计划/框架确认翻转进 run 内
  // durable 门(POST /runs 免 plan 起跑 + gate 三端点),保留预览通道=绕过确认的旁路 LLM 调用。

  if (method === "POST" && rest === "/runs") {
    const request = ResearchRequestSchema.parse(body.request);
    // 2.1:增量基准与预览端点同一校验——本项目已完成的 run 才可作为基准
    if (request.incrementalOf) {
      const resolved = await resolveIncrementalBase(ctx.storeFor(id), request.incrementalOf);
      if ("error" in resolved) {
        json(res, resolved.status, { error: resolved.error });
        return true;
      }
    }
    // P2-5(REVIEW F5):单 active-run 守卫单一收口——三处(POST /runs、rerun、followup)共用
    // P2-3(KA2/R1-6):守卫与 launch 同把 per-project 锁消 TOCTOU;body 无 plan 时传 gates 走确认门(R1-4)
    const outcome = await ctx.registry.withProjectLock(id, async () => {
      const busy = await assertNoActiveRun("发起新运行");
      if (busy) return busy;
      const started = await launchRun(
        ctx,
        id,
        dir,
        request,
        body.plan,
        body.selectedAssets,
        body.plan ? undefined : CONFIRM_GATES,
      );
      return { status: 200 as const, body: { started: true, requestId: started.requestId, reuse: started.reuse } };
    });
    json(res, outcome.status, outcome.body);
    return true;
  }

  // 重跑:读原研究请求,换预算档位与全新请求 ID;沿用原已确认问题清单,不重新规划
  if (method === "POST" && rest === "/runs/rerun") {
    const original = await ctx.storeFor(id).readRequest(String(body.requestId ?? ""));
    if (!original) {
      json(res, 404, { error: `原始请求不存在(${String(body.requestId ?? "")}),无法重跑` });
      return true;
    }
    const priorRun = await ctx.storeFor(id).findRunByRequestId(String(body.requestId ?? ""));
    if (priorRun?.status === "running") {
      json(res, 409, { error: "该请求的运行仍在进行中,结束后才能重跑" });
      return true;
    }
    const tier = z.enum(["low", "medium", "high"]).default("medium").parse(body.budgetTier);
    const request = ResearchRequestSchema.parse({
      ...original,
      id: `req-${Date.now().toString(36)}`,
      budgetTier: tier,
      budget: undefined,
    });
    if (request.incrementalOf) {
      const resolved = await resolveIncrementalBase(ctx.storeFor(id), request.incrementalOf);
      if ("error" in resolved) {
        json(res, resolved.status, { error: resolved.error });
        return true;
      }
    }
    // P2-3(KA2):rerun 同守卫(不传 gates,旧路径直跑,R1-4)
    const outcome = await ctx.registry.withProjectLock(id, async () => {
      const busy = await assertNoActiveRun("重跑");
      if (busy) return busy;
      const plan: PlanOutput = {
        questions: request.scope.queries.map((q, i) => ({ id: `q${i + 1}`, question: q, status: "open" })),
      };
      const started = await launchRun(ctx, id, dir, request, plan);
      return { status: 200 as const, body: { started: true, requestId: started.requestId, reuse: started.reuse } };
    });
    json(res, outcome.status, outcome.body);
    return true;
  }

  // P2-5(D2):追问=followup 端点——基准定位+免 plan 起跑(双确认门)+会话纪要注入
  if (method === "POST" && rest === "/runs/followup") {
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) {
      json(res, 400, { error: "追问目标不能为空(prompt)" });
      return true;
    }
    const store = ctx.storeFor(id);
    // 基准定位:显式 baseRunId 或项目最新已完成 run
    const runs = await store.listRuns();
    // REVIEW F2:默认基准=最新已完成 run(按 run.json 修改时间序,非 listRuns 的 id 字典序)
    const mtimeOf = (runId: string): number => {
      try {
        return statSync(join(dir, "runs", runId, "run.json")).mtimeMs;
      } catch {
        return 0;
      }
    };
    const base = body.baseRunId
      ? runs.find((r) => r.id === String(body.baseRunId) && (r.status === "published" || r.status === "limited"))
      : [...runs]
          .filter((r) => r.status === "published" || r.status === "limited")
          .sort((a, b) => mtimeOf(b.id) - mtimeOf(a.id))[0];
    if (!base) {
      json(res, 404, { error: `没有可作为追问基准的已完成运行(${String(body.baseRunId ?? "最新")})` });
      return true;
    }
    const baseRequest = await store.readRequest(base.requestId);
    if (!baseRequest) {
      json(res, 404, { error: `基准请求不存在: ${base.requestId}` });
      return true;
    }
    const request = ResearchRequestSchema.parse({
      id: `req-${Date.now().toString(36)}`,
      module: baseRequest.module,
      goal: prompt,
      scope: { summary: body.summary ?? baseRequest.scope.summary, queries: [] },
      incrementalOf: { runId: base.id, requestId: base.requestId },
      budgetTier: body.budgetTier ?? "medium",
      budget: undefined,
    });
    const resolved = await resolveIncrementalBase(store, request.incrementalOf);
    if ("error" in resolved) {
      json(res, resolved.status, { error: resolved.error });
      return true;
    }
    // 会话纪要(P2-5 D1:只在发起时读一次;候选链不可用→降级零纪要)
    let sessionDigests: string[] = [];
    if (ctx.sessionRuntime) {
      try {
        const rt = ctx.sessionRuntime(id, dir);
        if (rt) sessionDigests = await readSessionDigests(rt);
      } catch {
        /* 会话读失败降级零纪要 */
      }
    }
    const outcome = await ctx.registry.withProjectLock(id, async () => {
      const busy = await assertNoActiveRun("追问");
      if (busy) return busy;
      const started = await launchRun(ctx, id, dir, request, undefined, undefined, { plan: true, outline: true }, sessionDigests);
      return { status: 200 as const, body: { started: true, requestId: started.requestId, reuse: started.reuse } };
    });
    json(res, outcome.status, outcome.body);
    return true;
  }

  if (method === "POST" && rest === "/runs/cancel") {
    // 查找键原样透传 body.requestId(含 undefined):无运行中 run 则 404,文案插值逐字保留
    if (!ctx.registry.cancel(body.requestId)) {
      json(res, 404, { error: `没有正在运行的 run: ${body.requestId}` });
      return true;
    }
    json(res, 200, { cancelled: true });
    return true;
  }

  if (method === "POST" && rest === "/runs/instruct") {
    // 2.1 执行中干预:入队并在采证问题间隙被消费;队列随 run 目录落盘
    const run = await ctx.storeFor(id).findRunByRequestId(String(body.requestId ?? ""));
    if (!run || run.status !== "running") {
      json(res, 409, { error: `没有正在运行的 run: ${body.requestId}` });
      return true;
    }
    const parsed = RunInstructionSchema.safeParse(body.instruction);
    if (!parsed.success) {
      json(res, 400, { error: "干预指令不合法", issues: parsed.error.issues.map((i) => i.message) });
      return true;
    }
    if (ctx.registry.pendingCount(run.id) >= 20) {
      json(res, 409, { error: "指令队列已满(20),请等待当前问题完成" });
      return true;
    }
    const record: Intervention = {
      id: `ins:${randomUUID().slice(0, 8)}`,
      submittedAt: new Date().toISOString(),
      instruction: parsed.data,
    };
    // 双写顺序保留(R2-7):先 enqueue(内存 push)后 savePendingInstructions(落盘)
    const pending = ctx.registry.enqueue(run.id, record);
    await ctx.storeFor(id).savePendingInstructions(run.id, ctx.registry.snapshot(run.id));
    json(res, 200, {
      queued: true,
      instructionId: record.id,
      pending,
      note: "已入队,将在当前问题完成后生效",
    });
    return true;
  }

  // ---- P2-6(D1/R1-2):运行中加注——同 Budget 对象原地变异(只增不减);per-project 锁外
  //      (status 检查+变异的 TOCTOU 落空无害,instruct 先例);maxParallel 不可加注;无上限封顶 ----
  const budgetMatch = rest.match(/^\/runs\/([^/]+)\/budget$/);
  if (method === "POST" && budgetMatch) {
    // listRuns 按 run.id 反查(regex 仿 gate)
    const run = (await ctx.storeFor(id).listRuns()).find((r) => r.id === budgetMatch[1]);
    if (!run || run.status !== "running") {
      json(res, 409, { error: `没有正在运行的 run: ${budgetMatch[1]}` });
      return true;
    }
    const topupSchema = z
      .object({
        addSearches: z.number().int().positive().optional(),
        addFetches: z.number().int().positive().optional(),
        extendWallMs: z.number().int().positive().optional(),
      })
      .refine(
        (v) => v.addSearches !== undefined || v.addFetches !== undefined || v.extendWallMs !== undefined,
        { message: "至少提供一项增量(addSearches/addFetches/extendWallMs)" },
      );
    const parsed = topupSchema.safeParse(body);
    if (!parsed.success) {
      json(res, 400, { error: "加注增量不合法(只增不减,各键须为正整数)", issues: parsed.error.issues.map((i) => i.message) });
      return true;
    }
    const budget = ctx.registry.budgetOf(run.id);
    if (!budget) {
      json(res, 409, { error: "该运行的预算账本未注册(可能正在恢复或已收束),稍后重试" });
      return true;
    }
    // KA2:同对象原地变异(禁引用替换)——executor 闸门/任务卡余量即时读到新值
    if (parsed.data.addSearches) budget.maxSearches += parsed.data.addSearches;
    if (parsed.data.addFetches) budget.maxFetches += parsed.data.addFetches;
    if (parsed.data.extendWallMs) budget.maxWallMs += parsed.data.extendWallMs;
    json(res, 200, {
      topped: true,
      runId: run.id,
      budget: { maxSearches: budget.maxSearches, maxFetches: budget.maxFetches, maxWallMs: budget.maxWallMs },
      note: "已加注,配额饿死的问题将自动重开;恢复/重启后加注不延续",
    });
    return true;
  }

  if (method === "POST" && rest === "/runs/resume") {
    const request = await ctx.storeFor(id).readRequest(body.requestId);
    if (!request) {
      json(res, 404, { error: `找不到请求: ${body.requestId}` });
      return true;
    }
    // 恢复必须命中已取消的原 run:不预落新记录(会与 findRunByRequestId 竞争导致静默全量重跑),
    // 沿用原 runId,由编排器在恢复瞬间把原记录置回 running(启动即可见)
    const prior = request.id ? await ctx.storeFor(id).findRunByRequestId(request.id) : undefined;
    if (!prior || prior.status !== "cancelled") {
      json(res, 409, { error: `没有可恢复的已取消运行: ${body.requestId}` });
      return true;
    }
    // 恢复未消费的干预指令(取消/中断前入队的继续有效;非法项被 safeParse 过滤丢弃)
    ctx.registry.restoreFromDisk(prior.id, await ctx.storeFor(id).readPendingInstructions(prior.id));
    startPipeline(
      ctx,
      dir,
      request,
      {
        plan: body.plan,
        library: ctx.library,
        projectId: id,
        pollInstructions: drainAndPersist(ctx, prior.id, dir),
      },
      prior.id,
      async (error) => {
        // 失败不冒充完成:更新原 run 记录为 failed,带错误信息
        const current = request.id ? await ctx.storeFor(id).findRunByRequestId(request.id) : undefined;
        if (current) {
          await FsProjectStore.open(dir).saveRun({
            ...current,
            status: "failed",
            error: String(error instanceof Error ? error.message : error),
          });
        }
      },
    );
    json(res, 200, { resumed: true, requestId: request.id, runId: prior.id });
    return true;
  }

  // ---- P2-3 确认门三端点(KA3:store 直写 + status 条件写 409 + per-run 互斥;不复用 /runs/cancel) ----

  // R1-5:awaiting 时回门载荷(问题/框架清单 + 上下文 + 增量摘要);非 awaiting → 404
  const gateMatch = rest.match(/^\/runs\/([^/]+)\/gate$/);
  if (method === "GET" && gateMatch) {
    const run = (await ctx.storeFor(id).listRuns()).find((r) => r.id === gateMatch[1]);
    if (!run || run.status !== "awaiting-confirmation" || !run.gate) {
      json(res, 404, { error: `没有待确认的运行: ${gateMatch[1]}` });
      return true;
    }
    // 载荷取门产出的检查点(plan 门取最新一版——confirm 前即产出本身)
    const cp = (await ctx.storeFor(id).checkpoints(run.id)).findLast((c) => c.stage === run.gate!.kind);
    if (!cp) {
      json(res, 404, { error: `门的产出检查点缺失: ${run.id}` });
      return true;
    }
    const request = await ctx.storeFor(id).readRequest(run.requestId);
    // R1-5:增量摘要按 request.incrementalOf 重跑 resolveIncrementalBase(替代旧预览 base 字段)
    let incremental: { summary: Record<string, unknown> } | undefined;
    if (request?.incrementalOf) {
      const resolved = await resolveIncrementalBase(ctx.storeFor(id), request.incrementalOf);
      if (!("error" in resolved)) incremental = { summary: resolved.base.summary };
    }
    json(res, 200, {
      kind: run.gate.kind,
      payload: cp.data,
      context: { goal: request?.goal, scope: request?.scope, module: request?.module },
      ...(incremental ? { incremental } : {}),
    });
    return true;
  }

  // R1-3:锁内 CAS 条件写(仅 awaiting 可确认,恰一胜)+ 落确认 checkpoint;锁外 startPipeline 续跑
  const gateConfirmMatch = rest.match(/^\/runs\/([^/]+)\/gate\/confirm$/);
  if (method === "POST" && gateConfirmMatch) {
    const store = ctx.storeFor(id);
    // listRuns 反查 runId(R1-3,不猜目录路径)
    const run = (await store.listRuns()).find((r) => r.id === gateConfirmMatch[1]);
    if (!run || !run.gate) {
      json(res, 404, { error: `没有待确认的运行: ${gateConfirmMatch[1]}` });
      return true;
    }
    const kind = run.gate.kind;
    const parsed = (kind === "plan" ? PlanOutputSchema : OutlineOutputSchema).safeParse(body.payload);
    if (!parsed.success) {
      json(res, 400, { error: "确认载荷不合法", issues: parsed.error.issues.map((i) => i.message) });
      return true;
    }
    // 读请求前置到 CAS 之前:避免置 running 后才发现 request 缺失卡死(REVIEW F2)
    const request = await store.readRequest(run.requestId);
    if (!request) {
      json(res, 404, { error: `找不到请求: ${run.requestId}` });
      return true;
    }
    const conflict = await ctx.registry.withGateLock(run.id, async () => {
      const current = (await store.listRuns()).find((r) => r.id === run.id);
      if (!current || current.status !== "awaiting-confirmation" || !current.gate) {
        return `运行不在待确认状态(${current?.status ?? "不存在"}),不能确认`;
      }
      // plan 门:追加确认 checkpoint(编辑版权威落盘,后续重启不依赖 find-first,KA1 双保险)
      if (kind === "plan") {
        await store.saveCheckpoint({
          runId: current.id,
          stage: "plan",
          data: parsed.data,
          completedAt: new Date().toISOString(),
        });
      }
      // CAS:置回 running 并同步清 gate 字段(R1-3)
      await store.saveRun({ ...current, status: "running", gate: undefined });
      return null;
    });
    if (conflict) {
      json(res, 409, { error: conflict });
      return true;
    }
    // R1-3:pending 指令回灌(resume 同构),失败沿既有语义落 failed(原 runId)
    ctx.registry.restoreFromDisk(run.id, await store.readPendingInstructions(run.id));
    const onFailure = async (error: unknown) => {
      const current = (await store.listRuns()).find((r) => r.id === run.id);
      if (current) {
        await store.saveRun({
          ...current,
          status: "failed",
          error: String(error instanceof Error ? error.message : error),
        });
      }
    };
    if (kind === "plan") {
      startPipeline(
        ctx,
        dir,
        request,
        {
          plan: parsed.data as PlanOutput,
          gates: CONFIRM_GATES,
          library: ctx.library,
          projectId: id,
          pollInstructions: drainAndPersist(ctx, run.id, dir),
        },
        run.id,
        onFailure,
      );
    } else {
      // R1-2:outline 编辑经 runOnProject 的 saveRequest 持久化,恢复权威源=request 文件
      startPipeline(
        ctx,
        dir,
        { ...request, outline: parsed.data as OutlineOutput },
        {
          gates: CONFIRM_GATES,
          library: ctx.library,
          projectId: id,
          pollInstructions: drainAndPersist(ctx, run.id, dir),
        },
        run.id,
        onFailure,
      );
    }
    json(res, 200, { confirmed: true, runId: run.id, kind });
    return true;
  }

  // 门取消:状态 cancelled(既有语义,可再 resume);非 awaiting → 409(锁内条件写)
  const gateCancelMatch = rest.match(/^\/runs\/([^/]+)\/gate\/cancel$/);
  if (method === "POST" && gateCancelMatch) {
    const store = ctx.storeFor(id);
    const run = (await store.listRuns()).find((r) => r.id === gateCancelMatch[1]);
    if (!run) {
      json(res, 404, { error: `找不到运行: ${gateCancelMatch[1]}` });
      return true;
    }
    const conflict = await ctx.registry.withGateLock(run.id, async () => {
      const current = (await store.listRuns()).find((r) => r.id === run.id);
      if (!current || current.status !== "awaiting-confirmation") {
        return `运行不在待确认状态(${current?.status ?? "不存在"}),不能取消`;
      }
      await store.saveRun({ ...current, status: "cancelled" });
      return null;
    });
    if (conflict) {
      json(res, 409, { error: conflict });
      return true;
    }
    json(res, 200, { cancelled: true, runId: run.id });
    return true;
  }

  // ---- P2-4(D4/R1-9):调查事件侧车读回——since 游标增量,≤500 条/响应;空事件回 200+空数组(UI 空态依赖) ----
  const investigationMatch = rest.match(/^\/runs\/([^/]+)\/investigation$/);
  if (method === "GET" && investigationMatch) {
    const store = ctx.storeFor(id);
    // listRuns 反查(仿 gate):run 不存在 → 404
    const run = (await store.listRuns()).find((r) => r.id === investigationMatch[1]);
    if (!run) {
      json(res, 404, { error: `找不到运行: ${investigationMatch[1]}` });
      return true;
    }
    const since = Math.max(0, Number(url.searchParams.get("since") ?? 0) || 0);
    const events = await store.readInvestigation(run.id, since, 500);
    // 问题清单(时间线分组头):最新 gather/plan checkpoint——gates 流 plan 恒落盘;
    // 带 plan 的旧路径首采前无 checkpoint,questions 空(UI 回退展示 qid)
    const cps = await store.checkpoints(run.id);
    const stateCp = cps.findLast((c) => c.stage === "gather") ?? cps.findLast((c) => c.stage === "plan");
    const questions =
      (stateCp?.data as { questions?: Array<{ id: string; question: string; status: string }> } | undefined)?.questions ?? [];
    json(res, 200, { events, questions });
    return true;
  }

  if (method === "POST" && rest === "/publish") {
    json(res, 200, await publishBundle(dir, body.runId, ctx.library));
    return true;
  }

  if (method === "POST" && rest === "/archive") {
    const archived = body.archived !== false;
    const s = ctx.storeFor(id);
    s.saveMeta({ status: archived ? "archived" : "active" });
    s.audit(archived ? "archived" : "unarchived", {});
    json(res, 200, { status: archived ? "archived" : "active" });
    return true;
  }

  // 未知 rest:落回 server.ts(最终 catch-all 404;非法 id 已在上方 projectDir 抛出 500)
  return false;
};
