/**
 * E1:嵌入式外部研究能力库(纯库 Port)——数据分析流程按需调用深度研究。
 * 每 job 一个内部 run(options.plan=questions,stopAfter:"gather");findings 以 gather
 * checkpoint 的 claimQuestions 为归组主路径(D3);取消经 RunOptions.onGatherProgress
 * 保留 claims 级部分结果(G1/D1);装配结果终态同步落 job.json,result() 以 job 记录为源,
 * 跨进程重启可读(G1-3)。
 *
 * 装配约束:adapters 由调用方构造(如 piRuntimeModel(configs,{authorize,dataDir})——凭据/
 * 授权/审计落位归调用方);job 根 = <dataDir>/capability-jobs,绝不落任何 projects 路径
 * 下(红队#2:server 启动清扫与项目列表均不触及);目录名 cap- 前缀不匹配项目正则。
 * 取消语义(D5 披露):信号在问/阶段边界生效,单次模型调用最长 ~300s(DR_MODEL_TIMEOUT_MS),
 * 期间 status 保持 running;在途问题仍完整跑完(含其抽取调用,有界)。
 * 幂等(G1-4):同 idempotencyKey 一律返回既有 jobId(含 failed,不重跑);重试=换新键。
 * 幂等窗口=进程生命周期(映射为内存表;进程重启后同键会新开 job,F3 披露)。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import type { Adapters } from "../adapters/types.js";
import { BudgetSchema, ResearchRequestSchema } from "../contracts.js";
import type { Budget } from "../contracts.js";
import { runResearch, type GatherProgressSnapshot } from "../core/runResearch.js";
import { verifyCitations } from "../quality/citationVerifier.js";
import { FsProjectStore } from "../stores/fsStore.js";
import type { LibraryStore } from "../library/types.js";
import { assembleFindings } from "./findings.js";
import type { AssembledFindings } from "./findings.js";

export interface ExternalResearchQuestion {
  id: string;
  question: string;
  /** 口径/范围提示(拼进调查任务卡,G1-6) */
  scopeNote?: string;
}

export interface ExternalResearchRequest {
  questions: ExternalResearchQuestion[];
  /** 预算档位(仅 tier-only 时执行问数联动:low≤2/medium≤4/high≤6;缺省 medium) */
  tier?: "low" | "medium" | "high";
  /** 显式预算(部分覆盖;存在即免档位×问数联动,由调用方自担) */
  budget?: Partial<Budget>;
  idempotencyKey?: string;
}

export type ExternalResearchJobStatus =
  | "submitted"
  | "running"
  | "completed"
  | "limited"
  | "cancelled"
  | "failed";

export interface ExternalResearchStatus {
  jobId: string;
  status: ExternalResearchJobStatus;
  submittedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** submitted 排队位(0=队首;运行中/终态无此字段) */
  queuePosition?: number;
}

export interface ExternalResearchResult {
  jobId: string;
  status: "completed" | "limited" | "cancelled" | "failed";
  findings: AssembledFindings["findings"];
  sharedClaims: AssembledFindings["sharedClaims"];
  limitations: string[];
  unresolved: string[];
  usage: { searches: number; fetches: number; modelCalls: number; outputTokens: number; wallMs: number };
  error?: string;
}

interface JobRecord {
  jobId: string;
  status: ExternalResearchJobStatus;
  request: ExternalResearchRequest;
  submittedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: ExternalResearchResult;
}

export interface ResearchCapability {
  submit(req: ExternalResearchRequest): { jobId: string };
  status(jobId: string): ExternalResearchStatus;
  result(jobId: string): ExternalResearchResult | null;
  cancel(jobId: string): void;
}

export interface ResearchCapabilityOptions {
  adapters: Adapters;
  dataDir: string;
  /** T2:注入即沉淀(采证时刻;取消时已抓快照已入库);注入则 projectId 必填(G1-5) */
  library?: LibraryStore;
  projectId?: string;
  maxConcurrentJobs?: number;
}

const TIER_QUESTION_LIMIT: Record<"low" | "medium" | "high", number> = { low: 2, medium: 4, high: 6 };

const EMPTY_USAGE = { searches: 0, fetches: 0, modelCalls: 0, outputTokens: 0, wallMs: 0 };

export function createResearchCapability(opts: ResearchCapabilityOptions): ResearchCapability {
  // 红队#2 硬约束:job 根绝不落在任何 */projects 路径下(防 server 清扫误杀/混入项目列表)
  const jobRoot = resolvePath(join(opts.dataDir, "capability-jobs"));
  if (jobRoot.split(/[\\/]/).includes("projects")) {
    throw new Error(`capability dataDir 不得位于任何 projects 路径下(当前:${jobRoot})`);
  }
  if (opts.library && !opts.projectId) {
    throw new Error("注入 library 时必须提供 projectId(无主取得记录会静默扩大外发授权面)");
  }
  const maxConcurrentJobs = opts.maxConcurrentJobs ?? 2;

  const jobs = new Map<string, JobRecord>();
  const idemMap = new Map<string, string>();
  const controllers = new Map<string, AbortController>();
  const queue: string[] = [];
  let active = 0;

  mkdirSync(jobRoot, { recursive: true });


  const jobDir = (jobId: string): string => join(jobRoot, jobId);
  const jobFile = (jobId: string): string => join(jobDir(jobId), "job.json");

  const persist = (record: JobRecord): void => {
    writeFileSync(jobFile(record.jobId), JSON.stringify(record, null, 2));
  };

  const readRecord = (jobId: string): JobRecord => {
    try {
      return JSON.parse(readFileSync(jobFile(jobId), "utf8")) as JobRecord;
    } catch {
      throw new Error(`未知 jobId: ${jobId}`);
    }
  };

  const emptyResult = (jobId: string, status: ExternalResearchResult["status"], limitation: string, usage = EMPTY_USAGE): ExternalResearchResult => ({
    jobId,
    status,
    findings: [],
    sharedClaims: [],
    limitations: [limitation],
    unresolved: [],
    usage,
  });


  // F1(评审遗留):进程内自愈清扫——上次进程中断遗留的 submitted/running 作业标 failed
  // (可换幂等键重新提交);终态记录不动。装配约定:同一 dataDir 同时只应有一个活跃实例
  //(本清扫在装配时执行,双活实例会把对方在途作业误判为孤儿)。
  for (const dir of existsSync(jobRoot) ? readdirSync(jobRoot) : []) {
    const file = join(jobRoot, dir, "job.json");
    if (!existsSync(file)) continue;
    try {
      const orphan = JSON.parse(readFileSync(file, "utf8")) as JobRecord;
      if (orphan.status !== "submitted" && orphan.status !== "running") continue;
      const healed: JobRecord = {
        ...orphan,
        status: "failed",
        finishedAt: new Date().toISOString(),
        result: {
          ...emptyResult(orphan.jobId, "failed", "进程中断,作业未完成(可换幂等键重新提交)"),
          error: "进程中断",
        },
      };
      writeFileSync(file, JSON.stringify(healed, null, 2));
    } catch {
      /* 单个 job 记录损坏不影响装配 */
    }
  }

  const validate = (req: ExternalResearchRequest): void => {
    if (!Array.isArray(req.questions) || req.questions.length < 1 || req.questions.length > 6) {
      throw new Error("questions 须为 1~6 个");
    }
    // F2:tier 枚举白名单(JS 运行时调用方绕过类型时的 submit 期错误,优于作业期 failed)
    if (req.tier !== undefined && !["low", "medium", "high"].includes(req.tier)) {
      throw new Error(`tier 须为 low|medium|high(现:${String(req.tier)})`);
    }
    const seen = new Set<string>();
    for (const q of req.questions) {
      if (!q.id || !q.id.trim()) throw new Error("question.id 不能为空(它是 findings.questionId 的主键)");
      if (seen.has(q.id)) throw new Error(`question.id 重复: ${q.id}`);
      seen.add(q.id);
      if (!q.question || !q.question.trim()) throw new Error(`问题 ${q.id} 不能为空`);
    }
    if (req.budget === undefined) {
      const tier = req.tier ?? "medium";
      const limit = TIER_QUESTION_LIMIT[tier];
      if (req.questions.length > limit) {
        throw new Error(`${tier} 档预算最多支持 ${limit} 问(现 ${req.questions.length});请升档、减问或提供显式 budget`);
      }
    }
    if (req.budget !== undefined) BudgetSchema.partial().parse(req.budget);
  };

  const runJob = async (jobId: string): Promise<void> => {
    const record = jobs.get(jobId);
    if (!record || record.status !== "submitted") return; // 排队期被取消
    const controller = new AbortController();
    controllers.set(jobId, controller);

    // F2:前置段(persist/open/schema parse)一并入 try——任一抛错落 failed 终态,
    // 不再产生 unhandled rejection;catch 内落盘再失败也不再上抛(内存态已终态)
    try {
      record.status = "running";
      record.startedAt = new Date().toISOString();
      persist(record);

      // TS 控制流不追踪闭包内赋值,用 holder 避免收窄为 never
      const progress: { latest: GatherProgressSnapshot | null } = { latest: null };
      const store = FsProjectStore.open(jobDir(jobId));
      const req = record.request;
      const firstQuestion = req.questions[0]!.question.slice(0, 40);
      const request = ResearchRequestSchema.parse({
        id: `cap:${jobId}`,
        module: "industry",
        goal: `外部研究(${req.questions.length} 问):${firstQuestion}`,
        scope: { summary: "嵌入式外部研究(数据分析任务)", queries: [] },
        ...(req.budget !== undefined ? { budget: req.budget } : { budgetTier: req.tier ?? "medium" }),
      });

      {
      const { run, bundle } = await runResearch(request, opts.adapters, store, {
        runId: `run-${jobId}`,
        plan: {
          questions: req.questions.map((q) => ({
            id: q.id,
            question: q.scopeNote ? `${q.question}(${q.scopeNote})` : q.question,
            status: "open" as const,
          })),
        },
        stopAfter: "gather",
        signal: controller.signal,
        ...(opts.library && opts.projectId ? { library: opts.library, projectId: opts.projectId } : {}),
        onGatherProgress: (snapshot) => {
          progress.latest = snapshot;
        },
      });

      let status: ExternalResearchResult["status"];
      let result: ExternalResearchResult;
      if (run.status === "cancelled") {
        status = "cancelled";
        const snap = progress.latest;
        const done = snap
          ? snap.questions.filter((q) => q.status === "answered" || q.status === "partially").length
          : 0;
        if (snap) {
          const verdicts = verifyCitations(snap.evidence, snap.snapshots);
          const assembled = assembleFindings({
            questions: snap.questions,
            claimQuestions: snap.claimQuestions,
            claims: snap.claims,
            evidence: snap.evidence,
            snapshots: snap.snapshots,
            verdicts,
            limitations: [...snap.limitations, `已取消:已完成 ${done}/${req.questions.length} 问(在途问题结果保留)`],
            unresolved: snap.unresolved,
          });
          result = { jobId, status, ...assembled, usage: run.usage };
        } else {
          result = emptyResult(jobId, "cancelled", `已取消:未完成任何问题(0/${req.questions.length})`, run.usage);
        }
      } else if (run.status === "failed") {
        status = "failed";
        result = { ...emptyResult(jobId, "failed", `研究执行失败:${run.error ?? "unknown"}`, run.usage), error: run.error };
      } else {
        // published | limited:bundle + gather checkpoint(D3 主路径)
        status = run.status === "limited" ? "limited" : "completed";
        const checkpoints = await store.checkpoints(run.id);
        const gatherCp = checkpoints.findLast((c) => c.stage === "gather");
        const data = (gatherCp?.data ?? {}) as {
          questions?: Array<{ id: string; question?: string; status?: string }>;
          claimQuestions?: Record<string, string>;
        };
        const assembled = assembleFindings({
          questions: data.questions ?? [],
          claimQuestions: data.claimQuestions ?? {},
          claims: bundle?.claims ?? [],
          evidence: bundle?.evidence ?? [],
          snapshots: bundle?.snapshots ?? [],
          verdicts: bundle?.verdicts ?? [],
          limitations: bundle?.limitations ?? [],
          unresolved: bundle?.unresolved ?? [],
        });
        result = { jobId, status, ...assembled, usage: run.usage };
      }
      record.status = status;
      record.finishedAt = new Date().toISOString();
      record.result = result;
      persist(record);
      }
    } catch (error) {
      record.status = "failed";
      record.finishedAt = new Date().toISOString();
      record.result = {
        ...emptyResult(jobId, "failed", `研究执行异常:${error instanceof Error ? error.message : String(error)}`),
        error: String(error instanceof Error ? error.message : error),
      };
      try {
        persist(record);
      } catch {
        /* 落盘也失败:内存态已终态,不再上抛(F2) */
      }
    } finally {
      controllers.delete(jobId);
    }
  };

  const pump = (): void => {
    while (active < maxConcurrentJobs && queue.length > 0) {
      const jobId = queue.shift()!;
      const record = jobs.get(jobId);
      if (!record || record.status !== "submitted") continue;
      active += 1;
      void runJob(jobId).finally(() => {
        active -= 1;
        pump();
      });
    }
  };

  const submit = (req: ExternalResearchRequest): { jobId: string } => {
    validate(req);
    if (req.idempotencyKey && idemMap.has(req.idempotencyKey)) {
      return { jobId: idemMap.get(req.idempotencyKey)! };
    }
    const jobId = `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    FsProjectStore.create(jobDir(jobId), {
      module: "industry",
      goal: `外部研究(${req.questions.length} 问)`,
      scope: { summary: "嵌入式外部研究(数据分析任务)", queries: [] },
    });
    const record: JobRecord = {
      jobId,
      status: "submitted",
      request: JSON.parse(JSON.stringify(req)) as ExternalResearchRequest,
      submittedAt: new Date().toISOString(),
    };
    jobs.set(jobId, record);
    persist(record);
    if (req.idempotencyKey) idemMap.set(req.idempotencyKey, jobId);
    queue.push(jobId);
    pump();
    return { jobId };
  };

  const status = (jobId: string): ExternalResearchStatus => {
    const record = jobs.get(jobId) ?? readRecord(jobId);
    const queuePosition = record.status === "submitted" ? Math.max(0, queue.indexOf(jobId)) : undefined;
    return {
      jobId: record.jobId,
      status: record.status,
      submittedAt: record.submittedAt,
      ...(record.startedAt ? { startedAt: record.startedAt } : {}),
      ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
      ...(queuePosition !== undefined ? { queuePosition } : {}),
    };
  };

  const result = (jobId: string): ExternalResearchResult | null => {
    const record = jobs.get(jobId) ?? readRecord(jobId);
    return record.result ?? null;
  };

  const cancel = (jobId: string): void => {
    const record = jobs.get(jobId) ?? readRecord(jobId);
    if (record.status === "submitted") {
      const idx = queue.indexOf(jobId);
      if (idx >= 0) queue.splice(idx, 1);
      record.status = "cancelled";
      record.finishedAt = new Date().toISOString();
      record.result = emptyResult(jobId, "cancelled", "已取消:作业尚在排队,未产生任何研究调用");
      persist(record);
      return;
    }
    if (record.status === "running") controllers.get(jobId)?.abort();
    // 终态:幂等 no-op;running 的终态由 runJob 落(问/阶段边界生效,见文件头披露)
  };

  return { submit, status, result, cancel };
}
