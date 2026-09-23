import { describe, expect, it } from "vitest";
import {
  AcquisitionRecordSchema,
  AssetBindingSchema,
  EntitySchema,
  ReviewRecordSchema,
  RightsSchema,
  SourceSchema,
  SourceVersionSchema,
  UsageRecordSchema,
} from "./contracts.js";

describe("Source 契约", () => {
  const baseSource = {
    sourceId: "s-abc123",
    title: "某机构 2025 年消费者画像报告",
    docType: "consumer-profile",
    createdAt: "2026-09-23T00:00:00.000Z",
  };

  it("接受最小合法来源并给默认生命周期 ACTIVE", () => {
    const s = SourceSchema.parse(baseSource);
    expect(s.lifecycle).toBe("ACTIVE");
    expect(s.entityIds).toEqual([]);
    expect(s.tags).toEqual([]);
  });

  it("拒绝未约定的资料类型与生命周期取值", () => {
    expect(() => SourceSchema.parse({ ...baseSource, docType: "secret" })).toThrow();
    expect(() => SourceSchema.parse({ ...baseSource, lifecycle: "DELETED" })).toThrow();
  });

  it("转引来源记录上游引用候选且未取得原文", () => {
    const s = SourceSchema.parse({
      ...baseSource,
      origin: { directPublisher: "媒体X", upstreamSourceId: "s-up1", obtainedUpstream: false },
    });
    expect(s.origin?.obtainedUpstream).toBe(false);
  });

  it("自有报告派生成果带工作台来源标记", () => {
    const s = SourceSchema.parse({ ...baseSource, docType: "research-report", derivedFromRunId: "run-1" });
    expect(s.derivedFromRunId).toBe("run-1");
  });
});

describe("SourceVersion 契约", () => {
  const baseVersion = {
    versionId: "sv-abc123",
    sourceId: "s-abc123",
    fetchStatus: "READ_FULL",
    createdAt: "2026-09-23T00:00:00.000Z",
  };

  it("接受内容哈希与更正关系", () => {
    const v = SourceVersionSchema.parse({
      ...baseVersion,
      contentHash: "a".repeat(64),
      contentRef: "files/" + "a".repeat(64),
      supersedesVersionId: "sv-old",
    });
    expect(v.supersedesVersionId).toBe("sv-old");
  });

  it("只读链接登记为 DISCOVERED,不冒充已读全文", () => {
    const v = SourceVersionSchema.parse({ ...baseVersion, fetchStatus: "DISCOVERED" });
    expect(v.fetchStatus).toBe("DISCOVERED");
    expect(() => SourceVersionSchema.parse({ ...baseVersion, fetchStatus: "ALL_GOOD" })).toThrow();
  });

  it("区分发布时间/可用时间/数据期间三类时间", () => {
    const v = SourceVersionSchema.parse({
      ...baseVersion,
      publishedAt: "2025-06-01T00:00:00.000Z",
      availableAt: "2025-06-02T00:00:00.000Z",
      dataPeriod: "2025Q1",
    });
    expect(v.dataPeriod).toBe("2025Q1");
    expect(v.publishedAt).not.toBe(v.availableAt);
  });
});

describe("AcquisitionRecord 契约", () => {
  const baseAcq = {
    acquisitionId: "aq-1",
    versionId: "sv-abc123",
    acquiredAt: "2026-09-23T01:00:00.000Z",
    recordedAt: "2026-09-23T01:00:01.000Z",
    method: "user-file",
    readScope: "READ_FULL",
  };

  it("默认复用范围 PROJECT_ONLY,未知权利缺省(默认拒绝语义由服务层执行)", () => {
    const a = AcquisitionRecordSchema.parse(baseAcq);
    expect(a.reuseScope).toBe("PROJECT_ONLY");
    expect(a.rights).toEqual({});
  });

  it("权利逐项显式授予,可区分外发模型与导出全文", () => {
    const a = AcquisitionRecordSchema.parse({
      ...baseAcq,
      rights: { sendToExternalModel: true, exportFulltext: false },
    });
    expect(a.rights.sendToExternalModel).toBe(true);
    expect(a.rights.exportFulltext).toBe(false);
    expect(a.rights.exportExcerpt).toBeUndefined();
  });

  it("幂等键与项目/运行上下文可记录", () => {
    const a = AcquisitionRecordSchema.parse({
      ...baseAcq,
      projectId: "p-1",
      runId: "run-1",
      idempotencyKey: "import-20260923-01",
    });
    expect(a.idempotencyKey).toBe("import-20260923-01");
  });

  it("RightsSchema 拒绝非布尔取值", () => {
    expect(() => RightsSchema.parse({ sendToExternalModel: "yes" })).toThrow();
  });
});

describe("Entity 契约", () => {
  it("轻量实体默认候选确认状态,不按名称自动合并", () => {
    const e = EntitySchema.parse({ entityId: "en-1", type: "brand", name: "森马" });
    expect(e.confirmStatus).toBe("CANDIDATE");
    expect(e.aliases).toEqual([]);
  });

  it("合并需依据字段", () => {
    const e = EntitySchema.parse({
      entityId: "en-1",
      type: "brand",
      name: "森马服饰",
      aliases: ["森马"],
      confirmStatus: "CONFIRMED",
      basis: "财报披露主体全名",
    });
    expect(e.basis).toContain("财报");
  });
});

describe("AssetBinding 契约", () => {
  const baseBinding = {
    bindingId: "b-1",
    runId: "run-1",
    projectId: "p-1",
    sourceId: "s-abc123",
    versionId: "sv-abc123",
    purpose: "品牌案例输入",
    applicability: "ELIGIBLE",
    boundAt: "2026-09-23T02:00:00.000Z",
  };

  it("固定到精确版本与证据修订,不接受最新别名", () => {
    const b = AssetBindingSchema.parse({
      ...baseBinding,
      evidenceRevisions: { "ev-1": 2 },
      asOf: "2026-09-23T00:00:00.000Z",
    });
    expect(b.versionId).toBe("sv-abc123");
    expect(b.evidenceRevisions["ev-1"]).toBe(2);
  });

  it("适用性只取约定五态", () => {
    expect(() => AssetBindingSchema.parse({ ...baseBinding, applicability: "OK" })).toThrow();
    const b = AssetBindingSchema.parse({ ...baseBinding, applicability: "LEAD_ONLY" });
    expect(b.applicability).toBe("LEAD_ONLY");
  });
});

describe("UsageRecord / ReviewRecord 契约", () => {
  it("UsageRecord 记录实际使用步骤与内容版本", () => {
    const u = UsageRecordSchema.parse({
      usageId: "u-1",
      runId: "run-1",
      bindingId: "b-1",
      step: "analyze",
      contentVersionId: "sv-abc123",
      usedAt: "2026-09-23T02:30:00.000Z",
    });
    expect(u.step).toBe("analyze");
  });

  it("ReviewRecord 记录核验对象、范围、类型与责任主体", () => {
    const r = ReviewRecordSchema.parse({
      reviewId: "rr-1",
      objectRef: "ev-1",
      scope: "run-1",
      checkType: "extraction",
      result: "pass",
      reviewedAt: "2026-09-23T03:00:00.000Z",
      reviewer: "system:citationVerifier",
    });
    expect(r.checkType).toBe("extraction");
    expect(() =>
      ReviewRecordSchema.parse({
        reviewId: "rr-2",
        objectRef: "ev-1",
        scope: "run-1",
        checkType: "extraction",
        result: "pass",
        reviewedAt: "2026-09-23T03:00:00.000Z",
        reviewer: "",
      }),
    ).toThrow();
  });
});
