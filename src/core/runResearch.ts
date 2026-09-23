import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import {
  ResearchResultBundleSchema,
  ResearchRunSchema,
  type Budget,
  type Claim,
  type Evidence,
  type ResearchRequest,
  type ResearchResultBundle,
  type ResearchRun,
  type SourceSnapshot,
} from "../contracts.js";
import { getModuleConfig } from "../modules/registry.js";
import type { ModuleConfig } from "../modules/types.js";
import { checkCalibration, type CalibrationConflict } from "../quality/calibrationChecker.js";
import { checkEntailment } from "../quality/entailment.js";
import { checkMultiSource, mergeCrossSourceClaims } from "../quality/multiSource.js";
import { checkNumericConsistency } from "../quality/numericVerifier.js";
import { verifyCitations } from "../quality/citationVerifier.js";
import { checkModuleOutput } from "../quality/moduleCheck.js";
import { tierOfSource } from "../quality/sourceTier.js";
import type { LibraryStore } from "../library/types.js";
import type { Checkpoint, ResearchStore } from "../stores/types.js";
import {
  AnalyzeOutputSchema,
  DraftOutputSchema,
  PlanOutputSchema,
  ReviewOutputSchema,
  type AnalyzeOutput,
  type PlanOutput,
  type PlanQuestion,
} from "./stages.js";

export const DEFAULT_BUDGET: Budget = {
  maxSearches: 80,
  maxFetches: 60,
  maxCostEstimate: 80,
  maxWallMs: 90 * 60_000,
  maxParallel: 4,
};

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
}

export interface RunResult {
  run: ResearchRun;
  bundle: ResearchResultBundle | null;
}

const QUESTION_STATUS_LABEL: Record<PlanQuestion["status"], string> = {
  open: "未开始",
  answered: "已回答",
  partially: "部分回答",
  unanswered: "未回答",
};

interface RunState {
  questions: PlanQuestion[];
  snapshots: SourceSnapshot[];
  evidence: Evidence[];
  claims: Claim[];
  claimQuestions: Record<string, string>;
  findings: AnalyzeOutput["findings"];
  draftMd: string | null;
  limitations: string[];
  unresolved: string[];
  counterexampleChecked: boolean;
  capped: boolean;
}

/** 阶段输出护栏:模型输出不合格时降级为缺省值并披露限制,而不是击杀整条 run(失败不冒充完成)。 */
function safeParse<T>(
  schema: { parse: (v: unknown) => T },
  output: unknown,
  fallback: () => T,
  limitation: string,
  state: RunState,
): T {
  try {
    return schema.parse(output);
  } catch {
    if (!state.limitations.includes(limitation)) state.limitations.push(limitation);
    return fallback();
  }
}

const emptyState = (): RunState => ({
  questions: [],
  snapshots: [],
  evidence: [],
  claims: [],
  claimQuestions: {},
  findings: [],
  draftMd: null,
  limitations: [],
  unresolved: [],
  counterexampleChecked: false,
  capped: false,
});

export async function runResearch(
  request: ResearchRequest,
  adapters: Adapters,
  store: ResearchStore,
  options: RunOptions = {},
): Promise<RunResult> {
  const started = Date.now();
  const budget: Budget = { ...DEFAULT_BUDGET, ...request.budget };
  const moduleConfig = options.moduleConfig ?? getModuleConfig(request.module);
  const keyBase = request.id ?? randomUUID();
  const prior = request.id ? await store.findRunByRequestId(request.id) : undefined;
  const resuming = prior !== undefined && prior.status === "cancelled";
  const runId = resuming ? prior.id : (options.runId ?? randomUUID());
  const run: ResearchRun = resuming
    ? { ...prior, status: "running" }
    : {
        id: runId,
        requestId: keyBase,
        stage: "plan",
        status: "running",
        checkpoints: [],
        usage: { searches: 0, fetches: 0, costEstimate: 0, wallMs: 0 },
      };
  const priorCheckpoints = resuming ? await store.checkpoints(runId) : [];
  const completedStages = new Set(priorCheckpoints.map((c) => c.stage));

  const state = emptyState();
  for (const cp of priorCheckpoints) {
    if (cp.stage === "plan") {
      state.questions = (cp.data as PlanOutput).questions;
    } else if (cp.stage === "gather") {
      Object.assign(state, cp.data as Partial<RunState>);
    } else if (cp.stage === "analyze") {
      state.findings = (cp.data as AnalyzeOutput).findings;
    } else if (cp.stage === "draft") {
      state.draftMd = (cp.data as { reportMd: string }).reportMd;
    }
  }

  const cancelled = () => options.signal?.aborted === true;
  const overBudget = () =>
    run.usage.costEstimate > budget.maxCostEstimate || Date.now() - started > budget.maxWallMs;
  const saveCp = async (stage: Checkpoint["stage"], data: unknown) => {
    await store.saveCheckpoint({ runId, stage, data, completedAt: new Date().toISOString() });
  };
  const persistRun = async (stage?: ResearchRun["stage"]): Promise<void> => {
    if (stage) run.stage = stage;
    await store.saveRun(ResearchRunSchema.parse(run));
  };

  const cancelRun = async (): Promise<RunResult> => {
    run.status = "cancelled";
    run.usage.wallMs = Date.now() - started;
    const finished = ResearchRunSchema.parse(run);
    await store.saveRun(finished);
    return { run: finished, bundle: null };
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
      const note = "共享登记失败:部分资料未进入情报库(项目已保存、共享登记待处理)";
      if (!state.limitations.includes(note)) state.limitations.push(note);
    }
  };

  const gather = async (round: number, targets?: PlanQuestion[]): Promise<void> => {
    const questions = targets ?? state.questions.filter((q) => q.status === "open");
    for (let qIdx = 0; qIdx < questions.length; qIdx++) {
      const q = questions[qIdx];
      if (cancelled()) return;
      if (run.usage.searches >= budget.maxSearches || overBudget()) {
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

      const hits = await adapters.search.search(
        q.question,
        `${keyBase}:gather:r${round}:search:${q.id}`,
      );
      run.usage.searches += 1;
      let fetchedAny = false;
      let claimsForQ = 0;
      // 抓取配额按剩余问题均分,避免首个问题独占预算导致其余问题颗粒无收
      const remainingQuestions = questions.length - qIdx;
      const perQuestion = Math.max(1, Math.floor((budget.maxFetches - run.usage.fetches) / remainingQuestions));
      let fetchedForQ = 0;
      for (let i = 0; i < hits.length && fetchedForQ < perQuestion; i += budget.maxParallel) {
        if (cancelled()) return;
        const chunk = hits.slice(i, i + budget.maxParallel);
        const room = Math.min(budget.maxFetches - run.usage.fetches, perQuestion - fetchedForQ);
        if (room <= 0 || overBudget()) {
          state.capped = true;
          break;
        }
        const take = chunk.slice(0, room);
        if (run.usage.fetches + take.length >= budget.maxFetches) state.capped = true;
        const produced = await Promise.all(
          take.map(async (hit, j) => {
            const n = `${q.id}:${i + j}`;
            const page = await adapters.page.fetch(hit.url, `${keyBase}:gather:r${round}:fetch:${n}`);
            const doc = await adapters.parser.parse(page, `${keyBase}:gather:r${round}:parse:${n}`);
            const snapshot: SourceSnapshot = {
              id: `snap:${hit.url}`,
              url: hit.url,
              title: hit.title,
              fetchedAt: new Date().toISOString(),
              bodyText: doc.bodyText,
              parseStatus: doc.parseStatus,
              contentType: page.contentType,
              tier: tierOfSource(hit.url, moduleConfig.sourceStrategy.preferredDomains),
            };
            await store.saveSnapshot(snapshot);
            await ingestToLibrary(snapshot);
            const extracted = await adapters.model.extractClaims(
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
          run.usage.costEstimate += extracted.cost;
          const sIdx = state.snapshots.findIndex((s) => s.id === snapshot.id);
          if (sIdx >= 0) state.snapshots[sIdx] = snapshot;
          else state.snapshots.push(snapshot);
          extracted.claims.forEach((c, ci) => {
            const claimId = `cl:${q.id}:${snapshot.id}:${ci}`;
            const evidenceId = `ev:${q.id}:${snapshot.id}:${ci}`;
            const claim: Claim = {
              id: claimId,
              statement: c.statement,
              kind: c.kind,
              evidenceIds: [evidenceId],
              calibration: c.calibration,
            };
            const cIdx = state.claims.findIndex((x) => x.id === claimId);
            if (cIdx >= 0) state.claims[cIdx] = claim;
            else state.claims.push(claim);
            state.evidence.push({
              id: evidenceId,
              snapshotId: snapshot.id,
              quote: c.quote,
              // 2.0:证据绑定情报库来源版本,提取核验待评审确认
              versionId: snapshotVersionMap.get(snapshot.id),
              revision: 1,
              extractionCheck: "UNCHECKED",
            });
            state.claimQuestions[claimId] = q.id;
            claimsForQ += 1;
          });
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
      await persistRun();
    }
  };

  // --- plan(恢复时以 gather 检查点内的问题状态为准,不被 options.plan 覆盖)
  if (options.plan && !completedStages.has("gather")) {
    state.questions = options.plan.questions.map((q) => ({ ...q }));
  } else if (options.plan) {
    // 已完成 gather 的恢复路径:问题状态来自检查点
  } else if (!completedStages.has("plan")) {
    if (cancelled()) return cancelRun();
    if (overBudget()) {
      state.capped = true;
    } else {
      const res = await adapters.model.runStage(
        "plan",
        { goal: request.goal, scope: request.scope, questionFramework: moduleConfig.questionFramework },
        `${keyBase}:plan:0`,
      );
      run.usage.costEstimate += res.cost;
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
    const planCp = priorCheckpoints.find((c) => c.stage === "plan");
    if (planCp) state.questions = (planCp.data as PlanOutput).questions;
  }

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
      const snapshot: SourceSnapshot = {
        id: `snap:attachment:${path}`,
        url: page.url,
        title: path.split("/").pop() ?? path,
        fetchedAt: new Date().toISOString(),
        bodyText: doc.bodyText,
        parseStatus: doc.parseStatus,
        contentType: page.contentType,
        // 用户提供的本机资料视为一手来源
        tier: "A",
      };
      await store.saveSnapshot(snapshot);
      await ingestToLibrary(snapshot);
      state.snapshots.push(snapshot);
      const extracted = await adapters.model.extractClaims(
        { snapshot },
        `${keyBase}:gather:attach:model:${ai}`,
      );
      run.usage.costEstimate += extracted.cost;
      extracted.claims.forEach((c, ci) => {
        const claimId = `cl:attachments:${snapshot.id}:${ci}`;
        const evidenceId = `ev:attachments:${snapshot.id}:${ci}`;
        state.claims.push({
          id: claimId,
          statement: c.statement,
          kind: c.kind,
          evidenceIds: [evidenceId],
          calibration: c.calibration,
        });
        state.evidence.push({
          id: evidenceId,
          snapshotId: snapshot.id,
          quote: c.quote,
          versionId: snapshotVersionMap.get(snapshot.id),
          revision: 1,
          extractionCheck: "UNCHECKED",
        });
        state.claimQuestions[claimId] = "attachments";
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
        const snapshot: SourceSnapshot = {
          id: `snap:lib:${binding.versionId}`,
          url: source.url ?? `library://${source.sourceId}`,
          title: source.title,
          fetchedAt: new Date().toISOString(),
          bodyText: content,
          parseStatus: "ok",
          contentType: "text/plain",
          tier: source.docType === "research-report" ? "C" : "B",
        };
        if (!state.snapshots.some((s) => s.id === snapshot.id)) state.snapshots.push(snapshot);
        await store.saveSnapshot(snapshot);
        const extracted = await adapters.model.extractClaims(
          { snapshot },
          `${keyBase}:gather:reuse:${binding.bindingId}`,
        );
        run.usage.costEstimate += extracted.cost;
        extracted.claims.forEach((c, ci) => {
          const claimId = `cl:reuse:${binding.bindingId}:${ci}`;
          const evidenceId = `ev:reuse:${binding.bindingId}:${ci}`;
          if (state.claims.some((x) => x.id === claimId)) return;
          state.claims.push({
            id: claimId,
            statement: c.statement,
            kind: c.kind,
            evidenceIds: [evidenceId],
            calibration: c.calibration,
            // 复用证据带适用范围说明,防止样本边界被抹平(A-05/A-18)
            scopeNote: binding.checkNotes.join(";") || undefined,
          });
          state.evidence.push({
            id: evidenceId,
            snapshotId: snapshot.id,
            quote: c.quote,
            versionId: binding.versionId,
            revision: binding.evidenceRevisions[evidenceId] ?? 1,
            extractionCheck: "UNCHECKED",
            scopeNote: binding.checkNotes.join(";") || undefined,
          });
          state.claimQuestions[claimId] = "reuse";
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
      const limitations = state.capped
        ? [
            `预算上限到达(搜索 ${run.usage.searches}/${budget.maxSearches},抓取 ${run.usage.fetches}/${budget.maxFetches});未覆盖部分不作结论`,
          ]
        : [];
      const reportMd = [
        `# ${request.goal}`,
        "",
        `范围:${request.scope.summary}`,
        "",
        "## 主张与证据判定",
        ...state.claims.map(
          (claim, i) => `- [${claim.kind} / ${verdicts[i]?.verdict ?? "snapshot-missing"}] ${claim.statement}`,
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
        unresolved: [],
        verdicts,
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
    if (overBudget()) {
      state.capped = true;
    } else {
      const res = await adapters.model.runStage(
        "analyze",
        { goal: request.goal, questions: state.questions, claims: state.claims },
        `${keyBase}:analyze:0`,
      );
      run.usage.costEstimate += res.cost;
      const analyze = safeParse(
        AnalyzeOutputSchema,
        res.output,
        () => ({ findings: [], gaps: [] }),
        "分析输出不合格,发现清单置空",
        state,
      );
      state.findings = analyze.findings;
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

  // --- draft
  if (!completedStages.has("draft")) {
    if (cancelled()) return cancelRun();
    await persistRun("draft");
    if (overBudget()) {
      state.capped = true;
    } else {
      const res = await adapters.model.runStage(
        "draft",
        {
          goal: request.goal,
          scope: request.scope,
          findings: state.findings,
          claims: state.claims,
          reportTemplate: moduleConfig.reportTemplate,
          ...(request.outline ? { outline: request.outline } : {}),
        },
        `${keyBase}:draft:0`,
      );
      run.usage.costEstimate += res.cost;
      const draft = safeParse(
        DraftOutputSchema,
        res.output,
        () => ({ reportMd: `# ${request.goal}\n\n(草稿生成失败,以下为证据清单摘要)` }),
        "草稿输出不合格,已降级为证据摘要草稿",
        state,
      );
      state.draftMd = draft.reportMd;
      await saveCp("draft", { reportMd: state.draftMd });
    }
  }

  // --- review + 修复回环(缺口补证 / 反例检查 / 受影响内容复核)
  const maxLoops = options.maxLoops ?? 2;
  if (!completedStages.has("review") && !state.capped) {
    await persistRun("review");
    let loopsUsed = 0;
    for (;;) {
      if (cancelled()) return cancelRun();
      if (overBudget()) {
        state.capped = true;
        break;
      }
      const preVerdicts = verifyCitations(state.evidence, state.snapshots);
      const preConflicts = checkCalibration(state.claims);
      const res = await adapters.model.runStage(
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
      run.usage.costEstimate += res.cost;
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
            if (q) {
              q.status = "open";
              await gather(10 + loopsUsed, [q]);
              fixedAny = true;
            }
          } else if (issue.fix === "rephrase") {
            const d = await adapters.model.runStage(
              "draft",
              {
                goal: request.goal,
                scope: request.scope,
                findings: state.findings,
                claims: state.claims,
                ...(request.outline ? { outline: request.outline } : {}),
              },
              `${keyBase}:draft:fix${loopsUsed}`,
            );
            run.usage.costEstimate += d.cost;
            state.draftMd = DraftOutputSchema.parse(d.output).reportMd;
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

  // --- publish 门禁:引用核查 + 语义蕴涵 + 数值复算 + 信源分级 + 口径检查 + 多源交叉 + 置信度聚合
  run.stage = "publish";
  // 跨源合并:不同来源里出现的同一事实(口径一致/高相似)合并证据,多源判定才有意义
  state.claims = mergeCrossSourceClaims(state.claims);
  const baseVerdicts = verifyCitations(state.evidence, state.snapshots);
  const evidenceById = new Map(state.evidence.map((e) => [e.id, e]));
  const snapById = new Map(state.snapshots.map((s) => [s.id, s]));
  const claimByEvidence = new Map<string, Claim>();
  for (const c of state.claims) for (const eid of c.evidenceIds) claimByEvidence.set(eid, c);

  // 扩展判定:引句命中的证据再过语义蕴涵与数值复算;快照信源等级随判定落档
  const verdicts = baseVerdicts.map((v) => {
    const ev = evidenceById.get(v.evidenceId);
    const claim = ev ? claimByEvidence.get(ev.id) : undefined;
    const hit = v.verdict === "quote-hit";
    return {
      ...v,
      entailment: hit && ev && claim ? checkEntailment(claim.statement, ev.quote) : ("na" as const),
      numeric: hit && ev && claim ? checkNumericConsistency(claim, ev.quote) : ("na" as const),
      tier: ev ? snapById.get(ev.snapshotId)?.tier : undefined,
    };
  });
  const verdictById = new Map(verdicts.map((v) => [v.evidenceId, v]));
  const conflicts = checkCalibration(state.claims);
  const originalFactIds = new Set(state.claims.filter((c) => c.kind === "fact").map((c) => c.id));
  const factHit = state.claims.filter(
    (c) =>
      originalFactIds.has(c.id) && c.evidenceIds.every((eid) => verdictById.get(eid)?.verdict === "quote-hit"),
  ).length;
  const hitRate = originalFactIds.size > 0 ? factHit / originalFactIds.size : 1;

  // 硬降级:引句未命中 / 转述不被引句支撑 / 数值与引句不一致
  const demoted: string[] = [];
  const demotedEntail: string[] = [];
  const demotedNumeric: string[] = [];
  for (const claim of state.claims) {
    if (!originalFactIds.has(claim.id)) continue;
    const vs = claim.evidenceIds.map((eid) => verdictById.get(eid));
    if (!vs.every((v) => v?.verdict === "quote-hit")) {
      claim.kind = "unverified";
      demoted.push(claim.id);
      continue;
    }
    // 蕴涵与数值复算独立记录:同一主张可能同时失败,披露全部原因
    let hardFailed = false;
    if (vs.some((v) => v?.entailment === "fail")) {
      demotedEntail.push(claim.id);
      hardFailed = true;
    }
    if (vs.some((v) => v?.numeric === "mismatch")) {
      demotedNumeric.push(claim.id);
      hardFailed = true;
    }
    if (hardFailed) claim.kind = "unverified";
  }
  // 多源交叉:带口径的关键数值主张须 ≥2 个独立域名引句命中,否则降级为推断;叙述性事实单源不降类型(置信度降 medium)
  const hitEvidenceIds = new Set(verdicts.filter((v) => v.verdict === "quote-hit").map((v) => v.evidenceId));
  const multi = checkMultiSource(state.claims, state.evidence, state.snapshots, hitEvidenceIds);
  const singleSource: string[] = [];
  for (const id of multi.singleSourceCalibrated) {
    const claim = state.claims.find((c) => c.id === id);
    if (claim && originalFactIds.has(id) && claim.kind === "fact") {
      claim.kind = "inference";
      singleSource.push(id);
    }
  }
  const singleSourcePlain = new Set(multi.singleSourcePlain);
  // 信源分级:仅 C 级信源支撑的主张不降级但置信度记低并披露
  const tierCOnly: string[] = [];
  for (const claim of state.claims) {
    if (claim.kind === "unverified") continue;
    const tiers = claim.evidenceIds
      .map((eid) => snapById.get(evidenceById.get(eid)?.snapshotId ?? "")?.tier)
      .filter((t): t is "A" | "B" | "C" => t !== undefined);
    if (tiers.length > 0 && tiers.every((t) => t === "C")) tierCOnly.push(claim.id);
  }
  if (demoted.length > 0) state.limitations.push(`以下主张引用核查未通过,已降级为未验证:${demoted.join("、")}`);
  if (demotedEntail.length > 0) state.limitations.push(`以下主张的引句不支持其转述(语义蕴涵未通过),已降级为未验证:${demotedEntail.join("、")}`);
  if (demotedNumeric.length > 0) state.limitations.push(`以下主张数值与引句不一致(数值复算未通过),已降级为未验证:${demotedNumeric.join("、")}`);
  if (singleSource.length > 0) state.limitations.push(`以下主张仅单一来源支撑,已降级为推断(需交叉验证):${singleSource.join("、")}`);
  if (tierCOnly.length > 0) state.limitations.push(`以下主张仅有 C 级信源(社媒/自媒体/未知来源)支撑,置信度低:${tierCOnly.join("、")}`);

  // 置信度聚合:核查全过 + 多源 + A/B 级信源 = high;单源/弱核查 = medium;降级/仅C级 = low
  for (const claim of state.claims) {
    const vs = claim.evidenceIds.map((eid) => verdictById.get(eid));
    if (claim.kind === "unverified") {
      claim.confidence = "low";
    } else if (claim.kind === "inference") {
      claim.confidence = vs.some((v) => v?.entailment === "weak" || v?.numeric === "mismatch") ? "low" : "medium";
    } else {
      const weak = vs.some((v) => v?.entailment === "weak");
      claim.confidence = tierCOnly.includes(claim.id) ? "low" : weak || singleSourcePlain.has(claim.id) ? "medium" : "high";
    }
  }

  state.unresolved = state.questions
    .filter((q) => q.status !== "answered")
    .map((q) => `${q.question}(${QUESTION_STATUS_LABEL[q.status]})`);

  const reasons: string[] = [];
  const hardDemoted = demoted.length + demotedEntail.length + demotedNumeric.length;
  if (state.capped) reasons.push("预算上限到达,部分采证未完成");
  if (hardDemoted > 0) reasons.push("存在引用/蕴涵/数值核查未通过的关键结论");
  if (hitRate < 0.8) reasons.push(`关键主张引句命中率 ${(hitRate * 100).toFixed(0)}% 低于 80%`);
  if (!state.counterexampleChecked && !state.capped) reasons.push("反例检查未完成");

  const conflictLine = (c: CalibrationConflict): string =>
    c.kind === "unit-mix"
      ? `- 口径混用:${c.entity}(${c.period})出现多种单位:${c.units.join(" / ")}(主张 ${c.claimIds.join("、")})`
      : `- 数值冲突:${c.entity}(${c.period})同口径不同数值:${c.values.map((v) => `${v.claimId}=${v.value}${v.unit}`).join(",")}`;

  const evLabel = (eid: string): string => {
    const v = verdictById.get(eid);
    if (!v) return "snapshot-missing";
    const extras = [
      v.entailment && v.entailment !== "na" ? `蕴涵:${v.entailment}` : "",
      v.numeric && v.numeric !== "na" ? `数值:${v.numeric}` : "",
      v.tier ? `${v.tier}级信源` : "",
    ].filter(Boolean);
    return extras.length ? `${v.verdict}(${extras.join(",")})` : v.verdict;
  };

  const baseReportMd = [
    state.draftMd ?? `# ${request.goal}\n\n(草稿缺失:${reasons.join(";") || "采证不足"})`,
    "",
    ...(conflicts.length ? ["## 口径冲突披露", ...conflicts.map(conflictLine), ""] : []),
    "## 主张状态与引用判定",
    ...state.claims.map(
      (claim) =>
        `- [${claim.kind}${claim.confidence ? `|置信度:${claim.confidence}` : ""} / ${claim.evidenceIds.map(evLabel).join(",")}] ${claim.statement}`,
    ),
    "",
    ...(state.unresolved.length
      ? ["## 未解决问题", ...state.unresolved.map((u) => `- ${u}`), ""]
      : []),
  ].join("\n");

  // 专项质量检查(模块配置):必备章节 / 主题覆盖 / 验证规则
  const moduleCheck = checkModuleOutput(moduleConfig, {
    reportMd: baseReportMd,
    claims: state.claims,
    questions: state.questions,
  });
  if (!moduleCheck.passed) {
    reasons.push(
      `模块质量检查未通过:${[
        ...moduleCheck.missingSections.map((s) => `缺必备章节「${s}」`),
        ...moduleCheck.uncoveredTopics.map((t) => `主题未覆盖「${t}」`),
        ...moduleCheck.violations,
      ].join(";")}`,
    );
  }
  for (const reason of reasons) {
    if (!state.limitations.includes(reason)) state.limitations.push(reason);
  }
  run.status = reasons.length > 0 ? "limited" : "published";

  const reportMd = [
    baseReportMd,
    "",
    ...(state.limitations.length ? ["## 限制", ...state.limitations.map((l) => `- ${l}`), ""] : []),
  ].join("\n");

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
  });
  run.usage.wallMs = Date.now() - started;
  const finished = ResearchRunSchema.parse(run);
  await store.saveRun(finished);
  await store.saveBundle(bundle);
  return { run: finished, bundle };
}
