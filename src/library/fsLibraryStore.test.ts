import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcquisitionRecord, Source, SourceVersion } from "./contracts.js";
import { FsLibraryStore } from "./fsLibraryStore.js";

function sampleSource(over: Partial<Source> = {}): Source {
  return {
    sourceId: "s-1",
    title: "某机构消费者画像报告",
    docType: "consumer-profile",
    entityIds: [],
    tags: [],
    lifecycle: "ACTIVE",
    createdAt: "2026-09-23T00:00:00.000Z",
    ...over,
  };
}

function sampleVersion(over: Partial<SourceVersion> = {}): SourceVersion {
  return {
    versionId: "sv-1",
    sourceId: "s-1",
    fetchStatus: "READ_FULL",
    createdAt: "2026-09-23T00:00:01.000Z",
    ...over,
  };
}

function sampleAcquisition(over: Partial<AcquisitionRecord> = {}): AcquisitionRecord {
  return {
    acquisitionId: "aq-1",
    versionId: "sv-1",
    acquiredAt: "2026-09-23T00:00:02.000Z",
    recordedAt: "2026-09-23T00:00:02.000Z",
    method: "user-file",
    readScope: "READ_FULL",
    reuseScope: "PROJECT_ONLY",
    rights: {},
    ...over,
  };
}

describe("FsLibraryStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lib-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("写入 Source/Version/Acquisition 后可读回(端到端穿越存储层)", async () => {
    const store = FsLibraryStore.openOrCreate(dir);
    await store.saveSource(sampleSource());
    await store.saveVersion(sampleVersion());
    await store.saveAcquisition(sampleAcquisition());

    expect((await store.getSource("s-1"))?.title).toBe("某机构消费者画像报告");
    expect((await store.getVersion("sv-1"))?.fetchStatus).toBe("READ_FULL");
    const acqs = await store.acquisitionsForVersion("sv-1");
    expect(acqs).toHaveLength(1);
    expect(acqs[0].reuseScope).toBe("PROJECT_ONLY");
    expect(await store.versionsForSource("s-1")).toHaveLength(1);
  });

  it("重新打开已有目录时数据仍在(openOrCreate 幂等)", async () => {
    const store = FsLibraryStore.openOrCreate(dir);
    await store.saveSource(sampleSource());
    const reopened = FsLibraryStore.openOrCreate(dir);
    expect((await reopened.getSource("s-1"))?.sourceId).toBe("s-1");
  });

  it("缺失对象返回 null,列表为空时返回空数组", async () => {
    const store = FsLibraryStore.openOrCreate(dir);
    expect(await store.getSource("s-nope")).toBeNull();
    expect(await store.listSources()).toEqual([]);
  });

  it("按内容哈希找版本(精确去重入口),按幂等键找取得记录(重试去重入口)", async () => {
    const store = FsLibraryStore.openOrCreate(dir);
    await store.saveSource(sampleSource());
    await store.saveVersion(sampleVersion({ contentHash: "hash-abc" }));
    await store.saveAcquisition(sampleAcquisition({ idempotencyKey: "key-1" }));

    expect((await store.findVersionByHash("hash-abc"))?.versionId).toBe("sv-1");
    expect(await store.findVersionByHash("hash-nope")).toBeNull();
    expect((await store.findAcquisitionByIdempotencyKey("key-1"))?.acquisitionId).toBe("aq-1");
    expect(await store.findAcquisitionByIdempotencyKey("key-nope")).toBeNull();
  });

  it("内容两阶段提交:暂存→提交得内容寻址引用,未提交残留可识别且不可读", async () => {
    const store = FsLibraryStore.openOrCreate(dir);
    const stagingId = await store.stageContent("女性比例为 62%(某平台关注者样本)");
    expect(stagingId).toBeTruthy();
    // 未提交:残留在恢复清单,正式读取不可得
    expect(await store.recoverStaging()).toContain(stagingId);
    expect(await store.readContent(`files/${stagingId}`)).toBeNull();

    const { contentRef, contentHash } = await store.commitContent(stagingId);
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(contentRef).toBe(`files/${contentHash}`);
    expect(await store.readContent(contentRef)).toContain("62%");
    // 已提交:不再出现在恢复清单
    expect(await store.recoverStaging()).not.toContain(stagingId);
  });

  it("存储层内容去重:相同内容两次提交指向同一文件,但取得记录各自独立", async () => {
    const store = FsLibraryStore.openOrCreate(dir);
    const s1 = await store.stageContent("同一份财报正文");
    const c1 = await store.commitContent(s1);
    const s2 = await store.stageContent("同一份财报正文");
    const c2 = await store.commitContent(s2);
    expect(c1.contentRef).toBe(c2.contentRef);
    // 授权不随内容合并:两条 AcquisitionRecord 各自存在(§8.1)
    await store.saveVersion(sampleVersion({ contentRef: c1.contentRef, contentHash: c1.contentHash }));
    await store.saveAcquisition(sampleAcquisition({ acquisitionId: "aq-a", rights: { exportFulltext: false } }));
    await store.saveAcquisition(
      sampleAcquisition({ acquisitionId: "aq-b", projectId: "p-2", rights: { exportFulltext: true } }),
    );
    const acqs = await store.acquisitionsForVersion("sv-1");
    expect(acqs).toHaveLength(2);
    expect(acqs.find((a) => a.acquisitionId === "aq-a")?.rights.exportFulltext).toBe(false);
    expect(acqs.find((a) => a.acquisitionId === "aq-b")?.rights.exportFulltext).toBe(true);
  });

  it("实体/绑定/使用/核验记录读写,绑定可按运行与版本反查", async () => {
    const store = FsLibraryStore.openOrCreate(dir);
    await store.saveSource(sampleSource());
    await store.saveVersion(sampleVersion());
    await store.saveEntity({
      entityId: "en-1",
      type: "brand",
      name: "森马",
      aliases: ["Semir"],
      confirmStatus: "CANDIDATE",
    });
    await store.saveBinding({
      bindingId: "b-1",
      runId: "run-1",
      projectId: "p-1",
      sourceId: "s-1",
      versionId: "sv-1",
      evidenceRevisions: {},
      purpose: "品牌案例输入",
      applicability: "ELIGIBLE",
      boundAt: "2026-09-23T02:00:00.000Z",
      checkNotes: [],
    });
    await store.saveUsage({
      usageId: "u-1",
      runId: "run-1",
      bindingId: "b-1",
      step: "analyze",
      contentVersionId: "sv-1",
      usedAt: "2026-09-23T02:30:00.000Z",
    });
    await store.saveReview({
      reviewId: "rr-1",
      objectRef: "sv-1",
      scope: "run-1",
      checkType: "extraction",
      result: "pass",
      reviewedAt: "2026-09-23T03:00:00.000Z",
      reviewer: "system:test",
    });

    expect((await store.getEntity("en-1"))?.aliases).toContain("Semir");
    expect((await store.listEntities()).length).toBe(1);
    expect((await store.bindingsForRun("run-1"))[0].versionId).toBe("sv-1");
    expect((await store.bindingsForVersion("sv-1"))[0].runId).toBe("run-1");
    expect((await store.usagesForRun("run-1"))[0].step).toBe("analyze");
    expect((await store.reviewsFor("sv-1"))[0].result).toBe("pass");
  });

  it("写操作追加 library 级审计流(可追溯)", async () => {
    const store = FsLibraryStore.openOrCreate(dir);
    await store.saveSource(sampleSource());
    const { readFileSync } = await import("node:fs");
    const audit = readFileSync(join(dir, "audit.jsonl"), "utf8");
    expect(audit).toContain("library-opened");
    expect(audit).toContain("source-saved");
    expect(audit).toContain("s-1");
  });
});
