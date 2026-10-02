import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ClaimSchema,
  EvidenceSchema,
  ResearchRequestSchema,
  ResearchResultBundleSchema,
  ResearchRunSchema,
  RunInstructionSchema,
} from "./contracts.js";
import { PlanQuestionSchema } from "./core/stages.js";

describe("ResearchRequest 契约", () => {
  it("接受最小合法请求(品牌模块 + 目标 + 范围与种子问题)", () => {
    const parsed = ResearchRequestSchema.parse({
      module: "brand",
      goal: "评估某消费电子品牌在中国市场的定位与竞品格局",
      scope: { summary: "中国大陆、2024-2026、公开来源", queries: ["品牌 市场份额 2025"] },
    });
    expect(parsed.module).toBe("brand");
    expect(parsed.scope.queries).toEqual(["品牌 市场份额 2025"]);
    expect(parsed.budget).toBeUndefined();
  });

  it("拒绝一期之外的研究模块(消费者研究属二期)", () => {
    expect(() =>
      ResearchRequestSchema.parse({
        module: "consumer",
        goal: "g",
        scope: { summary: "s", queries: [] },
      }),
    ).toThrow();
  });

  it("拒绝缺少研究目标的请求", () => {
    expect(() =>
      ResearchRequestSchema.parse({
        module: "industry",
        scope: { summary: "s", queries: ["q"] },
      }),
    ).toThrow();
  });
});

describe("ResearchRun 契约", () => {
  it("只接受约定的阶段与状态取值", () => {
    const run = ResearchRunSchema.parse({
      id: "run-1",
      requestId: "req-1",
      stage: "gather",
      status: "running",
      checkpoints: [],
      usage: { searches: 1, fetches: 2, costEstimate: 0.02, wallMs: 1500 },
    });
    expect(run.status).toBe("running");
    expect(() =>
      ResearchRunSchema.parse({ ...run, status: "succeeded" }),
    ).toThrow();
    expect(() =>
      ResearchRunSchema.parse({ ...run, stage: "retrieve" }),
    ).toThrow();
  });
});

describe("ResearchResultBundle 契约", () => {
  const baseBundle = {
    runId: "run-1",
    version: 1,
    reportMd: "# 报告",
    claims: [
      {
        id: "c1",
        statement: "中国咖啡市场规模约 1200 亿元(2025)",
        kind: "fact",
        evidenceIds: ["e1"],
        calibration: { entity: "中国咖啡市场", period: "2025", unit: "亿元人民币" },
      },
    ],
    evidence: [{ id: "e1", snapshotId: "s1", quote: "市场规模约 1,200 亿元" }],
    snapshots: [
      {
        id: "s1",
        url: "https://example.com/a",
        title: "A",
        fetchedAt: "2026-09-21T00:00:00.000Z",
        bodyText: "市场规模约 1,200 亿元",
        parseStatus: "ok",
        contentType: "text/html",
      },
    ],
    limitations: [],
    unresolved: [],
    verdicts: [{ evidenceId: "e1", verdict: "quote-hit" }],
  };

  it("接受结构完整的成果包", () => {
    const parsed = ResearchResultBundleSchema.parse(baseBundle);
    expect(parsed.claims[0].kind).toBe("fact");
  });

  it("拒绝未约定的主张类型与引用判定", () => {
    expect(() =>
      ResearchResultBundleSchema.parse({
        ...baseBundle,
        claims: [{ ...baseBundle.claims[0], kind: "guess" }],
      }),
    ).toThrow();
    expect(() =>
      ResearchResultBundleSchema.parse({
        ...baseBundle,
        verdicts: [{ evidenceId: "e1", verdict: "probably-true" }],
      }),
    ).toThrow();
  });

  it("向后兼容:2.0 扩展后真实 v1 成果包样本仍可解析", () => {
    const sample = JSON.parse(readFileSync("testdata/v1-bundle-sample.json", "utf8"));
    const parsed = ResearchResultBundleSchema.parse(sample);
    expect(parsed.claims.length).toBeGreaterThan(0);
    expect(parsed.evidence[0].snapshotId).toBeTruthy();
  });
});

describe("Evidence/Claim 2.0 扩展(全部可选,旧数据可解析)", () => {
  it("旧形状证据(仅 id/snapshotId/quote)仍解析,扩展字段缺省", () => {
    const e = EvidenceSchema.parse({ id: "e1", snapshotId: "s1", quote: "q" });
    expect(e.revision).toBeUndefined();
    expect(e.extractionCheck).toBeUndefined();
  });

  it("证据可带修订号、口径说明、提取核验与来源版本链接", () => {
    const e = EvidenceSchema.parse({
      id: "e1",
      snapshotId: "s1",
      quote: "女性比例为 62%",
      locator: "p.12 表3",
      revision: 2,
      scopeNote: "某平台关注者样本,非全部购买者",
      extractionCheck: "VERIFIED_AGAINST_SOURCE",
      versionId: "sv-abc123",
    });
    expect(e.revision).toBe(2);
    expect(e.extractionCheck).toBe("VERIFIED_AGAINST_SOURCE");
    expect(() =>
      EvidenceSchema.parse({ id: "e1", snapshotId: "s1", quote: "q", extractionCheck: "TRUST_ME" }),
    ).toThrow();
  });

  it("主张可带修订号与支持状态(四态)", () => {
    const c = ClaimSchema.parse({
      id: "c1",
      statement: "该调查关注者样本中女性占比较高",
      kind: "fact",
      evidenceIds: ["e1"],
      revision: 1,
      supportStatus: "PARTIALLY_SUPPORTED",
      scopeNote: "仅限该平台关注者样本",
    });
    expect(c.supportStatus).toBe("PARTIALLY_SUPPORTED");
    expect(() =>
      ClaimSchema.parse({ id: "c1", statement: "s", kind: "fact", evidenceIds: [], supportStatus: "TRUE" }),
    ).toThrow();
  });
});

describe("2.1 扩展:增量研究与执行中干预(全部可选,旧数据可解析)", () => {
  const baseRun = {
    id: "run-1",
    requestId: "req-1",
    stage: "gather",
    status: "running",
    checkpoints: [],
    usage: { searches: 1, fetches: 2, costEstimate: 0.02, wallMs: 1500 },
  };

  it("运行记录可带增量基准、进度摘要与干预历史", () => {
    const run = ResearchRunSchema.parse({
      ...baseRun,
      derivedFromRunId: "run-base",
      progress: { currentQuestionId: "q2", currentQuestionText: "门店数量", answered: 1, open: 2, skipped: 1, total: 4 },
      interventions: [
        {
          id: "ins-1",
          submittedAt: "2026-10-02T00:00:00.000Z",
          instruction: { type: "skip-question", questionId: "q3" },
          consumedAt: "2026-10-02T00:01:00.000Z",
          effect: "applied",
          detail: "问题 q3 已跳过",
        },
      ],
    });
    expect(run.derivedFromRunId).toBe("run-base");
    expect(run.progress?.total).toBe(4);
    expect(run.interventions).toHaveLength(1);
    expect(() =>
      ResearchRunSchema.parse({ ...baseRun, progress: { answered: -1, open: 0, skipped: 0, total: 0 } }),
    ).toThrow();
    expect(() =>
      ResearchRunSchema.parse({
        ...baseRun,
        interventions: [{ id: "ins-1", submittedAt: "t", instruction: { type: "nope" }, effect: "applied" }],
      }),
    ).toThrow();
  });

  it("请求可携带增量基准(incrementalOf),缺字段被拒", () => {
    const parsed = ResearchRequestSchema.parse({
      module: "brand",
      goal: "g",
      scope: { summary: "s", queries: [] },
      incrementalOf: { runId: "run-base", requestId: "req-base" },
    });
    expect(parsed.incrementalOf?.runId).toBe("run-base");
    expect(() =>
      ResearchRequestSchema.parse({
        module: "brand",
        goal: "g",
        scope: { summary: "s", queries: [] },
        incrementalOf: { runId: "x" },
      }),
    ).toThrow();
  });

  it("成果包可带增量来源与复用明细(v1 真实样本 + 2.1 字段仍解析)", () => {
    const sample = JSON.parse(readFileSync("testdata/v1-bundle-sample.json", "utf8"));
    const parsed = ResearchResultBundleSchema.parse({
      ...sample,
      derivedFromRunId: "run-base",
      reuseSummary: { baseRunId: "run-base", reusedSnapshots: 3, reusedEvidence: 10, reusedClaims: 8, newQuestions: 2 },
    });
    expect(parsed.reuseSummary?.reusedEvidence).toBe(10);
    expect(parsed.derivedFromRunId).toBe("run-base");
  });

  it("问题状态支持 skipped(执行中跳过)", () => {
    expect(PlanQuestionSchema.parse({ id: "q1", question: "x", status: "skipped" }).status).toBe("skipped");
  });

  it("干预指令四类:合法形状通过,越界取值被拒", () => {
    expect(RunInstructionSchema.safeParse({ type: "skip-question" }).success).toBe(true);
    expect(RunInstructionSchema.safeParse({ type: "skip-question", questionId: "q2" }).success).toBe(true);
    expect(RunInstructionSchema.safeParse({ type: "add-questions", questions: ["新问题一"] }).success).toBe(true);
    expect(
      RunInstructionSchema.safeParse({ type: "add-questions", questions: Array.from({ length: 7 }, (_, i) => `q${i}`) })
        .success,
    ).toBe(false);
    expect(RunInstructionSchema.safeParse({ type: "add-questions", questions: [] }).success).toBe(false);
    expect(RunInstructionSchema.safeParse({ type: "refine-direction", note: "重点看国内市场" }).success).toBe(true);
    expect(RunInstructionSchema.safeParse({ type: "refine-direction", note: "x".repeat(501) }).success).toBe(false);
    expect(RunInstructionSchema.safeParse({ type: "add-source", url: "https://a/1", title: "A" }).success).toBe(true);
    expect(RunInstructionSchema.safeParse({ type: "add-source", text: "补充材料" }).success).toBe(true);
    expect(RunInstructionSchema.safeParse({ type: "add-source" }).success).toBe(false);
    expect(RunInstructionSchema.safeParse({ type: "add-source", url: "not-a-url" }).success).toBe(false);
    expect(RunInstructionSchema.safeParse({ type: "pause-run" }).success).toBe(false);
  });
});
