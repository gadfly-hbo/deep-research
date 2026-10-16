import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Adapters, FetchedPage, ModelProvider } from "../adapters/types.js";
import {
  ResearchResultBundleSchema,
  ResearchRunSchema,
  type Budget,
  type Claim,
  type Evidence,
  type Intervention,
  type ResearchRequest,
  type ResearchResultBundle,
  type ResearchRun,
  type ReportOutline,
  type SourceSnapshot,
} from "../contracts.js";
import { getModuleConfig } from "../modules/registry.js";
import type { ModuleConfig } from "../modules/types.js";
import { tierBudget } from "./budgetTiers.js";
import { checkCalibration } from "../quality/calibrationChecker.js";
import { verifyCitations } from "../quality/citationVerifier.js";
import { evaluatePublishGate } from "../quality/publishGate.js";
import type { LibraryStore } from "../library/types.js";
import type { Checkpoint, ResearchStore } from "../stores/types.js";
import {
  AnalyzeOutputSchema,
  DraftOutputSchema,
  OutlineOutputSchema,
  PlanOutputSchema,
  PolishOutputSchema,
  ReviewOutputSchema,
  coerceDraftOutput,
  type AnalyzeOutput,
  type PlanOutput,
  type PlanQuestion,
} from "./stages.js";
import { emptyState, safeParse, type RunState } from "./runState.js";
import { gather, scanTopupReopen, resetCappedIfToppedUp, type GatherContext } from "./gatherDomain.js";
import { addLimitation } from "./limitations.js";
import { snapshotFrom } from "./snapshotFrom.js";
import { BudgetTracker } from "./budgetTracker.js";
import { attachExtraction } from "./attachExtraction.js";
import { runStageSafe } from "./runStageSafe.js";
import { buildQuestionEvidencePacks } from "./evidencePacks.js";
import type { AgentTool, RunAgentInput } from "../adapters/types.js";
import type { InvestigationEvent } from "../stores/types.js";

/**
 * P2-4(D1):三工具定义——**轮次不变**(R1-1:工具定义只描述能力,预算余量只进任务卡与
 * executor 返回值,不进 description/parameters,防 CONFIGURATION_CHANGED 与录制键漂移)。
 */
export const DEFAULT_BUDGET: Budget = {
  maxSearches: 80,
  maxFetches: 60,
  maxWallMs: 90 * 60_000,
  maxParallel: 4,
};

/** 预算解析:显式 request.budget > 预算档位 > 流水线默认。 */
export function resolveBudget(request: Pick<ResearchRequest, "budget" | "budgetTier">): Budget {
  return {
    ...DEFAULT_BUDGET,
    ...(request.budgetTier ? tierBudget(request.budgetTier) : {}),
    ...request.budget,
  };
}

export interface RunOptions {
  plan?: PlanOutput;
  stopAfter?: "gather";
  signal?: AbortSignal;
  maxLoops?: number;
  moduleConfig?: ModuleConfig;
  runId?: string;
  /** 2.0:共享资产沉淀目标(情报库);缺省=不沉淀,保持一期行为(A-01 空库可研究) */
  library?: LibraryStore;
  /** 2.0:沉淀取得记录所归属的项目 */
  projectId?: string;
  /** 2.1:执行中干预指令源(非阻塞拉取,取走即消费);server 层接落盘队列,测试注入可控序列。 */
  pollInstructions?: () => Intervention[] | Promise<Intervention[]>;
  /**
   * P2-3 确认门开关(D1/KA4):server 传入启用 plan/outline 两道返回式门;
   * CLI/测试缺省不传=旧行为直跑(跳过 plan 门、无 outline 阶段)。
   */
  gates?: { plan: true; outline: true };
  /**
   * P2-5:run 终态落盘后回调(会话摘要写入由 routes/CLI 注入;编排器零会话依赖)。
   * 失败不阻塞 run 结果(catch 吞,DR_DEBUG 由调用方自记)。
   */
  onRunComplete?: (result: RunResult) => Promise<void> | void;
  /** P2-5:既往研究纪要(K≤3,会话 tail 摘要;routes 在起跑前读一次注入)。 */
  sessionDigests?: string[];
  /**
   * P2-6(R1-1):运行中预算注册通道——编排器入口把本 run 的 Budget 对象交给调用方
   * (server 挂 RunRegistry 键空间,加注端点同对象原地变异;KA2:禁引用替换)。
   */
  registerBudget?: (b: Budget) => void;
  /**
   * P2-6(R1-5):问内 refine 即时注入源(filtered take,仅 refine-direction;skip/add
   * 留给问间隙 drain)。返回 null=当前无待注入改道。
   */
  takeRefinement?: () => Intervention | null;
}

export interface RunResult {
  run: ResearchRun;
  bundle: ResearchResultBundle | null;
}

export async function runResearch(
  request: ResearchRequest,
  adapters: Adapters,
  store: ResearchStore,
  options: RunOptions = {},
): Promise<RunResult> {
  const started = Date.now();
  const sessionDigests = options.sessionDigests ?? [];
  const budget: Budget = resolveBudget(request);
  // P2-6(F3):加注到达判据——运行起始预算基线快照;同对象原地变异(KA2)后基线比对可证加注
  const budgetBaseline = {
    maxSearches: budget.maxSearches,
    maxFetches: budget.maxFetches,
    maxWallMs: budget.maxWallMs,
  };
  const wasToppedUp = () =>
    budget.maxSearches > budgetBaseline.maxSearches ||
    budget.maxFetches > budgetBaseline.maxFetches ||
    budget.maxWallMs > budgetBaseline.maxWallMs;
  // P2-6(R1-1):预算注册——tracker/executor 闭包引用同一对象,加注端点原地变异即可生效
  options.registerBudget?.(budget);
  const moduleConfig = options.moduleConfig ?? getModuleConfig(request.module);
  const keyBase = request.id ?? randomUUID();
  const prior = request.id ? await store.findRunByRequestId(request.id) : undefined;
  // P2-3(KA1):awaiting-confirmation 同为可恢复态——门 confirm 重启管线时沿用原 runId/检查点;
  // gates 流程的 launch 预落与 confirm 的 CAS 都会先置 running,凭 gates 认领而非新起 runId
  const resuming =
    prior !== undefined &&
    (prior.status === "cancelled" ||
      prior.status === "awaiting-confirmation" ||
      (prior.status === "running" && options.gates !== undefined));
  const runId = resuming ? prior.id : (options.runId ?? randomUUID());
  const run: ResearchRun = resuming
    ? // P2-3:恢复即清门字段(门身份只活在 awaiting-confirmation 期间)
      { ...prior, status: "running", gate: undefined }
    : {
        id: runId,
        requestId: keyBase,
        stage: "plan",
        status: "running",
        checkpoints: [],
        usage: { searches: 0, fetches: 0, modelCalls: 0, outputTokens: 0, wallMs: 0 },
      };
  const priorCheckpoints = resuming ? await store.checkpoints(runId) : [];
  const completedStages = new Set(priorCheckpoints.map((c) => c.stage));

  // P2-2:模型用量统一累计 wrapper——全部 extractClaims/runStage/runAgent 调用点的 usage 汇入 run 记录
  const model: ModelProvider = {
    extractClaims: async (input, callKey) => {
      const r = await adapters.model.extractClaims(input, callKey);
      run.usage.modelCalls += r.usage.modelCalls;
      run.usage.outputTokens += r.usage.outputTokens;
      return r;
    },
    runStage: async (stage, input, callKey) => {
      const r = await adapters.model.runStage(stage, input, callKey);
      run.usage.modelCalls += r.usage.modelCalls;
      run.usage.outputTokens += r.usage.outputTokens;
      return r;
    },
    // P2-4(R1-2):agent 调用的计量同样过 wrapper;底层通道缺席时不设此键(gather 侧降级)
    ...(adapters.model.runAgent
      ? {
          runAgent: async (input: RunAgentInput, tools: AgentTool[], callKey: string) => {
            const r = await adapters.model.runAgent!(input, tools, callKey);
            run.usage.modelCalls += r.usage.modelCalls;
            run.usage.outputTokens += r.usage.outputTokens;
            return r;
          },
        }
      : {}),
  };

  const state = emptyState();

  // --- 2.1 增量追问:加载基准成果包(固定快照引用,复用而不重采) ---
  const incrementalOf = request.incrementalOf;
  const baseBundle = incrementalOf ? await store.readBundle(incrementalOf.runId) : null;
  if (incrementalOf && !baseBundle) {
    state.limitations.push(`增量基准成果包缺失(${incrementalOf.runId}),本次未复用基准证据,按全量研究执行`);
  }
  const baseSnapshotUrls = new Set<string>(baseBundle?.snapshots.map((s) => s.url) ?? []);
  if (incrementalOf) run.derivedFromRunId = incrementalOf.runId;
  // 2.1:增量 bundle 元数据(两处组装路径共用;延迟求值,newQuestions 以组装时点为准)
  const incrementalBundleFields = () =>
    incrementalOf && baseBundle
      ? {
          derivedFromRunId: incrementalOf.runId,
          reuseSummary: {
            baseRunId: incrementalOf.runId,
            reusedSnapshots: baseBundle.snapshots.length,
            reusedEvidence: baseBundle.evidence.length,
            reusedClaims: baseBundle.claims.length,
            newQuestions: state.questions.length,
          },
        }
      : {};
  /**
   * P2-3(KA5/D2):gates 下增量追问上下文——照 routes 层 resolveIncrementalBase 的输出形状
   * 读基准 checkpoints(已答问题)与成果包(基准框架),直接序列化进 plan/outline 阶段输入。
   */
  const incrementalContext = async (): Promise<
    { answeredQuestions: string[]; baseOutline: ReportOutline | null } | undefined
  > => {
    if (!options.gates || !incrementalOf || !baseBundle) return undefined;
    const cps = await store.checkpoints(incrementalOf.runId);
    const gatherCp = cps.find((c) => c.stage === "gather");
    const planCp = cps.find((c) => c.stage === "plan");
    const questions =
      (gatherCp?.data as { questions?: Array<{ question: string; status: string }> } | undefined)?.questions ??
      (planCp?.data as { questions?: Array<{ question: string; status: string }> } | undefined)?.questions ??
      [];
    return {
      answeredQuestions: questions
        .filter((q) => q.status === "answered" || q.status === "partially")
        .map((q) => q.question),
      baseOutline: baseBundle.outline ?? null,
    };
  };
  for (const cp of priorCheckpoints) {
    if (cp.stage === "plan") {
      state.questions = (cp.data as PlanOutput).questions;
    } else if (cp.stage === "gather") {
      Object.assign(state, cp.data as Partial<RunState>);
    } else if (cp.stage === "analyze") {
      state.findings = (cp.data as AnalyzeOutput).findings;
    } else if (cp.stage === "draft") {
      state.draftMd = (cp.data as { reportMd: string }).reportMd;
    } else if (cp.stage === "polish" && request.polish !== false) {
      // 润色是草稿的子环节:恢复时以润色稿为准(polish checkpoint 后于 draft 落盘);
      // 用户显式关润色则忽略 polish checkpoint,回退草稿原文
      state.draftMd = (cp.data as { reportMd: string }).reportMd;
    }
  }

  const cancelled = () => options.signal?.aborted === true;
  const tracker = new BudgetTracker(budget, () => run.usage, started);
  const saveCp = async (stage: Checkpoint["stage"], data: unknown) => {
    await store.saveCheckpoint({ runId, stage, data, completedAt: new Date().toISOString() });
  };
  const persistRun = async (stage?: ResearchRun["stage"]): Promise<void> => {
    if (stage) run.stage = stage;
    syncProgress();
    await store.saveRun(ResearchRunSchema.parse(run));
  };
  // P2-4(D4):调查事件侧车 writer——追加失败吞错(侧车不杀问,D1)
  const appendInvestigationSafe = async (event: Omit<InvestigationEvent, "seq" | "at">): Promise<void> => {
    try {
      await store.appendInvestigation(runId, event);
    } catch {
      /* 调查侧车失败不影响调查本身 */
    }
  };
  // P2-4(R1-6):executor 内计数即时写 run.usage,落盘按 2s 节流(与调查事件同步活;
  // 窗口自 run 起点计——快测首事件不落盘,保持问边界落盘形状)
  let lastUsagePersistAt = started;
  const persistUsageThrottled = async (): Promise<void> => {
    if (Date.now() - lastUsagePersistAt < 2_000) return;
    lastUsagePersistAt = Date.now();
    await persistRun();
  };
  // P2-4(C4):调查归属映射——qid → 该问抓取过的 sid 集合;共享快照对抓取过它的每个问展开 attach
  const fetchedByQ = new Map<string, Set<string>>();
  const snapshotsBySid = new Map<string, SourceSnapshot>();
  // 2.1:采证进度摘要(当前问题 + 计数),随每次落盘刷新(currentQuestion 已移 gatherCtx)
  const syncProgress = (): void => {
    const qs = state.questions;
    const count = (status: PlanQuestion["status"]) => qs.filter((q) => q.status === status).length;
    run.progress = {
      currentQuestionId: gatherCtx.currentQuestion?.id,
      currentQuestionText: gatherCtx.currentQuestion?.question,
      answered: count("answered") + count("partially"),
      open: count("open") + count("unanswered"),
      skipped: count("skipped"),
      total: qs.length,
    };
  };

  /** P2-5:终态出口统一回调(onRunComplete 失败不阻塞)。 */
  const finishRun = async (result: RunResult): Promise<RunResult> => {
    if (options.onRunComplete) {
      try {
        await options.onRunComplete(result);
      } catch {
        /* 摘要写失败不阻塞 run 结果 */
      }
    }
    return result;
  };

  const cancelRun = async (): Promise<RunResult> => {
    run.status = "cancelled";
    run.usage.wallMs = Date.now() - started;
    syncProgress();
    const finished = ResearchRunSchema.parse(run);
    await store.saveRun(finished);
    return finishRun({ run: finished, bundle: null });
  };

  /**
   * P2-3 返回式门落盘:awaiting-confirmation + gate 身份后返回(R1-1:run.stage 保持 "plan",
   * 门身份由 gate.kind 表达);confirm 重启管线续跑,暂停段不计 wallMs(每次入口重置 startedAt)。
   */
  const saveGate = async (kind: "plan" | "outline"): Promise<RunResult> => {
    run.status = "awaiting-confirmation";
    run.gate = { kind };
    syncProgress();
    const gated = ResearchRunSchema.parse(run);
    await store.saveRun(gated);
    // REVIEW F1:gate 出口非终态(awaiting-confirmation),不写会话摘要——run 完成时的终态出口才写
    return { run: gated, bundle: null };
  };

  // --- 2.0 共享沉淀(U2-02/流程 C):读取成功即留档到情报库,失败只披露不冒充 ---
  const snapshotVersionMap = new Map<string, string>();
  const ingestToLibrary = async (snapshot: SourceSnapshot): Promise<void> => {
    const lib = options.library;
    if (!lib) return;
    const now = new Date().toISOString();
    try {
      const readable = snapshot.parseStatus === "ok" && snapshot.bodyText.trim() !== "";
      let versionId: string;
      let sourceId: string;
      if (readable) {
        const staging = await lib.stageContent(snapshot.bodyText);
        const committed = await lib.commitContent(staging);
        const existing = await lib.findVersionByHash(committed.contentHash);
        if (existing) {
          // 存储层内容去重:同内容复用版本,但本 run 另记一条取得记录(授权不合并)
          versionId = existing.versionId;
          sourceId = existing.sourceId;
        } else {
          sourceId = `s-${randomUUID().slice(0, 8)}`;
          versionId = `sv-${committed.contentHash.slice(0, 12)}`;
          await lib.saveSource({
            sourceId,
            title: snapshot.title || snapshot.url,
            url: snapshot.url,
            docType: "other",
            entityIds: [],
            tags: [],
            lifecycle: "ACTIVE",
            createdAt: now,
          });
          await lib.saveVersion({
            versionId,
            sourceId,
            contentRef: committed.contentRef,
            contentHash: committed.contentHash,
            fetchStatus: "READ_FULL",
            parseStatus: "ok",
            createdAt: now,
          });
        }
      } else {
        sourceId = `s-${randomUUID().slice(0, 8)}`;
        versionId = `sv-${randomUUID().slice(0, 8)}`;
        await lib.saveSource({
          sourceId,
          title: snapshot.title || snapshot.url,
          url: snapshot.url,
          docType: "other",
          entityIds: [],
          tags: [],
          lifecycle: "ACTIVE",
          createdAt: now,
        });
        await lib.saveVersion({
          versionId,
          sourceId,
          fetchStatus: "READ_PARTIAL",
          parseStatus: "failed",
          parseIssue: "研究采证解析失败:正文不可读,仅保留取得事实",
          createdAt: now,
        });
      }
      await lib.saveAcquisition({
        acquisitionId: `aq-${randomUUID().slice(0, 8)}`,
        versionId,
        projectId: options.projectId,
        runId: options.runId,
        acquiredAt: snapshot.fetchedAt,
        recordedAt: now,
        method: "research-fetch",
        readScope: readable ? "READ_FULL" : "READ_PARTIAL",
        reuseScope: "PROJECT_ONLY",
        rights: {},
      });
      snapshotVersionMap.set(snapshot.id, versionId);
    } catch {
      addLimitation(state.limitations, "共享登记失败:部分资料未进入情报库(项目已保存、共享登记待处理)");
    }
  };


  // P2-6(D4/R1-6):gather 域上下文——单对象传引用;数据字段引用装配层闭包变量,
  // 持久化/事件回调以函数字段挂入(gather/applyInstruction/investigationCard/工具构造
  // 已迁 src/core/gatherDomain.ts;三个原 let 转 ctx 字段)
  const gatherCtx: GatherContext = {
    state,
    run,
    budget,
    tracker,
    request,
    moduleConfig,
    keyBase,
    adapters,
    model,
    store,
    baseBundle,
    baseSnapshotUrls,
    sessionDigests,
    snapshotVersionMap,
    fetchedByQ,
    snapshotsBySid,
    directionNotes: [],
    currentQuestion: undefined,
    activeGatherTargets: null,
    addQuestionCounter: 0,
    cancelled,
    ...(options.pollInstructions ? { pollInstructions: options.pollInstructions } : {}),
    ...(options.takeRefinement ? { takeRefinement: options.takeRefinement } : {}),
    wasToppedUp,
    persistRun,
    persistUsageThrottled,
    appendInvestigationSafe,
    ingestToLibrary,
  };
  // 恢复瞬间即落 running:服务端 resume 不再预落记录,可见性由这里兜底(ctx 构造无副作用,位置等价)
  if (resuming) await persistRun();

  // --- plan(恢复时以 gather 检查点内的问题状态为准,不被 options.plan 覆盖)
  if (options.plan && !completedStages.has("gather")) {
    state.questions = options.plan.questions.map((q) => ({ ...q }));
  } else if (options.plan) {
    // 已完成 gather 的恢复路径:问题状态来自检查点
  } else if (!completedStages.has("plan")) {
    if (cancelled()) return cancelRun();
    if (tracker.overBudget()) {
      state.capped = true;
    } else {
      // P2-3(KA5):gates 下的增量追问把基准已答问题注入 plan 输入,只为新问题生成计划
      const incremental = await incrementalContext();
      const res = await model.runStage(
        "plan",
        {
          goal: request.goal,
          scope: request.scope,
          questionFramework: moduleConfig.questionFramework,
          // P2-6 T3(F4):followup 首跑注入既往研究纪要(与任务卡同口径;只在此处直调)
          ...(sessionDigests.length ? { sessionDigests: sessionDigests.slice(0, 3) } : {}),
          ...(incremental
            ? {
                incremental: {
                  answeredQuestions: incremental.answeredQuestions,
                  newQuestionBudget: 6,
                  note: "只为追问生成新问题,不重复基准研究已回答的问题",
                },
              }
            : {}),
        },
        `${keyBase}:plan:0`,
      );
      const plan = safeParse(
        PlanOutputSchema,
        res.output,
        () => ({
          questions: request.scope.queries.map((q, i) => ({ id: `q${i + 1}`, question: q, status: "open" as const })),
        }),
        "计划输出不合格,已退回范围种子问题",
        state,
      );
      // R1-8:增量追问 6 问上限(与预览端点同款截断)
      if (incremental && plan.questions.length > 6) plan.questions = plan.questions.slice(0, 6);
      state.questions = plan.questions;
      await saveCp("plan", plan);
      if (options.gates?.plan) return saveGate("plan");
    }
  } else {
    // P2-3(KA1):plan checkpoint append-only(confirm 追加编辑版),恢复取最新一版
    const planCp = priorCheckpoints.findLast((c) => c.stage === "plan");
    if (planCp) state.questions = (planCp.data as PlanOutput).questions;
  }

  // --- P2-3 outline 阶段(gates 下新增,plan 门确认后执行):输入=已确认问题(+增量上下文),
  // 产出后落 outline 门返回;request.outline 已有(旧路径/outline 门确认后)则整段跳过
  if (options.gates?.outline && !request.outline) {
    if (cancelled()) return cancelRun();
    const incremental = await incrementalContext();
    const res = await model.runStage(
      "outline",
      {
        goal: request.goal,
        scope: request.scope,
        questions: state.questions.map((q) => q.question),
        reportTemplate: moduleConfig.reportTemplate,
        ...(incremental
          ? {
              incremental: {
                baseOutline: incremental.baseOutline,
                answeredQuestions: incremental.answeredQuestions,
                note: "基于基准研究框架生成增量框架:保留原有章节,标注新问题章节的插入位置",
              },
            }
          : {}),
      },
      `${keyBase}:outline:0`,
    );
    const outline = safeParse(
      OutlineOutputSchema,
      res.output,
      () => ({ title: request.goal, sections: [{ id: "s1", title: "正文", bullets: [] }] }),
      "框架输出不合格,已退回单章节框架",
      state,
    );
    await saveCp("outline", outline);
    return saveGate("outline");
  }

  // --- 2.1 增量注入:基准证据/主张/快照原样并入(固定引用),限制沿用并披露采录时点 ---
  if (baseBundle) {
    const lastFetchedAt = baseBundle.snapshots.reduce((m, s) => (s.fetchedAt > m ? s.fetchedAt : m), "");
    for (const s of baseBundle.snapshots) {
      if (!state.snapshots.some((x) => x.id === s.id)) state.snapshots.push(s);
    }
    for (const e of baseBundle.evidence) {
      if (!state.evidence.some((x) => x.id === e.id)) state.evidence.push(e);
    }
    for (const c of baseBundle.claims) {
      if (!state.claims.some((x) => x.id === c.id)) {
        state.claims.push(c);
        state.claimQuestions[c.id] = "base";
      }
    }
    for (const l of baseBundle.limitations) {
      addLimitation(state.limitations, `基准研究限制沿用:${l}`);
    }
    addLimitation(state.limitations, `延续证据采录于 ${lastFetchedAt || "未知时点"} 之前,时间口径未重新核验`);
  }

  // 2.1:增量研究报告标注(头部注记 + 基准主张复用标记)
  const incrementalNote = (): string[] =>
    incrementalOf && baseBundle
      ? [
          `> 增量研究:基于 ${incrementalOf.runId} 追问扩展;复用快照 ${baseBundle.snapshots.length} / 证据 ${baseBundle.evidence.length} / 主张 ${baseBundle.claims.length},本次新问 ${state.questions.length}`,
        ]
      : [];
  const claimMark = (claim: Claim): string =>
    state.claimQuestions[claim.id] === "base" ? "|基准复用" : "";


  // --- gather(附件先入证据链,再按问题采证)
  if (!completedStages.has("gather")) {
    if (cancelled()) return cancelRun();
    await persistRun("gather");
    for (let ai = 0; ai < request.attachments.length; ai++) {
      if (cancelled()) return cancelRun();
      const path = request.attachments[ai];
      const buf = await readFile(path);
      const isPdf = path.toLowerCase().endsWith(".pdf");
      const page: FetchedPage = {
        url: `file://${path}`,
        status: 200,
        contentType: isPdf ? "application/pdf" : "text/plain",
        ...(isPdf ? { pdf: new Uint8Array(buf) } : { text: buf.toString("utf8") }),
      };
      const doc = await adapters.parser.parse(page, `${keyBase}:gather:attach:parse:${ai}`);
      const snapshot = snapshotFrom({
        id: `snap:attachment:${path}`,
        url: page.url,
        title: path.split("/").pop() ?? path,
        bodyText: doc.bodyText,
        parseStatus: doc.parseStatus,
        contentType: page.contentType,
        // 用户提供的本机资料视为一手来源
        tier: "A",
      });
      await store.saveSnapshot(snapshot);
      await ingestToLibrary(snapshot);
      state.snapshots.push(snapshot);
      const extracted = await model.extractClaims(
        { snapshot },
        `${keyBase}:gather:attach:model:${ai}`,
      );
      attachExtraction(state, snapshot, extracted, {
        kind: "attachments",
        versionId: snapshotVersionMap.get(snapshot.id),
      });
    }
    // --- 2.0 复用输入(§5.2/§10.2):绑定资产的正文作为候选证据进入上下文;线索只记录不注入 ---
    if (options.library && options.runId) {
      const lib = options.library;
      const bindings = await lib.bindingsForRun(options.runId);
      for (const binding of bindings) {
        if (cancelled()) return cancelRun();
        const version = await lib.getVersion(binding.versionId);
        const source = version ? await lib.getSource(version.sourceId) : null;
        if (!version || !source) continue;
        if (
          binding.applicability === "LEAD_ONLY" ||
          binding.applicability === "FORBIDDEN" ||
          binding.applicability === "NOT_APPLICABLE"
        ) {
          await lib.saveUsage({
            usageId: `u-${randomUUID().slice(0, 8)}`,
            runId: options.runId,
            bindingId: binding.bindingId,
            step: "lead",
            contentVersionId: binding.versionId,
            usedAt: new Date().toISOString(),
          });
          continue;
        }
        // S-03/S-02:外发门禁只看本运行项目/属主直录/已显式升档到工作台复用的取得记录,
        // 不允许受限项目借用其他项目取得记录上的外发许可(§9.3)
        const bindAcquisitions = await lib.acquisitionsForVersion(binding.versionId);
        const canSendExternal = bindAcquisitions.some(
          (a) =>
            a.rights.sendToExternalModel === true &&
            (a.projectId === options.projectId ||
              a.projectId === undefined ||
              a.reuseScope === "WORKSPACE_REUSABLE"),
        );
        if (!canSendExternal) {
          state.limitations.push(
            `复用资产「${source.title}」未授权向外部模型发送正文:本次仅保留绑定与线索,未注入模型上下文`,
          );
          await lib.saveUsage({
            usageId: `u-${randomUUID().slice(0, 8)}`,
            runId: options.runId,
            bindingId: binding.bindingId,
            step: "blocked-external",
            contentVersionId: binding.versionId,
            usedAt: new Date().toISOString(),
          });
          continue;
        }
        const content = version.contentRef ? await lib.readContent(version.contentRef) : null;
        if (!content) {
          state.limitations.push(`复用资产正文不可读(${source.title}),已按缺口保留绑定`);
          continue;
        }
        const snapshot = snapshotFrom({
          id: `snap:lib:${binding.versionId}`,
          url: source.url ?? `library://${source.sourceId}`,
          title: source.title,
          bodyText: content,
          parseStatus: "ok",
          contentType: "text/plain",
          tier: source.docType === "research-report" ? "C" : "B",
        });
        if (!state.snapshots.some((s) => s.id === snapshot.id)) state.snapshots.push(snapshot);
        await store.saveSnapshot(snapshot);
        const extracted = await model.extractClaims(
          { snapshot },
          `${keyBase}:gather:reuse:${binding.bindingId}`,
        );
        attachExtraction(state, snapshot, extracted, {
          kind: "reuse",
          bindingId: binding.bindingId,
          versionId: binding.versionId,
          revisions: binding.evidenceRevisions,
          // 复用证据带适用范围说明,防止样本边界被抹平(A-05/A-18)
          scopeNote: binding.checkNotes.join(";") || undefined,
        });
        await lib.saveUsage({
          usageId: `u-${randomUUID().slice(0, 8)}`,
          runId: options.runId,
          bindingId: binding.bindingId,
          step: "gather",
          contentVersionId: binding.versionId,
          usedAt: new Date().toISOString(),
        });
      }
    }

    await gather(gatherCtx, 0);
    if (cancelled()) return cancelRun();
    await saveCp("gather", { ...state });
    // P2-6(F3):发布门评估前的加注评估窗——采证后到达的加注在此同款复位+重开补采
    const lateReopened = scanTopupReopen(gatherCtx);
    if (lateReopened.length > 0) {
      await gather(gatherCtx, 2, lateReopened);
      if (cancelled()) return cancelRun();
      await saveCp("gather", { ...state });
    }
    if (options.stopAfter === "gather") {
      const verdicts = verifyCitations(state.evidence, state.snapshots);
      run.stage = "publish";
      run.status = state.capped ? "limited" : "published";
      const limitations = [
        ...(state.capped
          ? [
              `预算上限到达(搜索 ${run.usage.searches}/${budget.maxSearches},抓取 ${run.usage.fetches}/${budget.maxFetches});未覆盖部分不作结论`,
            ]
          : []),
        ...state.limitations,
      ];
      const incrementalNoteLines = incrementalNote();
      const reportMd = [
        `# ${request.goal}`,
        "",
        ...incrementalNoteLines,
        ...(incrementalNoteLines.length ? [""] : []),
        `范围:${request.scope.summary}`,
        "",
        "## 主张与证据判定",
        ...state.claims.map(
          (claim, i) => `- [${claim.kind}${claimMark(claim)} / ${verdicts[i]?.verdict ?? "snapshot-missing"}] ${claim.statement}`,
        ),
        "",
        ...(limitations.length ? ["## 限制", ...limitations.map((l) => `- ${l}`), ""] : []),
      ].join("\n");
      const bundle = ResearchResultBundleSchema.parse({
        runId,
        version: 0,
        reportMd,
        claims: state.claims,
        evidence: state.evidence,
        snapshots: state.snapshots,
        limitations,
        unresolved: state.unresolved,
        verdicts,
        ...incrementalBundleFields(),
      });
      run.usage.wallMs = Date.now() - started;
      const finished = ResearchRunSchema.parse(run);
      await store.saveRun(finished);
      await store.saveBundle(bundle);
      return finishRun({ run: finished, bundle });
    }
  }

  // --- analyze(含缺口补证一轮)
  if (!completedStages.has("analyze")) {
    if (cancelled()) return cancelRun();
    await persistRun("analyze");
    if (tracker.overBudget()) {
      state.capped = true;
    } else {
      const analyze = await runStageSafe({
        call: () =>
          model.runStage(
            "analyze",
            { goal: request.goal, questions: state.questions, claims: state.claims },
            `${keyBase}:analyze:0`,
          ),
        schema: AnalyzeOutputSchema,
        fallback: () => ({ findings: [], gaps: [] }),
        limitation: "分析输出不合格,发现清单置空",
        state,
        apply: (a) => {
          state.findings = a.findings;
        },
      });
      // P2-6b(r4-2):模型输出的重复 questionId 去重——重复目标会在同轮被调查两遍并清除已产主张
      const seenGap = new Set<string>();
      const gapQuestions = analyze.gaps
        .map((g) => state.questions.find((q) => q.id === g.questionId))
        .filter((q): q is PlanQuestion => q !== undefined && q.status !== "answered")
        .filter((q) => {
          if (seenGap.has(q.id)) return false;
          seenGap.add(q.id);
          return true;
        });
      if (gapQuestions.length > 0) {
        await gather(gatherCtx, 1, gapQuestions);
        if (cancelled()) return cancelRun();
      }
      await saveCp("analyze", analyze);
    }
  }

  // 报告丰满度:writer 素材包(引句上下文窗口)。纯函数现算,regather 后快照集已变,不缓存。
  const evidencePacks = () =>
    buildQuestionEvidencePacks({
      questions: state.questions,
      claims: state.claims,
      evidence: state.evidence,
      snapshots: state.snapshots,
      claimQuestions: state.claimQuestions,
    });

  // --- draft
  if (!completedStages.has("draft")) {
    if (cancelled()) return cancelRun();
    await persistRun("draft");
    if (tracker.overBudget()) {
      state.capped = true;
    } else {
      const draft = await runStageSafe({
        call: () =>
          model.runStage(
            "draft",
            {
              goal: request.goal,
              scope: request.scope,
              findings: state.findings,
              claims: state.claims,
              evidencePacks: evidencePacks(),
              reportTemplate: moduleConfig.reportTemplate,
              ...(request.outline ? { outline: request.outline } : {}),
            },
            `${keyBase}:draft:0`,
          ),
        schema: DraftOutputSchema,
        coerce: coerceDraftOutput,
        fallback: () => ({ reportMd: `# ${request.goal}\n\n(草稿生成失败,以下为证据清单摘要)` }),
        limitation: "草稿输出不合格,已降级为证据摘要草稿",
        state,
        apply: (d) => {
          state.draftMd = d.reportMd;
        },
      });
      await saveCp("draft", { reportMd: state.draftMd });
    }
  }

  // --- polish(润色/扩写:只丰富表达与结构,严禁新增无证据事实;run 选项可关)
  // P2-6(F3):analyze/draft 窗口的加注评估点——复位 capped,恢复 polish 回环(问题重开只在 gather 窗口)
  resetCappedIfToppedUp({ state, tracker, budget, run, wasToppedUp });
  if (request.polish !== false && state.draftMd && !state.capped && !completedStages.has("polish")) {
    if (cancelled()) return cancelRun();
    await persistRun("draft");
    if (tracker.overBudget()) {
      state.capped = true;
    } else {
      const res = await model.runStage(
        "polish",
        {
          goal: request.goal,
          draftMd: state.draftMd,
          findings: state.findings,
          claims: state.claims,
          evidencePacks: evidencePacks(),
        },
        `${keyBase}:polish:0`,
      );
      const polished = safeParse(
        PolishOutputSchema,
        coerceDraftOutput(res.output),
        () => ({ reportMd: state.draftMd! }),
        "润色输出不合格,沿用草稿原文",
        state,
      );
      state.draftMd = polished.reportMd;
      await saveCp("polish", { reportMd: state.draftMd });
    }
  }

  // --- review + 修复回环(缺口补证 / 反例检查 / 受影响内容复核)
  const maxLoops = options.maxLoops ?? 2;
  // P2-6(F3):同款加注评估点——复位 capped,恢复 review 回环
  resetCappedIfToppedUp({ state, tracker, budget, run, wasToppedUp });
  if (!completedStages.has("review") && !state.capped) {
    await persistRun("review");
    let loopsUsed = 0;
    for (;;) {
      if (cancelled()) return cancelRun();
      if (tracker.overBudget()) {
        state.capped = true;
        break;
      }
      const preVerdicts = verifyCitations(state.evidence, state.snapshots);
      const preConflicts = checkCalibration(state.claims);
      const res = await model.runStage(
        "review",
        {
          goal: request.goal,
          draftMd: state.draftMd,
          verdicts: preVerdicts,
          conflicts: preConflicts,
          questions: state.questions,
          qualityRules: moduleConfig.sourceStrategy.validationRules,
        },
        `${keyBase}:review:${loopsUsed}`,
      );
      const review = safeParse(
        ReviewOutputSchema,
        res.output,
        () => ({ issues: [], counterexampleChecked: false }),
        "评审输出不合格,反例检查按未完成处理",
        state,
      );
      state.counterexampleChecked = review.counterexampleChecked;
      const highs = review.issues.filter((i) => i.severity === "high");
      let fixedAny = false;
      // P2-6b(r4-2):同 targetQuestionId 的多条 regather issue 只补采一次(模型输出可含重复 id)
      const seenRegather = new Set<string>();
      if (loopsUsed < maxLoops) {
        for (const issue of highs) {
          if (issue.fix === "regather" && issue.targetQuestionId) {
            const q = state.questions.find((x) => x.id === issue.targetQuestionId);
            // 2.1:用户显式跳过的问题不被评审修复复活
            if (q && q.status !== "skipped" && !seenRegather.has(q.id)) {
              seenRegather.add(q.id);
              q.status = "open";
              await gather(gatherCtx, 10 + loopsUsed, [q]);
              fixedAny = true;
            }
          } else if (issue.fix === "rephrase") {
            const d = await model.runStage(
              "draft",
              {
                goal: request.goal,
                scope: request.scope,
                findings: state.findings,
                claims: state.claims,
                evidencePacks: evidencePacks(),
                ...(request.outline ? { outline: request.outline } : {}),
              },
              `${keyBase}:draft:fix${loopsUsed}`,
            );
            // 不用硬 parse:一次不合格的重写输出不该炸掉整个 run;失败保留原草稿并披露
            const rewritten = safeParse(
              DraftOutputSchema,
              coerceDraftOutput(d.output),
              () => ({ reportMd: state.draftMd! }),
              "评审重写输出不合格,保留原草稿",
              state,
            );
            state.draftMd = rewritten.reportMd;
            fixedAny = true;
          } else if (issue.fix === "disclose") {
            state.limitations.push(issue.detail);
            fixedAny = true;
          }
        }
      }
      loopsUsed += 1;
      if (!fixedAny || loopsUsed > maxLoops) {
        await saveCp("review", { ...review, loopsUsed });
        break;
      }
    }
  }

  // --- publish 门禁(纯函数,见 src/quality/publishGate.ts;编排器只做机械写回)
  run.stage = "publish";
  const gate = evaluatePublishGate({
    claims: state.claims,
    evidence: state.evidence,
    snapshots: state.snapshots,
    questions: state.questions,
    claimQuestions: state.claimQuestions,
    draftMd: state.draftMd,
    capped: state.capped,
    counterexampleChecked: state.counterexampleChecked,
    limitations: state.limitations,
    goal: request.goal,
    moduleConfig,
    incremental:
      incrementalOf && baseBundle
        ? {
            baseRunId: incrementalOf.runId,
            reusedSnapshots: baseBundle.snapshots.length,
            reusedEvidence: baseBundle.evidence.length,
            reusedClaims: baseBundle.claims.length,
            newQuestions: state.questions.length,
          }
        : undefined,
  });
  state.claims = gate.claims;
  state.limitations.push(...gate.limitationsToAppend);
  state.unresolved = gate.unresolved;
  run.status = gate.status;
  const reportMd = gate.reportMd;
  const verdicts = gate.verdicts;

  const bundle = ResearchResultBundleSchema.parse({
    runId,
    version: 0,
    reportMd,
    claims: state.claims,
    evidence: state.evidence,
    snapshots: state.snapshots,
    limitations: state.limitations,
    unresolved: state.unresolved,
    verdicts,
    ...(request.outline ? { outline: request.outline } : {}),
    ...incrementalBundleFields(),
  });
  run.usage.wallMs = Date.now() - started;
  const finished = ResearchRunSchema.parse(run);
  await store.saveRun(finished);
  await store.saveBundle(bundle);
  return finishRun({ run: finished, bundle });
}
