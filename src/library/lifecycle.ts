import { randomUUID } from "node:crypto";
import type { AssetBinding, Lifecycle, SourceVersion } from "./contracts.js";
import { dropIndex } from "./searchService.js";
import type { LibraryStore } from "./types.js";

export interface LifecycleOutcome {
  sourceId: string;
  lifecycle: Lifecycle;
  affectedBindings: AssetBinding[];
}

/**
 * 归档/撤回/恢复(§9.4):归档不删除;撤回禁止新使用并提示旧引用。
 * 已有绑定不被改写——历史可解释性优先。
 */
export async function changeLifecycle(
  store: LibraryStore,
  sourceId: string,
  lifecycle: Lifecycle,
  reason?: string,
): Promise<LifecycleOutcome> {
  const source = await store.getSource(sourceId);
  if (!source) throw new Error(`资产不存在: ${sourceId}`);
  await store.saveSource({ ...source, lifecycle });
  const versions = await store.versionsForSource(sourceId);
  for (const v of versions) {
    await store.saveVersion({
      ...v,
      withdrawnReason: lifecycle === "WITHDRAWN" ? (reason ?? "资产已撤回") : undefined,
    });
  }
  const affected: AssetBinding[] = (
    await Promise.all(versions.map((v) => store.bindingsForVersion(v.versionId)))
  ).flat();
  store.audit("lifecycle-changed", { sourceId, lifecycle, reason: reason ?? null, affected: affected.length });
  return { sourceId, lifecycle, affectedBindings: affected };
}

/**
 * 更正版本(§5.4/A-13):同一资料的新内容产生新版本并记录更正关系;
 * 旧版本与旧绑定原样保留,不静默替换已绑定原文。
 */
export async function correctVersion(
  store: LibraryStore,
  sourceId: string,
  oldVersionId: string,
  newContent: string,
): Promise<SourceVersion> {
  const oldVersion = await store.getVersion(oldVersionId);
  if (!oldVersion || oldVersion.sourceId !== sourceId) {
    throw new Error(`版本不存在或不属于该来源: ${oldVersionId}`);
  }
  const now = new Date().toISOString();
  const staging = await store.stageContent(newContent);
  const { contentRef, contentHash } = await store.commitContent(staging);
  const version: SourceVersion = {
    versionId: `sv-${contentHash.slice(0, 12)}`,
    sourceId,
    contentRef,
    contentHash,
    fetchStatus: "READ_FULL",
    parseStatus: "ok",
    supersedesVersionId: oldVersionId,
    createdAt: now,
  };
  await store.saveVersion(version);
  await store.saveVersion({ ...oldVersion, correctedBy: version.versionId });
  store.audit("version-corrected", { sourceId, oldVersionId, newVersionId: version.versionId });
  return version;
}

export interface DeletePreview {
  sourceId: string;
  affectedRuns: string[];
  versionCount: number;
}

export interface DeleteOutcome extends DeletePreview {
  deleted: boolean;
}

/**
 * 永久删除(§9.4):先给受影响引用预览;未确认不执行;有绑定时需 force。
 * 取得记录(acquisitions)作为最小审计保留;索引删除后可重建。
 */
export async function deleteAsset(
  store: LibraryStore,
  sourceId: string,
  opts: { confirm?: boolean; previewOnly?: boolean; force?: boolean },
): Promise<DeleteOutcome> {
  const source = await store.getSource(sourceId);
  if (!source) throw new Error(`资产不存在: ${sourceId}`);
  const versions = await store.versionsForSource(sourceId);
  const bindings = (await Promise.all(versions.map((v) => store.bindingsForVersion(v.versionId)))).flat();
  const affectedRuns = [...new Set(bindings.map((b) => b.runId))];
  const preview: DeletePreview = { sourceId, affectedRuns, versionCount: versions.length };
  if (opts.previewOnly) return { ...preview, deleted: false };
  if (!opts.confirm) {
    throw new Error(`删除需要明确确认:影响运行 ${affectedRuns.join(", ") || "无"}`);
  }
  if (bindings.length > 0 && !opts.force) {
    throw new Error(`该资产被 ${bindings.length} 条绑定引用(运行:${affectedRuns.join(", ")});确认影响后以 force 删除`);
  }
  for (const v of versions) {
    if (v.contentRef) {
      const otherVersions = (await store.versionsForSource(sourceId)).filter(
        (x) => x.versionId !== v.versionId && x.contentRef === v.contentRef,
      );
      if (otherVersions.length === 0) await store.removeContent(v.contentRef);
    }
    await store.removeVersion(v.versionId);
  }
  await store.removeSource(sourceId);
  dropIndex(store);
  store.audit("asset-deleted", { sourceId, affectedRuns, versions: versions.length });
  return { ...preview, deleted: true };
}
