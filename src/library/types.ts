import type {
  AcquisitionRecord,
  AssetBinding,
  Entity,
  ReviewRecord,
  Source,
  SourceVersion,
  UsageRecord,
} from "./contracts.js";

/**
 * LibraryStore —— 情报库 seam:所有资产读写经此接口。
 * 测试用临时目录真实文件系统(FsLibraryStore)或内存实现驱动。
 */
export interface LibraryStore {
  /** 存储根目录(索引/内容文件/暂存位的归属地) */
  readonly dir: string;
  saveSource(source: Source): Promise<void>;
  getSource(sourceId: string): Promise<Source | null>;
  listSources(): Promise<Source[]>;
  saveVersion(version: SourceVersion): Promise<void>;
  getVersion(versionId: string): Promise<SourceVersion | null>;
  versionsForSource(sourceId: string): Promise<SourceVersion[]>;
  saveAcquisition(acquisition: AcquisitionRecord): Promise<void>;
  getAcquisition(acquisitionId: string): Promise<AcquisitionRecord | null>;
  acquisitionsForVersion(versionId: string): Promise<AcquisitionRecord[]>;
  /** 精确内容去重(§U2-07):相同 SHA-256 找已存版本 */
  findVersionByHash(contentHash: string): Promise<SourceVersion | null>;
  /** 重试去重(§12.3):同一幂等键不产生重复登记 */
  findAcquisitionByIdempotencyKey(key: string): Promise<AcquisitionRecord | null>;
  /** 两阶段提交(§12.3):先写受控暂存位,完整性检查后 commit 才进正式引用 */
  stageContent(content: string | Uint8Array): Promise<string>;
  commitContent(stagingId: string): Promise<{ contentRef: string; contentHash: string }>;
  readContent(contentRef: string): Promise<string | null>;
  /** 启动协调检查:列出未提交的暂存残留(待恢复/失败,不进可用清单) */
  recoverStaging(): Promise<string[]>;
  saveEntity(entity: Entity): Promise<void>;
  getEntity(entityId: string): Promise<Entity | null>;
  listEntities(): Promise<Entity[]>;
  saveBinding(binding: AssetBinding): Promise<void>;
  getBinding(bindingId: string): Promise<AssetBinding | null>;
  bindingsForRun(runId: string): Promise<AssetBinding[]>;
  /** 受影响引用清单(撤回/更正时用):哪些运行绑定了该版本 */
  bindingsForVersion(versionId: string): Promise<AssetBinding[]>;
  saveUsage(usage: UsageRecord): Promise<void>;
  usagesForRun(runId: string): Promise<UsageRecord[]>;
  saveReview(review: ReviewRecord): Promise<void>;
  reviewsFor(objectRef: string): Promise<ReviewRecord[]>;
  /** 永久删除(§9.4):仅在用户明确确认后由 lifecycle 服务调用 */
  removeSource(sourceId: string): Promise<void>;
  removeVersion(versionId: string): Promise<void>;
  removeContent(contentRef: string): Promise<void>;
  audit(event: string, data: unknown): void;
}
