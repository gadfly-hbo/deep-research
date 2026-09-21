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
import { verifyCitations } from "../quality/citationVerifier.js";
import { checkModuleOutput } from "../quality/moduleCheck.js";
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
  const cancelRun = async (): Promise<RunResult> => {
    run.status = "cancelled";
    run.usage.wallMs = Date.now() - started;
    const finished = ResearchRunSchema.parse(run);
    await store.saveRun(finished);
    return { run: finished, bundle: null };
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
            };
            await store.saveSnapshot(snapshot);
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
            state.evidence.push({ id: evidenceId, snapshotId: snapshot.id, quote: c.quote });
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
      };
      await store.saveSnapshot(snapshot);
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
        state.evidence.push({ id: evidenceId, snapshotId: snapshot.id, quote: c.quote });
        state.claimQuestions[claimId] = "attachments";
      });
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
              { goal: request.goal, scope: request.scope, findings: state.findings, claims: state.claims },
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

  // --- publish 门禁:引用核查 + 口径检查 + 命中率 + 反例 + 关键结论降级
  run.stage = "publish";
  const verdicts = verifyCitations(state.evidence, state.snapshots);
  const verdictById = new Map(verdicts.map((v) => [v.evidenceId, v.verdict]));
  const conflicts = checkCalibration(state.claims);
  const originalFactIds = new Set(state.claims.filter((c) => c.kind === "fact").map((c) => c.id));
  const factHit = state.claims.filter(
    (c) =>
      originalFactIds.has(c.id) && c.evidenceIds.every((eid) => verdictById.get(eid) === "quote-hit"),
  ).length;
  const hitRate = originalFactIds.size > 0 ? factHit / originalFactIds.size : 1;

  const demoted: string[] = [];
  for (const claim of state.claims) {
    if (!originalFactIds.has(claim.id)) continue;
    if (!claim.evidenceIds.every((eid) => verdictById.get(eid) === "quote-hit")) {
      claim.kind = "unverified";
      demoted.push(claim.id);
    }
  }
  if (demoted.length > 0) {
    state.limitations.push(`以下主张引用核查未通过,已降级为未验证:${demoted.join("、")}`);
  }

  state.unresolved = state.questions
    .filter((q) => q.status !== "answered")
    .map((q) => `${q.question}(${QUESTION_STATUS_LABEL[q.status]})`);

  const reasons: string[] = [];
  if (state.capped) reasons.push("预算上限到达,部分采证未完成");
  if (demoted.length > 0) reasons.push("存在引用核查未通过的关键结论");
  if (hitRate < 0.8) reasons.push(`关键主张引句命中率 ${(hitRate * 100).toFixed(0)}% 低于 80%`);
  if (!state.counterexampleChecked && !state.capped) reasons.push("反例检查未完成");

  const conflictLine = (c: CalibrationConflict): string =>
    c.kind === "unit-mix"
      ? `- 口径混用:${c.entity}(${c.period})出现多种单位:${c.units.join(" / ")}(主张 ${c.claimIds.join("、")})`
      : `- 数值冲突:${c.entity}(${c.period})同口径不同数值:${c.values.map((v) => `${v.claimId}=${v.value}${v.unit}`).join(",")}`;

  const baseReportMd = [
    state.draftMd ?? `# ${request.goal}\n\n(草稿缺失:${reasons.join(";") || "采证不足"})`,
    "",
    ...(conflicts.length ? ["## 口径冲突披露", ...conflicts.map(conflictLine), ""] : []),
    "## 主张状态与引用判定",
    ...state.claims.map(
      (claim) =>
        `- [${claim.kind} / ${claim.evidenceIds.map((eid) => verdictById.get(eid) ?? "snapshot-missing").join(",")}] ${claim.statement}`,
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
  });
  run.usage.wallMs = Date.now() - started;
  const finished = ResearchRunSchema.parse(run);
  await store.saveRun(finished);
  await store.saveBundle(bundle);
  return { run: finished, bundle };
}
