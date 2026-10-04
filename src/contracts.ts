import { z } from "zod";

export const CalibrationSchema = z.object({
  entity: z.string().min(1),
  period: z.string().min(1),
  unit: z.string().min(1),
  value: z.number().optional(),
});
export type Calibration = z.infer<typeof CalibrationSchema>;

export const SourceSnapshotSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  title: z.string(),
  fetchedAt: z.string().min(1),
  bodyText: z.string(),
  parseStatus: z.enum(["ok", "failed"]),
  contentType: z.string(),
  /** 信源等级:A 官方/权威一手 · B 行业报告/专业平台 · C 社媒/自媒体/未知 */
  tier: z.enum(["A", "B", "C"]).optional(),
});
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  snapshotId: z.string().min(1),
  quote: z.string(),
  locator: z.string().optional(),
  /** 2.0 扩展(可选,旧数据缺省):证据修订号,修改摘录/口径时递增 */
  revision: z.number().int().positive().optional(),
  /** 2.0 扩展:口径/适用范围说明(样本、地区、单位等) */
  scopeNote: z.string().optional(),
  /** 2.0 扩展:摘录/数值是否与指定原文版本一致 */
  extractionCheck: z.enum(["UNCHECKED", "VERIFIED_AGAINST_SOURCE", "EXTRACTION_ISSUE"]).optional(),
  /** 2.0 扩展:该证据绑定的情报库来源版本 */
  versionId: z.string().min(1).optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ClaimSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  kind: z.enum(["fact", "inference", "unverified"]),
  evidenceIds: z.array(z.string().min(1)),
  calibration: CalibrationSchema.optional(),
  /** 置信度(发布门禁聚合):核查全过+多源+高等级信源=high;单源/弱核查=medium;降级=low */
  confidence: z.enum(["high", "medium", "low"]).optional(),
  /** 2.0 扩展:主张修订号 */
  revision: z.number().int().positive().optional(),
  /** 2.0 扩展:主张支持状态,只针对指定问题/证据/范围,不是永久真理标签 */
  supportStatus: z.enum(["SUPPORTED", "PARTIALLY_SUPPORTED", "CONTRADICTED", "UNRESOLVED"]).optional(),
  /** 2.0 扩展:适用范围说明(对象/时期/口径) */
  scopeNote: z.string().optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const CitationVerdictSchema = z.object({
  evidenceId: z.string().min(1),
  verdict: z.enum(["quote-hit", "quote-mismatch", "snapshot-missing"]),
  urlAlive: z.boolean().optional(),
  /** 语义蕴涵:strong 转述被引句支撑 / weak 弱支撑 / fail 不支撑 / na 无法判定 */
  entailment: z.enum(["strong", "weak", "fail", "na"]).optional(),
  /** 数值复算:ok 口径值与引句一致 / mismatch 不一致 / na 无口径值 */
  numeric: z.enum(["ok", "mismatch", "na"]).optional(),
  /** 该证据来源快照的信源等级 */
  tier: z.enum(["A", "B", "C"]).optional(),
});
export type CitationVerdict = z.infer<typeof CitationVerdictSchema>;

export const BudgetSchema = z.object({
  maxSearches: z.number().int().positive(),
  maxFetches: z.number().int().positive(),
  maxCostEstimate: z.number().positive(),
  maxWallMs: z.number().positive(),
  maxParallel: z.number().int().positive(),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const OutlineSectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  purpose: z.string().optional(),
  bullets: z.array(z.string().min(1)).default([]),
});
export type OutlineSection = z.infer<typeof OutlineSectionSchema>;

/** 报告框架:运行前由用户确认,决定报告的章节结构与呈现。 */
export const ReportOutlineSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  sections: z.array(OutlineSectionSchema).min(1),
});
export type ReportOutline = z.infer<typeof ReportOutlineSchema>;

export const ResearchRequestSchema = z.object({
  id: z.string().min(1).optional(),
  module: z.enum(["brand", "industry"]),
  goal: z.string().min(1),
  scope: z.object({
    summary: z.string().min(1),
    queries: z.array(z.string().min(1)),
  }),
  attachments: z.array(z.string()).default([]),
  budget: BudgetSchema.partial().optional(),
  /** 用户确认的报告框架;草稿与正式报告都按此结构组织。 */
  outline: ReportOutlineSchema.optional(),
  configVersion: z.string().optional(),
  /** 2.1 扩展:增量追问的基准运行(追问扩展而非重跑)。 */
  incrementalOf: z
    .object({
      runId: z.string().min(1),
      requestId: z.string().min(1),
    })
    .optional(),
  /** 报告丰满度:草稿后是否跑 polish 润色 pass(缺省=true;false 可降级省成本)。 */
  polish: z.boolean().optional(),
});
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

/** 2.1 扩展:执行中干预指令(在采证问题间隙消费,不打断进行中的调用)。 */
export const RunInstructionSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("skip-question"),
      /** 缺省为当前正在采证的问题。 */
      questionId: z.string().min(1).optional(),
    }),
    z.object({
      type: z.literal("add-questions"),
      questions: z.array(z.string().min(1)).min(1).max(6),
    }),
    z.object({
      type: z.literal("refine-direction"),
      note: z.string().min(1).max(500),
    }),
    z.object({
      type: z.literal("add-source"),
      url: z.string().url().optional(),
      text: z.string().min(1).optional(),
      title: z.string().optional(),
    }),
  ])
  .refine((v) => v.type !== "add-source" || v.url !== undefined || v.text !== undefined, {
    message: "add-source 需提供 url 或 text",
  });
export type RunInstruction = z.infer<typeof RunInstructionSchema>;

/** 2.1 扩展:干预的入队与消费记录(消费后追加进 run 记录)。 */
export const InterventionSchema = z.object({
  id: z.string().min(1),
  /** 指令提交时间(ISO)。 */
  submittedAt: z.string().min(1),
  instruction: RunInstructionSchema,
  /** 消费时间(ISO);仍在队列中未消费时缺省。 */
  consumedAt: z.string().min(1).optional(),
  /** applied 生效 / invalid 不适用(如跳过已答问题) / failed 尝试后失败。 */
  effect: z.enum(["applied", "invalid", "failed"]).optional(),
  /** 效果/失败/无效原因说明。 */
  detail: z.string().optional(),
});
export type Intervention = z.infer<typeof InterventionSchema>;

/** 2.1 扩展:采证进度摘要(供 UI 展示当前问题与计数,随每问推进更新)。 */
export const RunProgressSchema = z.object({
  currentQuestionId: z.string().min(1).optional(),
  currentQuestionText: z.string().optional(),
  answered: z.number().int().nonnegative(),
  open: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type RunProgress = z.infer<typeof RunProgressSchema>;

export const ResearchRunSchema = z.object({
  id: z.string().min(1),
  requestId: z.string().min(1),
  stage: z.enum(["plan", "gather", "analyze", "draft", "review", "publish"]),
  status: z.enum(["running", "cancelled", "failed", "published", "limited"]),
  checkpoints: z.array(z.string()),
  usage: z.object({
    searches: z.number().int().nonnegative(),
    fetches: z.number().int().nonnegative(),
    costEstimate: z.number().nonnegative(),
    wallMs: z.number().nonnegative(),
  }),
  error: z.string().optional(),
  /** 2.1 扩展:增量研究的基准 run。 */
  derivedFromRunId: z.string().min(1).optional(),
  /** 2.1 扩展:执行中干预历史(消费后追加)。 */
  interventions: z.array(InterventionSchema).optional(),
  /** 2.1 扩展:采证进度摘要。 */
  progress: RunProgressSchema.optional(),
});
export type ResearchRun = z.infer<typeof ResearchRunSchema>;

/** 2.1 扩展:增量研究的复用明细。 */
export const ReuseSummarySchema = z.object({
  baseRunId: z.string().min(1),
  reusedSnapshots: z.number().int().nonnegative(),
  reusedEvidence: z.number().int().nonnegative(),
  reusedClaims: z.number().int().nonnegative(),
  newQuestions: z.number().int().nonnegative(),
});
export type ReuseSummary = z.infer<typeof ReuseSummarySchema>;

export const ResearchResultBundleSchema = z.object({
  runId: z.string().min(1),
  version: z.number().int().nonnegative(),
  reportMd: z.string().min(1),
  reportHtml: z.string().optional(),
  claims: z.array(ClaimSchema),
  evidence: z.array(EvidenceSchema),
  snapshots: z.array(SourceSnapshotSchema),
  limitations: z.array(z.string()),
  unresolved: z.array(z.string()),
  verdicts: z.array(CitationVerdictSchema),
  auditSummary: z.string().optional(),
  /** 本次运行采用的报告框架(用户确认稿);旧版本可能缺省。 */
  outline: ReportOutlineSchema.optional(),
  /** 2.1 扩展:增量研究的基准 run。 */
  derivedFromRunId: z.string().min(1).optional(),
  /** 2.1 扩展:增量复用明细。 */
  reuseSummary: ReuseSummarySchema.optional(),
});
export type ResearchResultBundle = z.infer<typeof ResearchResultBundleSchema>;
