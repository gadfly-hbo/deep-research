import { z } from "zod";

/**
 * 深度研究工作台 2.0 —— 外部情报库契约。
 * 逻辑对象对应 proposal §8.1;状态枚举对应 §9.1;时间语义对应 §8.3。
 * 均为 workspace 级对象,与研究核心(项目级)契约分离但互相引用(versionId 等)。
 */

/** 复用范围(§9.1):在哪些范围允许使用,不等于事实已核验 */
export const ReuseScopeSchema = z.enum(["PROJECT_ONLY", "WORKSPACE_REUSABLE", "RESTRICTED"]);
export type ReuseScope = z.infer<typeof ReuseScopeSchema>;

/** 生命周期(§9.1):归档不删除;撤回禁止新使用并提示旧引用 */
export const LifecycleSchema = z.enum(["ACTIVE", "ARCHIVED", "WITHDRAWN"]);
export type Lifecycle = z.infer<typeof LifecycleSchema>;

/** 取得状态(§9.1):说明真正拿到多少内容 */
export const FetchStatusSchema = z.enum([
  "DISCOVERED",
  "SNIPPET_ONLY",
  "READ_PARTIAL",
  "READ_FULL",
  "UNAVAILABLE",
]);
export type FetchStatus = z.infer<typeof FetchStatusSchema>;

/** 任务适用性(§9.1):在某研究内计算,不是全局永久状态 */
export const ApplicabilitySchema = z.enum([
  "ELIGIBLE",
  "LEAD_ONLY",
  "NEEDS_REVIEW",
  "NOT_APPLICABLE",
  "FORBIDDEN",
]);
export type Applicability = z.infer<typeof ApplicabilitySchema>;

/**
 * 使用权利(§9.3):逐项显式授予;缺省 = 未声明 = 服务层默认拒绝。
 * 同一内容的不同取得记录可有不同权利,不得因内容去重而合并。
 */
export const RightsSchema = z.object({
  localRetention: z.boolean().optional(),
  projectView: z.boolean().optional(),
  crossProjectReuse: z.boolean().optional(),
  sendToExternalModel: z.boolean().optional(),
  sendToExternalParser: z.boolean().optional(),
  exportFulltext: z.boolean().optional(),
  exportExcerpt: z.boolean().optional(),
});
export type Rights = z.infer<typeof RightsSchema>;

export const DocTypeSchema = z.enum([
  "consumer-profile",
  "financial-disclosure",
  "job-posting",
  "industry-report",
  "media-article",
  "research-report",
  "other",
]);
export type DocType = z.infer<typeof DocTypeSchema>;

/** 转引链/原始出处(§7.2):直接披露者、实际取得来源、上游候选与是否已取得原文 */
export const OriginSchema = z.object({
  directPublisher: z.string().optional(),
  upstreamSourceId: z.string().min(1).optional(),
  obtainedUpstream: z.boolean().default(false),
});
export type Origin = z.infer<typeof OriginSchema>;

export const SourceSchema = z.object({
  sourceId: z.string().min(1),
  title: z.string(),
  /** 链接类来源的原始 URL;文件类为空 */
  url: z.string().optional(),
  publisher: z.string().optional(),
  docType: DocTypeSchema.default("other"),
  origin: OriginSchema.optional(),
  entityIds: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string()).default([]),
  lifecycle: LifecycleSchema.default("ACTIVE"),
  /** 自有报告派生标记(§7.3):工作台产出的研究成果作为资产入库时记录其派生运行 */
  derivedFromRunId: z.string().min(1).optional(),
  createdAt: z.string().min(1),
});
export type Source = z.infer<typeof SourceSchema>;

export const SourceVersionSchema = z.object({
  versionId: z.string().min(1),
  sourceId: z.string().min(1),
  /** 内容引用:library/files/<hash> 或兼容的原项目路径 */
  contentRef: z.string().optional(),
  /** SHA-256;辅助识别相同内容与完整性,不证明真实、不授予使用权 */
  contentHash: z.string().optional(),
  fetchStatus: FetchStatusSchema,
  /** 解析状态(A-04):取得成功不等于解析完整;失败/部分必须在详情可见 */
  parseStatus: z.enum(["ok", "failed", "partial"]).optional(),
  parseIssue: z.string().optional(),
  /** §8.3 三类时间:发布时间(未知可为空)/外部可用时间(有依据才记)/数据所属期间 */
  publishedAt: z.string().optional(),
  availableAt: z.string().optional(),
  dataPeriod: z.string().optional(),
  /** 更正关系(§5.4):本版本更正了谁 / 被谁更正 */
  supersedesVersionId: z.string().min(1).optional(),
  correctedBy: z.string().min(1).optional(),
  withdrawnReason: z.string().optional(),
  createdAt: z.string().min(1),
});
export type SourceVersion = z.infer<typeof SourceVersionSchema>;

export const AcquisitionMethodSchema = z.enum([
  "user-file",
  "user-link",
  "research-fetch",
  "migration",
]);
export type AcquisitionMethod = z.infer<typeof AcquisitionMethodSchema>;

export const AcquisitionRecordSchema = z.object({
  acquisitionId: z.string().min(1),
  versionId: z.string().min(1),
  /** 无 projectId = 工作台直接入库(不依赖研究任务) */
  projectId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  acquiredAt: z.string().min(1),
  recordedAt: z.string().min(1),
  method: AcquisitionMethodSchema,
  readScope: FetchStatusSchema,
  reuseScope: ReuseScopeSchema.default("PROJECT_ONLY"),
  rights: RightsSchema.default({}),
  /** 重试去重:同一幂等键不产生重复登记 */
  idempotencyKey: z.string().min(1).optional(),
});
export type AcquisitionRecord = z.infer<typeof AcquisitionRecordSchema>;

/** 轻量实体(§11.5):不按字符串相似度自动合并;合并需依据并可追溯 */
export const EntitySchema = z.object({
  entityId: z.string().min(1),
  type: z.enum(["brand", "group", "industry", "region", "other"]),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  parentEntityId: z.string().min(1).optional(),
  confirmStatus: z.enum(["CONFIRMED", "CANDIDATE"]).default("CANDIDATE"),
  /** 确认/合并依据 */
  basis: z.string().optional(),
});
export type Entity = z.infer<typeof EntitySchema>;

/**
 * 固定版本绑定(§8.4):某运行选择了哪个资产的哪个精确版本。
 * 快照一旦生成不静默覆盖;引用指向固定版本,不指向"最新"别名。
 */
export const AssetBindingSchema = z.object({
  bindingId: z.string().min(1),
  runId: z.string().min(1),
  projectId: z.string().min(1),
  sourceId: z.string().min(1),
  versionId: z.string().min(1),
  /** evidenceId -> 绑定的证据修订号 */
  evidenceRevisions: z.record(z.string().min(1), z.number().int().positive()).default({}),
  purpose: z.string().min(1),
  applicability: ApplicabilitySchema,
  /** 当前研究允许采用信息的截止点 */
  asOf: z.string().optional(),
  /** 适用性/权限检查的缺口与原因 */
  checkNotes: z.array(z.string()).default([]),
  /** 重试去重:同一幂等键的绑定请求返回原绑定 */
  idempotencyKey: z.string().min(1).optional(),
  boundAt: z.string().min(1),
});
export type AssetBinding = z.infer<typeof AssetBindingSchema>;

export const UsageRecordSchema = z.object({
  usageId: z.string().min(1),
  runId: z.string().min(1),
  bindingId: z.string().min(1),
  /** 使用发生的步骤(plan/gather/analyze/draft/review/publish) */
  step: z.string().min(1),
  contentVersionId: z.string().min(1),
  /** 报告引用位置(发布阶段填写) */
  reportSection: z.string().optional(),
  usedAt: z.string().min(1),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

/** 核验记录(§8.1):某对象在某范围下的一次核验,责任主体可追溯 */
export const ReviewRecordSchema = z.object({
  reviewId: z.string().min(1),
  /** 被核验对象:sourceId / versionId / evidenceId / claimId */
  objectRef: z.string().min(1),
  /** 核验范围(如 runId 或 "library") */
  scope: z.string().min(1),
  checkType: z.enum(["extraction", "support", "permission", "applicability", "correction"]),
  result: z.enum(["pass", "fail", "issue"]),
  reason: z.string().optional(),
  reviewedAt: z.string().min(1),
  /** system:<checker> / user / module:<name> */
  reviewer: z.string().min(1),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;
