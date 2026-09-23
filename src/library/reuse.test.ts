import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerAsset } from "./assetService.js";
import { FsLibraryStore } from "./fsLibraryStore.js";
import { bindAssets, checkReuse, type ReuseCheckInput } from "./reuse.js";

describe("checkReuse 适用性与权限检查(§9.2 顺序)", () => {
  let dir: string;
  let store: FsLibraryStore;
  let reusable: { sourceId: string; versionId: string };
  let projectOnly: { sourceId: string; versionId: string };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lib-reuse-"));
    store = FsLibraryStore.openOrCreate(dir);
    reusable = await registerAsset(store, {
      kind: "file",
      filename: "可复用画像.md",
      content: "某平台品牌关注者样本中女性占 62%。",
      reuseScope: "WORKSPACE_REUSABLE",
    });
    projectOnly = await registerAsset(store, {
      kind: "file",
      filename: "项目内笔记.md",
      content: "仅项目内的访谈纪要摘录。",
      projectId: "p-owner",
    });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const input = (over: Partial<ReuseCheckInput>): ReuseCheckInput => ({
    runId: "run-x",
    projectId: "p-new",
    sourceId: reusable.sourceId,
    versionId: reusable.versionId,
    purpose: "品牌案例输入",
    ...over,
  });

  it("授权优先:其他项目的 PROJECT_ONLY 资产直接 FORBIDDEN(S-01)", async () => {
    const out = await checkReuse(store, input({ sourceId: projectOnly.sourceId, versionId: projectOnly.versionId }));
    expect(out.applicability).toBe("FORBIDDEN");
    expect(out.checkNotes.join()).toContain("权限");
  });

  it("本项目的资产与 WORKSPACE_REUSABLE 资产均 ELIGIBLE", async () => {
    const own = await checkReuse(
      store,
      input({ projectId: "p-owner", sourceId: projectOnly.sourceId, versionId: projectOnly.versionId }),
    );
    expect(own.applicability).toBe("ELIGIBLE");
    const shared = await checkReuse(store, input({}));
    expect(shared.applicability).toBe("ELIGIBLE");
  });

  it("仅登记的链接=线索(LEAD_ONLY),解析缺口=需复核,撤回=禁止新使用", async () => {
    const link = await registerAsset(store, {
      kind: "link",
      url: "https://example.com/lead",
      title: "线索页",
      reuseScope: "WORKSPACE_REUSABLE",
    });
    const lead = await checkReuse(store, input({ sourceId: link.sourceId, versionId: link.versionId }));
    expect(lead.applicability).toBe("LEAD_ONLY");

    const failed = await registerAsset(
      store,
      {
        kind: "file",
        filename: "扫描.pdf",
        content: new Uint8Array([1]),
        reuseScope: "WORKSPACE_REUSABLE",
      },
      { parsePdf: async () => ({ bodyText: "", parseStatus: "failed" as const }) },
    );
    const need = await checkReuse(store, input({ sourceId: failed.sourceId, versionId: failed.versionId }));
    expect(need.applicability).toBe("NEEDS_REVIEW");

    const source = (await store.getSource(reusable.sourceId))!;
    await store.saveSource({ ...source, lifecycle: "WITHDRAWN" });
    const withdrawn = await checkReuse(store, input({}));
    expect(withdrawn.applicability).toBe("FORBIDDEN");
  });

  it("自有报告为派生成果:只作线索且标注派生关系(A-10)", async () => {
    const derived = await registerAsset(store, {
      kind: "file",
      filename: "旧报告摘录.md",
      content: "旧研究结论:市场规模上升。",
      docType: "research-report",
      reuseScope: "WORKSPACE_REUSABLE",
    });
    const source = (await store.getSource(derived.sourceId))!;
    await store.saveSource({ ...source, derivedFromRunId: "run-old" });
    const out = await checkReuse(store, input({ sourceId: derived.sourceId, versionId: derived.versionId }));
    expect(out.applicability).toBe("LEAD_ONLY");
    expect(out.checkNotes.join()).toContain("派生");
  });

  it("截止点检查:发布时间晚于 as_of 的信息不得用于当时判断(A-15)", async () => {
    const source = (await store.getSource(reusable.sourceId))!;
    const versions = await store.versionsForSource(source.sourceId);
    await store.saveVersion({ ...versions[0], publishedAt: "2026-08-01T00:00:00.000Z" });
    const out = await checkReuse(store, input({ asOf: "2026-01-01T00:00:00.000Z" }));
    expect(out.applicability).toBe("NEEDS_REVIEW");
    expect(out.checkNotes.join()).toContain("截止");
  });
});

describe("bindAssets 固定版本绑定(§8.4)", () => {
  let dir: string;
  let store: FsLibraryStore;
  let asset: { sourceId: string; versionId: string };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "lib-bind-"));
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

  it("绑定固定到精确版本与证据修订", async () => {
    const out = await bindAssets(store, {
      runId: "run-1",
      projectId: "p-1",
      idempotencyKey: "bind-1",
      bindings: [
        {
          sourceId: asset.sourceId,
          versionId: asset.versionId,
          purpose: "品牌案例",
          applicability: "ELIGIBLE",
          evidenceRevisions: { "ev-1": 1 },
          asOf: "2026-09-23T00:00:00.000Z",
          checkNotes: [],
        },
      ],
    });
    expect(out.bindings).toHaveLength(1);
    const binding = (await store.bindingsForRun("run-1"))[0];
    expect(binding.versionId).toBe(asset.versionId);
    expect(binding.evidenceRevisions["ev-1"]).toBe(1);
  });

  it("幂等:同一键重复提交返回原绑定,不产生重复(S-09)", async () => {
    const first = await bindAssets(store, {
      runId: "run-1",
      projectId: "p-1",
      idempotencyKey: "bind-1",
      bindings: [{ sourceId: asset.sourceId, versionId: asset.versionId, purpose: "案例", applicability: "ELIGIBLE" }],
    });
    const again = await bindAssets(store, {
      runId: "run-1",
      projectId: "p-1",
      idempotencyKey: "bind-1",
      bindings: [{ sourceId: asset.sourceId, versionId: asset.versionId, purpose: "案例", applicability: "ELIGIBLE" }],
    });
    expect(again.bindings.map((b) => b.bindingId)).toEqual(first.bindings.map((b) => b.bindingId));
    expect(await store.bindingsForRun("run-1")).toHaveLength(1);
  });

  it("同一版本可被两个运行独立绑定(A-12)", async () => {
    await bindAssets(store, {
      runId: "run-1",
      projectId: "p-1",
      bindings: [{ sourceId: asset.sourceId, versionId: asset.versionId, purpose: "案例", applicability: "ELIGIBLE" }],
    });
    await bindAssets(store, {
      runId: "run-2",
      projectId: "p-2",
      bindings: [{ sourceId: asset.sourceId, versionId: asset.versionId, purpose: "行业对照", applicability: "LEAD_ONLY" }],
    });
    expect((await store.bindingsForVersion(asset.versionId)).length).toBe(2);
  });

  it("FORBIDDEN 绑定被拒绝且不落库", async () => {
    const other = await registerAsset(store, { kind: "file", filename: "私.md", content: "私有", projectId: "p-owner" });
    const out = await bindAssets(store, {
      runId: "run-1",
      projectId: "p-1",
      bindings: [{ sourceId: other.sourceId, versionId: other.versionId, purpose: "x", applicability: "FORBIDDEN" }],
    });
    expect(out.rejected).toHaveLength(1);
    expect(await store.bindingsForRun("run-1")).toHaveLength(0);
  });
});
