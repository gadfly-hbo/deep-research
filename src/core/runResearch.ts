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
  type SourceSnapshot,
} from "../contracts.js";
import { getModuleConfig } from "../modules/registry.js";
import type { ModuleConfig } from "../modules/types.js";
import { tierBudget } from "./budgetTiers.js";
import { checkCalibration } from "../quality/calibrationChecker.js";
import { verifyCitations } from "../quality/citationVerifier.js";
import { evaluatePublishGate } from "../quality/publishGate.js";
import { tierOfSource } from "../quality/sourceTier.js";
import type { LibraryStore } from "../library/types.js";
import type { Checkpoint, ResearchStore } from "../stores/types.js";
import {
  AnalyzeOutputSchema,
  DraftOutputSchema,
  PlanOutputSchema,
  PolishOutputSchema,
  ReviewOutputSchema,
  coerceDraftOutput,
  type AnalyzeOutput,
  type PlanOutput,
  type PlanQuestion,
} from "./stages.js";
import { emptyState, safeParse, type RunState } from "./runState.js";
import { addLimitation } from "./limitations.js";
import { snapshotFrom } from "./snapshotFrom.js";
import { BudgetTracker } from "./budgetTracker.js";
import { attachExtraction, attachGatherExtraction } from "./attachExtraction.js";
import { runStageSafe } from "./runStageSafe.js";
import { buildQuestionEvidencePacks } from "./evidencePacks.js";

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
  const budget: Budget = resolveBudget(request);
  const moduleConfig = options.moduleConfig ?? getModuleConfig(request.module);
  const keyBase = request.id ?? randomUUID();
  const prior = request.id ? await store.findRunByRequestId(request.id) : undefined;
  // P2-3(KA1):awaiting-confirmation 同为可恢复态——门 confirm 重启管线时沿用原 runId/检查点
  const resuming =
    prior !== undefined && (prior.status === "cancelled" || prior.status === "awaiting-confirmation");
  const runId = resuming ? prior.id : (options.runId ?? randomUUID());
  const run: ResearchRun = resuming
    ? { ...prior, status: "running" }
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

  // P2-2:模型用量统一累计 wrapper——全部 extractClaims/runStage 调用点的 usage 汇入 run 记录
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
  // 2.1:采证进度摘要(当前问题 + 计数),随每次落盘刷新
  let currentQuestion: PlanQuestion | undefined;
  const syncProgress = (): void => {
    const qs = state.questions;
    const count = (status: PlanQuestion["status"]) => qs.filter((q) => q.status === status).length;
    run.progress = {
      currentQuestionId: currentQuestion?.id,
      currentQuestionText: currentQuestion?.question,
      answered: count("answered") + count("partially"),
      open: count("open") + count("unanswered"),
      skipped: count("skipped"),
      total: qs.length,
    };
  };

  const cancelRun = async (): Promise<RunResult> => {
    run.status = "cancelled";
    run.usage.wallMs = Date.now() - started;
    syncProgress();
    const finished = ResearchRunSchema.parse(run);
    await store.saveRun(finished);
    return { run: finished, bundle: null };
  };

  // 恢复瞬间即落 running:服务端 resume 不再预落记录,可见性由这里兜底
  if (resuming) await persistRun();

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

  const gather = async (round: number, targets?: PlanQuestion[]): Promise<void> => {
    const questions = targets ?? state.questions.filter((q) => q.status === "open");
    activeGatherTargets = questions;
    try {
    for (let qIdx = 0; qIdx < questions.length; qIdx++) {
      const q = questions[qIdx];
      // 2.1:被用户跳过的问题(含指令指向的后续问题)不再采证,状态不被覆盖
      if (q.status === "skipped") continue;
      currentQuestion = q;
      if (cancelled()) return;
      // 2.1:问题间隙消费干预指令(跳过当前问题则直接进下一问)
      if (await consumeInstructions()) continue;
      if (!tracker.canSearch()) {
        state.capped = true;
        if (q.status === "open") q.status = "unanswered";
        continue;
      }
      // 补采/重采前清掉该问题的旧主张与证据,受影响分支被重算
      const staleClaimIds = state.claims
        .filter((c) => state.claimQuestions[c.id] === q.id)
        .map((c) => c.id);
      state.claims = state.claims.filter((c) => state.claimQuestions[c.id] !== q.id);
      state.evidence = state.evidence.filter((e) => !e.id.startsWith(`ev:${q.id}:`));
      for (const cid of staleClaimIds) delete state.claimQuestions[cid];

      const query = directionNotes.length
        ? `${q.question} ${directionNotes.map((n) => `(${n})`).join(" ")}`
        : q.question;
      const hitsAll = await adapters.search.search(
        query,
        `${keyBase}:gather:r${round}:search:${q.id}`,
      );
      run.usage.searches += 1;
      // 2.1 增量:基准已有快照的 URL 直接复用旧证据,不重抓不重抽
      const hits = hitsAll.filter((h) => !baseSnapshotUrls.has(h.url));
      const reusedBaseHits = hitsAll.length - hits.length;
      let fetchedAny = false;
      let claimsForQ = 0;
      // 抓取配额按剩余问题均分,避免首个问题独占预算导致其余问题颗粒无收
      const remainingQuestions = questions.length - qIdx;
      const perQuestion = tracker.fetchQuota(remainingQuestions);
      let fetchedForQ = 0;
      for (let i = 0; i < hits.length && fetchedForQ < perQuestion; i += budget.maxParallel) {
        if (cancelled()) return;
        const chunk = hits.slice(i, i + budget.maxParallel);
        const room = tracker.fetchRoom(perQuestion, fetchedForQ);
        if (room <= 0 || tracker.overBudget()) {
          state.capped = true;
          break;
        }
        const take = chunk.slice(0, room);
        if (tracker.shouldCapOnTake(take.length)) state.capped = true;
        const produced = await Promise.all(
          take.map(async (hit, j) => {
            const n = `${q.id}:${i + j}`;
            const page = await adapters.page.fetch(hit.url, `${keyBase}:gather:r${round}:fetch:${n}`);
            const doc = await adapters.parser.parse(page, `${keyBase}:gather:r${round}:parse:${n}`);
            const snapshot = snapshotFrom({
              id: `snap:${hit.url}`,
              url: hit.url,
              // 网页自身标题最准(搜索接口的 title 偶发缺省/碎片);两者皆缺时展示层回退 URL
              title: doc.title || hit.title || hit.url,
              bodyText: doc.bodyText,
              parseStatus: doc.parseStatus,
              contentType: page.contentType,
              tier: tierOfSource(hit.url, moduleConfig.sourceStrategy.preferredDomains),
            });
            await store.saveSnapshot(snapshot);
            await ingestToLibrary(snapshot);
            const extracted = await model.extractClaims(
              { snapshot },
              `${keyBase}:gather:r${round}:model:${n}`,
            );
            return { snapshot, extracted };
          }),
        );
        run.usage.fetches += take.length;
        fetchedForQ += take.length;
        for (const { snapshot, extracted } of produced) {
          fetchedAny = true;
          // 2.0:证据绑定情报库来源版本,提取核验待评审确认
          claimsForQ += attachGatherExtraction(state, snapshot, extracted, q.id, snapshotVersionMap.get(snapshot.id));
        }
      }
      q.status =
        claimsForQ > 0
          ? state.capped
            ? "partially"
            : "answered"
          : fetchedAny
            ? "partially"
            : "unanswered";
      // 2.1 增量:检索命中全部为基准已采信源(未重复采证)的问题如实披露
      // (入 limitations 而非 unresolved——主路径组装时会重写 unresolved)
      if (q.status === "unanswered" && reusedBaseHits > 0 && hits.length === 0) {
        addLimitation(
          state.limitations,
          `问题「${q.question}」的检索命中均为基准研究已采信源,本次未重复采证;答案可能存在于延续证据中`,
        );
      }
      await persistRun();
    }
    } finally {
      activeGatherTargets = null;
      currentQuestion = undefined;
    }
  };

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
      const res = await model.runStage(
        "plan",
        { goal: request.goal, scope: request.scope, questionFramework: moduleConfig.questionFramework },
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
      state.questions = plan.questions;
      await saveCp("plan", plan);
    }
  } else {
    // P2-3(KA1):plan checkpoint append-only(confirm 追加编辑版),恢复取最新一版
    const planCp = priorCheckpoints.findLast((c) => c.stage === "plan");
    if (planCp) state.questions = (planCp.data as PlanOutput).questions;
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

  // --- 2.1 执行中干预:问题间隙消费指令,不打断进行中的调用 ---
  const directionNotes: string[] = [];
  let activeGatherTargets: PlanQuestion[] | null = null;
  let addQuestionCounter = 0;

  /** 应用一条指令;返回 true 表示当前问题被跳过(调用方应 continue)。 */
  const applyInstruction = async (pending: Intervention): Promise<boolean> => {
    const ins = pending.instruction;
    const finish = (effect: "applied" | "invalid" | "failed", detail?: string): false => {
      pending.consumedAt = new Date().toISOString();
      pending.effect = effect;
      if (detail) pending.detail = detail;
      (run.interventions ??= []).push(pending);
      return false;
    };
    if (ins.type === "skip-question") {
      const target = ins.questionId ? state.questions.find((q) => q.id === ins.questionId) : currentQuestion;
      if (!target) return finish("invalid", "找不到目标问题");
      if (target.status === "answered" || target.status === "partially") {
        return finish("invalid", `问题 ${target.id} 已回答(${target.status}),不可跳过`);
      }
      target.status = "skipped";
      const skipNote = `问题被用户跳过:${target.question}`;
      if (!state.unresolved.includes(skipNote)) state.unresolved.push(skipNote);
      const skippedCurrent = target === currentQuestion;
      finish("applied", `问题 ${target.id} 已跳过`);
      return skippedCurrent;
    }
    if (ins.type === "add-questions") {
      ins.questions.forEach((text) => {
        addQuestionCounter += 1;
        const q: PlanQuestion = { id: `q-ins-${addQuestionCounter}`, question: text, status: "open" };
        state.questions.push(q);
        activeGatherTargets?.push(q);
      });
      return finish("applied", `新增 ${ins.questions.length} 个问题`);
    }
    if (ins.type === "refine-direction") {
      directionNotes.push(ins.note);
      return finish("applied", "方向附注已注入剩余问题的搜索");
    }
    // add-source:挂到当前问题(或最相关 open 问题),失败不中断
    const host = currentQuestion ?? state.questions.find((q) => q.status === "open");
    if (!host) return finish("invalid", "没有可挂接的开放问题");
    try {
      let snapshot: SourceSnapshot;
      if (ins.url) {
        // 2.1:同 URL 已有快照直接复用,避免覆盖项目级快照正文导致旧证据引文漂移
        const existing = state.snapshots.find((s) => s.url === ins.url);
        if (existing) {
          snapshot = existing;
        } else {
          const page = await adapters.page.fetch(ins.url, `${keyBase}:instruct:fetch:${pending.id}`);
          if (page.status !== 200) throw new Error(`HTTP ${page.status}`);
          const doc = await adapters.parser.parse(page, `${keyBase}:instruct:parse:${pending.id}`);
          snapshot = snapshotFrom({
            id: `snap:${ins.url}`,
            url: ins.url,
            title: ins.title ?? ins.url,
            bodyText: doc.bodyText,
            parseStatus: doc.parseStatus,
            contentType: page.contentType,
          });
        }
      } else {
        snapshot = snapshotFrom({
          id: `snap:user-text:${pending.id}`,
          url: `user-text://${pending.id}`,
          title: ins.title ?? "用户补充材料",
          bodyText: ins.text ?? "",
          parseStatus: "ok",
          contentType: "text/plain",
        });
      }
      await store.saveSnapshot(snapshot);
      await ingestToLibrary(snapshot);
      const extracted = await model.extractClaims({ snapshot }, `${keyBase}:instruct:model:${pending.id}`);
      if (!state.snapshots.some((s) => s.id === snapshot.id)) state.snapshots.push(snapshot);
      attachExtraction(state, snapshot, extracted, {
        kind: "question",
        qid: host.id,
        infix: "ins",
        versionId: snapshotVersionMap.get(snapshot.id),
      });
      return finish("applied", `补充信源已入证据链(${snapshot.url}),挂接问题 ${host.id}`);
    } catch (error) {
      const note = `补充信源取得失败(${ins.url ?? "文本"}):${error instanceof Error ? error.message : String(error)}`;
      addLimitation(state.limitations, note);
      return finish("failed", note);
    }
  };

  const consumeInstructions = async (): Promise<boolean> => {
    if (!options.pollInstructions) return false;
    let skippedCurrent = false;
    // 每个消费点拉取一次;pollInstructions 应一次返回全部新指令(队列 drain 语义)
    const batch = await options.pollInstructions();
    for (const pending of batch) {
      if (await applyInstruction(pending)) skippedCurrent = true;
    }
    if (batch.length > 0) await persistRun();
    return skippedCurrent;
  };

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

    await gather(0);
    if (cancelled()) return cancelRun();
    await saveCp("gather", { ...state });
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
      return { run: finished, bundle };
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
      const gapQuestions = analyze.gaps
        .map((g) => state.questions.find((q) => q.id === g.questionId))
        .filter((q): q is PlanQuestion => q !== undefined && q.status !== "answered");
      if (gapQuestions.length > 0) {
        await gather(1, gapQuestions);
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
      if (loopsUsed < maxLoops) {
        for (const issue of highs) {
          if (issue.fix === "regather" && issue.targetQuestionId) {
            const q = state.questions.find((x) => x.id === issue.targetQuestionId);
            // 2.1:用户显式跳过的问题不被评审修复复活
            if (q && q.status !== "skipped") {
              q.status = "open";
              await gather(10 + loopsUsed, [q]);
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
  return { run: finished, bundle };
}
