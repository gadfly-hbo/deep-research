import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
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
import { OutlineOutputSchema, PlanOutputSchema, type PlanOutput } from "../../core/stages.js";
import type { AssetBinding } from "../../library/contracts.js";
import { bindAssets } from "../../library/reuse.js";
import { getModuleConfig } from "../../modules/registry.js";
import { FsProjectStore } from "../../stores/fsStore.js";
import { json, PROJECT_ID, type Ctx } from "./http.js";
import { handleVersionRoutes } from "./versions.js";

// P1-3 T2:projectsRuns 域(附录 A 第 1–12 项)。HTTP 行为与拆分前逐位一致。
// T5:Ctx 已迁至 routes/http.ts(D2 启动级单例)。

const IncrementalRefSchema = z.object({ runId: z.string().min(1), requestId: z.string().min(1) });

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
 */
const startPipeline = (
  ctx: Ctx,
  dir: string,
  request: ResearchRequest,
  options: RunOptions,
  onFailure: (error: unknown) => Promise<void>,
): void => {
  const controller = ctx.registry.acquire(request.id ?? "");
  void runOnProject(dir, request, ctx.makeAdapters(), { ...options, signal: controller.signal })
    .catch(onFailure)
    .finally(() => {
      ctx.registry.release(request.id ?? "");
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
      library: ctx.library,
      projectId: id,
      pollInstructions: drainAndPersist(ctx, runId, dir),
    },
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

  if (method === "POST" && rest === "/plan-preview") {
    const cfg = getModuleConfig(body.module ?? ctx.storeFor(id).meta().module);
    // 2.1 增量追问:基准必须是本项目已完成的 run,预览只为新问题生成计划
    let base: { runId: string; summary: Record<string, unknown>; answeredQuestions: string[] } | undefined;
    if (body.incrementalOf !== undefined) {
      const resolved = await resolveIncrementalBase(ctx.storeFor(id), body.incrementalOf);
      if ("error" in resolved) {
        json(res, resolved.status, { error: resolved.error });
        return true;
      }
      base = resolved.base;
    }
    const result = await ctx
      .makeAdapters()
      .model.runStage(
        "plan",
        {
          goal: body.goal,
          scope: body.scope,
          questionFramework: cfg.questionFramework,
          ...(base
            ? {
                incremental: {
                  answeredQuestions: base.answeredQuestions,
                  newQuestionBudget: 6,
                  note: "只为追问生成新问题,不重复基准研究已回答的问题",
                },
              }
            : {}),
        },
        `plan-preview:${id}:${Date.now()}`,
      );
    const plan = PlanOutputSchema.parse(result.output);
    if (base && plan.questions.length > 6) plan.questions = plan.questions.slice(0, 6);
    json(res, 200, { plan, usage: result.usage, ...(base ? { base: base.summary } : {}) });
    return true;
  }

  if (method === "POST" && rest === "/outline-preview") {
    const cfg = getModuleConfig(body.module ?? ctx.storeFor(id).meta().module);
    let base: { runId: string; summary: Record<string, unknown>; answeredQuestions: string[]; outline: unknown } | undefined;
    if (body.incrementalOf !== undefined) {
      const resolved = await resolveIncrementalBase(ctx.storeFor(id), body.incrementalOf);
      if ("error" in resolved) {
        json(res, resolved.status, { error: resolved.error });
        return true;
      }
      base = resolved.base;
    }
    const result = await ctx
      .makeAdapters()
      .model.runStage(
        "outline",
        {
          goal: body.goal,
          scope: body.scope,
          questions: Array.isArray(body.questions) ? body.questions : [],
          reportTemplate: cfg.reportTemplate,
          ...(base
            ? {
                incremental: {
                  baseOutline: base.outline ?? null,
                  answeredQuestions: base.answeredQuestions,
                  note: "基于基准研究框架生成增量框架:保留原有章节,标注新问题章节的插入位置",
                },
              }
            : {}),
        },
        `outline-preview:${id}:${Date.now()}`,
      );
    json(res, 200, { outline: OutlineOutputSchema.parse(result.output), usage: result.usage, ...(base ? { base: base.summary } : {}) });
    return true;
  }

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
    const started = await launchRun(ctx, id, dir, request, body.plan, body.selectedAssets);
    json(res, 200, { started: true, requestId: started.requestId, reuse: started.reuse });
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
    const plan: PlanOutput = {
      questions: request.scope.queries.map((q, i) => ({ id: `q${i + 1}`, question: q, status: "open" })),
    };
    const started = await launchRun(ctx, id, dir, request, plan);
    json(res, 200, { started: true, requestId: started.requestId, reuse: started.reuse });
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
