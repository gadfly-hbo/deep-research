import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  AcquisitionRecord,
  AssetBinding,
  Entity,
  ReviewRecord,
  Source,
  SourceVersion,
  UsageRecord,
} from "./contracts.js";
import type { LibraryStore } from "./types.js";

/**
 * workspace 级情报库存储:research-data/library/ 下的 JSON 字典文件 + audit.jsonl。
 * 与 FsProjectStore 同模式:同步文件写、整文件读回;规模上限内(千级资产)足够。
 */
export class FsLibraryStore implements LibraryStore {
  private constructor(readonly dir: string) {}

  static openOrCreate(dir: string): FsLibraryStore {
    mkdirSync(dir, { recursive: true });
    const store = new FsLibraryStore(dir);
    if (!existsSync(join(dir, "audit.jsonl"))) {
      store.audit("library-opened", {});
    }
    return store;
  }

  audit(event: string, data: unknown): void {
    appendFileSync(
      join(this.dir, "audit.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), event, data }) + "\n",
    );
  }

  private writeJson(rel: string, value: unknown): void {
    writeFileSync(join(this.dir, rel), JSON.stringify(value, null, 2));
  }

  private readJson<T>(rel: string, fallback: T): T {
    const path = join(this.dir, rel);
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  }

  private readDict<T>(file: string): Record<string, T> {
    return this.readJson<Record<string, T>>(file, {});
  }

  private async putInDict<T extends object>(file: string, key: string, value: T): Promise<void> {
    const all = this.readDict<T>(file);
    all[key] = value;
    this.writeJson(file, all);
  }

  async saveSource(source: Source): Promise<void> {
    await this.putInDict("sources.json", source.sourceId, source);
    this.audit("source-saved", { sourceId: source.sourceId, lifecycle: source.lifecycle });
  }

  async getSource(sourceId: string): Promise<Source | null> {
    return this.readDict<Source>("sources.json")[sourceId] ?? null;
  }

  async listSources(): Promise<Source[]> {
    return Object.values(this.readDict<Source>("sources.json"));
  }

  async saveVersion(version: SourceVersion): Promise<void> {
    await this.putInDict("versions.json", version.versionId, version);
    this.audit("version-saved", { versionId: version.versionId, sourceId: version.sourceId });
  }

  async getVersion(versionId: string): Promise<SourceVersion | null> {
    return this.readDict<SourceVersion>("versions.json")[versionId] ?? null;
  }

  async versionsForSource(sourceId: string): Promise<SourceVersion[]> {
    return Object.values(this.readDict<SourceVersion>("versions.json")).filter(
      (v) => v.sourceId === sourceId,
    );
  }

  async saveAcquisition(acquisition: AcquisitionRecord): Promise<void> {
    await this.putInDict("acquisitions.json", acquisition.acquisitionId, acquisition);
    this.audit("acquisition-saved", {
      acquisitionId: acquisition.acquisitionId,
      versionId: acquisition.versionId,
      reuseScope: acquisition.reuseScope,
    });
  }

  async getAcquisition(acquisitionId: string): Promise<AcquisitionRecord | null> {
    return this.readDict<AcquisitionRecord>("acquisitions.json")[acquisitionId] ?? null;
  }

  async acquisitionsForVersion(versionId: string): Promise<AcquisitionRecord[]> {
    return Object.values(this.readDict<AcquisitionRecord>("acquisitions.json")).filter(
      (a) => a.versionId === versionId,
    );
  }

  async findVersionByHash(contentHash: string): Promise<SourceVersion | null> {
    return (
      Object.values(this.readDict<SourceVersion>("versions.json")).find(
        (v) => v.contentHash === contentHash,
      ) ?? null
    );
  }

  async findAcquisitionByIdempotencyKey(key: string): Promise<AcquisitionRecord | null> {
    return (
      Object.values(this.readDict<AcquisitionRecord>("acquisitions.json")).find(
        (a) => a.idempotencyKey === key,
      ) ?? null
    );
  }

  async stageContent(content: string | Uint8Array): Promise<string> {
    const stagingId = randomUUID();
    mkdirSync(join(this.dir, "staging"), { recursive: true });
    writeFileSync(join(this.dir, "staging", stagingId), content);
    return stagingId;
  }

  async commitContent(stagingId: string): Promise<{ contentRef: string; contentHash: string }> {
    const stagingPath = join(this.dir, "staging", stagingId);
    if (!existsSync(stagingPath)) throw new Error(`暂存不存在: ${stagingId}`);
    const bytes = readFileSync(stagingPath);
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(join(this.dir, "files"), { recursive: true });
    const finalPath = join(this.dir, "files", contentHash);
    // 内容寻址:同内容已存在则直接复用(存储去重),不动授权记录
    if (!existsSync(finalPath)) {
      copyFileSync(stagingPath, finalPath);
    }
    rmSync(stagingPath);
    this.audit("content-committed", { contentHash });
    return { contentRef: `files/${contentHash}`, contentHash };
  }

  async readContent(contentRef: string): Promise<string | null> {
    // 只接受 library 内的 files/<hash> 引用,拒绝任意路径
    if (!/^files\/[0-9a-f]{64}$/.test(contentRef)) return null;
    const path = join(this.dir, contentRef);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8");
  }

  async recoverStaging(): Promise<string[]> {
    const stagingDir = join(this.dir, "staging");
    if (!existsSync(stagingDir)) return [];
    return readdirSync(stagingDir);
  }

  async saveEntity(entity: Entity): Promise<void> {
    await this.putInDict("entities.json", entity.entityId, entity);
    this.audit("entity-saved", { entityId: entity.entityId, type: entity.type });
  }

  async getEntity(entityId: string): Promise<Entity | null> {
    return this.readDict<Entity>("entities.json")[entityId] ?? null;
  }

  async listEntities(): Promise<Entity[]> {
    return Object.values(this.readDict<Entity>("entities.json"));
  }

  async saveBinding(binding: AssetBinding): Promise<void> {
    await this.putInDict("bindings.json", binding.bindingId, binding);
    this.audit("binding-saved", {
      bindingId: binding.bindingId,
      runId: binding.runId,
      versionId: binding.versionId,
      applicability: binding.applicability,
    });
  }

  async getBinding(bindingId: string): Promise<AssetBinding | null> {
    return this.readDict<AssetBinding>("bindings.json")[bindingId] ?? null;
  }

  async bindingsForRun(runId: string): Promise<AssetBinding[]> {
    return Object.values(this.readDict<AssetBinding>("bindings.json")).filter(
      (b) => b.runId === runId,
    );
  }

  async bindingsForVersion(versionId: string): Promise<AssetBinding[]> {
    return Object.values(this.readDict<AssetBinding>("bindings.json")).filter(
      (b) => b.versionId === versionId,
    );
  }

  async saveUsage(usage: UsageRecord): Promise<void> {
    await this.putInDict("usages.json", usage.usageId, usage);
    this.audit("usage-saved", { usageId: usage.usageId, runId: usage.runId, step: usage.step });
  }

  async usagesForRun(runId: string): Promise<UsageRecord[]> {
    return Object.values(this.readDict<UsageRecord>("usages.json")).filter(
      (u) => u.runId === runId,
    );
  }

  async saveReview(review: ReviewRecord): Promise<void> {
    await this.putInDict("reviews.json", review.reviewId, review);
    this.audit("review-saved", {
      reviewId: review.reviewId,
      objectRef: review.objectRef,
      result: review.result,
    });
  }

  async reviewsFor(objectRef: string): Promise<ReviewRecord[]> {
    return Object.values(this.readDict<ReviewRecord>("reviews.json")).filter(
      (r) => r.objectRef === objectRef,
    );
  }

  private removeFromDict<T extends object>(file: string, key: string): void {
    const all = this.readDict<T>(file);
    delete all[key];
    this.writeJson(file, all);
  }

  async removeSource(sourceId: string): Promise<void> {
    this.removeFromDict("sources.json", sourceId);
    this.audit("source-removed", { sourceId });
  }

  async removeVersion(versionId: string): Promise<void> {
    this.removeFromDict("versions.json", versionId);
    this.audit("version-removed", { versionId });
  }

  async removeContent(contentRef: string): Promise<void> {
    if (!/^files\/[0-9a-f]{64}$/.test(contentRef)) return;
    rmSync(join(this.dir, contentRef), { force: true });
    this.audit("content-removed", { contentRef });
  }
}
