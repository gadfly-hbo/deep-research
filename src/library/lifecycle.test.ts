import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAsset } from "./assetService.js";
import { FsLibraryStore } from "./fsLibraryStore.js";
import { changeLifecycle, correctVersion, deleteAsset } from "./lifecycle.js";
import { bindAssets, checkReuse } from "./reuse.js";

describe("生命周期治理(U2-08 / §9.4)", () => {
  let dir: string;
  let store: FsLibraryStore;
  let asset: { sourceId: string; versionId: string };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lib-life-"));
    store = FsLibraryStore.openOrCreate(dir);
    asset = await registerAsset(store, {
      kind: "file",
      filename: "画像.md",
      content: "关注者样本女性 62%。",
      reuseScope: "WORKSPACE_REUSABLE",
    });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("撤回:禁止新绑定并提示旧引用,归档需复核(S-07)", async () => {
    await bindAssets(store, {
      runId: "run-old",
      projectId: "p-1",
      bindings: [{ sourceId: asset.sourceId, versionId: asset.versionId, purpose: "旧研究", applicability: "ELIGIBLE" }],
    });
    const out = await changeLifecycle(store, asset.sourceId, "WITHDRAWN", "机构撤稿");
    expect(out.affectedBindings).toHaveLength(1);
    const check = await checkReuse(store, {
      runId: "run-new",
      projectId: "p-1",
      sourceId: asset.sourceId,
      versionId: asset.versionId,
      purpose: "新研究",
    });
    expect(check.applicability).toBe("FORBIDDEN");
    // 旧绑定仍在,历史可解释
    expect(await store.bindingsForVersion(asset.versionId)).toHaveLength(1);

    await changeLifecycle(store, asset.sourceId, "ACTIVE");
    const archived = await changeLifecycle(store, asset.sourceId, "ARCHIVED");
    expect(archived.affectedBindings).toHaveLength(1);
    const archCheck = await checkReuse(store, {
      runId: "run-new2",
      projectId: "p-1",
      sourceId: asset.sourceId,
      versionId: asset.versionId,
      purpose: "新研究",
    });
    expect(archCheck.applicability).toBe("NEEDS_REVIEW");
  });

  it("更正:产生新版本且旧研究绑定不变(A-13)", async () => {
    await bindAssets(store, {
      runId: "run-old",
      projectId: "p-1",
      bindings: [{ sourceId: asset.sourceId, versionId: asset.versionId, purpose: "旧研究", applicability: "ELIGIBLE" }],
    });
    const corrected = await correctVersion(store, asset.sourceId, asset.versionId, "更正后正文:样本口径扩大说明。");
    expect(corrected.supersedesVersionId).toBe(asset.versionId);
    const oldVersion = await store.getVersion(asset.versionId);
    expect(oldVersion?.correctedBy).toBe(corrected.versionId);
    // 旧绑定仍指向旧版本
    expect((await store.bindingsForRun("run-old"))[0].versionId).toBe(asset.versionId);
    // 新绑定可用新版本
    const newBind = await bindAssets(store, {
      runId: "run-new",
      projectId: "p-1",
      bindings: [{ sourceId: asset.sourceId, versionId: corrected.versionId, purpose: "更新研究", applicability: "ELIGIBLE" }],
    });
    expect(newBind.bindings).toHaveLength(1);
  });

  it("删除:未确认拒绝;确认后清理元数据并列出受影响引用", async () => {
    await bindAssets(store, {
      runId: "run-old",
      projectId: "p-1",
      bindings: [{ sourceId: asset.sourceId, versionId: asset.versionId, purpose: "旧研究", applicability: "ELIGIBLE" }],
    });
    await expect(deleteAsset(store, asset.sourceId, { confirm: false })).rejects.toThrow(/确认/);
    const preview = await deleteAsset(store, asset.sourceId, { confirm: false, previewOnly: true });
    expect(preview.affectedRuns).toEqual(["run-old"]);
    const done = await deleteAsset(store, asset.sourceId, { confirm: true, force: true });
    expect(done.deleted).toBe(true);
    expect(await store.getSource(asset.sourceId)).toBeNull();
    expect(await store.getVersion(asset.versionId)).toBeNull();
  });
});
