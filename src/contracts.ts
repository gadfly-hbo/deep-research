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
});
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

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
});
export type ResearchRun = z.infer<typeof ResearchRunSchema>;

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
});
export type ResearchResultBundle = z.infer<typeof ResearchResultBundleSchema>;
