/**
 * 金样本测试(P0-1 验证基线,PRD 决策 0 / GRILL R1.1):
 * recordingAdapters 包 fake 跑完整 runResearch,把 [{kind,key}] 适配器调用序列与
 * saveRun {stage,status} 序列固化为 testdata/golden/*.json;replayAdapters 回放同一
 * 金样本再跑一遍,断言两侧 run.status / bundle 关键字段逐位一致。
 * 重构前后此测试 diff 为空 = "行为不变"的可证伪证据。
 * 重新生成:UPDATE_GOLDEN=1 npx vitest run src/core/golden.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { recordingAdapters } from "../adapters/recording.js";
import { scriptedRunAgent } from "../adapters/testing.js";
import { replayAdapters } from "../adapters/replay.js";
import type { Adapters, ExtractedClaim, FetchedPage, RecordedCall, SearchHit } from "../adapters/types.js";
import {
  ResearchRequestSchema,
  type Intervention,
  type ResearchRequest,
  type ResearchResultBundle,
  type ResearchRun,
} from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import { runResearch, type RunOptions, type RunResult } from "./runResearch.js";

const GOLDEN_DIR = fileURLToPath(new URL("../../testdata/golden/", import.meta.url));

interface GoldenFile {
  calls: RecordedCall[];
  saveRuns: Array<{ stage: string; status: string }>;
}

interface RunCapture {
  result: RunResult;
  saveRuns: Array<{ stage: string; status: string }>;
}

const collectRun = async (
  request: ResearchRequest,
  adapters: Adapters,
  options: RunOptions,
): Promise<RunCapture> => {
  const store = createMemoryStore();
  const saveRuns: Array<{ stage: string; status: string }> = [];
  const orig = store.saveRun;
  store.saveRun = async (r: ResearchRun) => {
    saveRuns.push({ stage: r.stage, status: r.status });
    return orig(r);
  };
  const result = await runResearch(request, adapters, store, options);
  return { result, saveRuns };
};

const recordGolden = async (
  request: ResearchRequest,
  fakes: Adapters,
  options: RunOptions,
): Promise<{ capture: RunCapture; calls: RecordedCall[] }> => {
  const calls: RecordedCall[] = [];
  const capture = await collectRun(request, recordingAdapters(fakes, (c) => calls.push(c)), options);
  return { capture, calls };
};

const checkGolden = (name: string, recorded: { capture: RunCapture; calls: RecordedCall[] }): GoldenFile => {
  const path = join(GOLDEN_DIR, `${name}.json`);
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    const file: GoldenFile = { calls: recorded.calls, saveRuns: recorded.capture.saveRuns };
    writeFileSync(path, JSON.stringify(file, null, 2));
  }
  if (!existsSync(path)) throw new Error(`金样本缺失: ${path}(先 UPDATE_GOLDEN=1 生成)`);
  const golden = JSON.parse(readFileSync(path, "utf8")) as GoldenFile;
  expect(recorded.calls.map((c) => ({ kind: c.kind, key: c.key }))).toEqual(
    golden.calls.map((c) => ({ kind: c.kind, key: c.key })),
  );
  expect(recorded.capture.saveRuns).toEqual(golden.saveRuns);
  return golden;
};

const expectSameOutcome = (a: RunCapture, b: { result: RunResult; saveRuns: Array<{ stage: string; status: string }> }): void => {
  expect(b.result.run.status).toBe(a.result.run.status);
  const ba = a.result.bundle as ResearchResultBundle;
  const bb = b.result.bundle as ResearchResultBundle;
  expect(bb.claims.map((c) => c.id)).toEqual(ba.claims.map((c) => c.id));
  expect(bb.claims.map((c) => `${c.kind}:${c.confidence ?? ""}`)).toEqual(
    ba.claims.map((c) => `${c.kind}:${c.confidence ?? ""}`),
  );
  expect(bb.verdicts).toEqual(ba.verdicts);
  expect(bb.limitations).toEqual(ba.limitations);
  expect(bb.unresolved).toEqual(ba.unresolved);
  expect(bb.reportMd).toBe(ba.reportMd);
  expect(b.saveRuns).toEqual(a.saveRuns);
};

// --- 共享 fake 素材:gov.cn(A 级)+ iresearch(B 级),引句逐字命中正文 ---
const BODIES: Record<string, string> = {
  "https://gov.cn/a": "中国咖啡市场规模约 1,200 亿元(2025 年)。现磨咖啡门店数持续增长。行业边界与定义清晰。",
  "https://iresearch.com.cn/r": "中国咖啡市场规模约 1,200 亿元(2025 年)。产业链上下游链条完整。竞争格局分散。",
  "https://iresearch.com.cn/b": "现磨咖啡门店数约 40 万家(2025 年)。",
};

const MARKET_CLAIM: ExtractedClaim = {
  statement: "中国咖啡市场规模约 1,200 亿元(2025 年)",
  kind: "fact",
  quote: "中国咖啡市场规模约 1,200 亿元(2025 年)",
  calibration: { entity: "中国咖啡市场", period: "2025", unit: "亿元", value: 1200 },
};

const CLAIMS_BY_URL: Record<string, ExtractedClaim[]> = {
  "https://gov.cn/a": [
    MARKET_CLAIM,
    { statement: "现磨咖啡门店数持续增长", kind: "fact", quote: "现磨咖啡门店数持续增长" },
    { statement: "行业边界与定义清晰", kind: "fact", quote: "行业边界与定义清晰" },
  ],
  "https://iresearch.com.cn/r": [
    MARKET_CLAIM,
    { statement: "产业链上下游链条完整", kind: "fact", quote: "产业链上下游链条完整" },
    { statement: "竞争格局分散", kind: "fact", quote: "竞争格局分散" },
  ],
  "https://iresearch.com.cn/b": [
    {
      statement: "现磨咖啡门店数约 40 万家(2025 年)",
      kind: "fact",
      quote: "现磨咖啡门店数约 40 万家(2025 年)",
      calibration: { entity: "现磨咖啡门店", period: "2025", unit: "万家", value: 40 },
    },
  ],
  "user-text://ins-a": [{ statement: "门店结构持续优化", kind: "fact", quote: "门店结构持续优化" }],
};

const REPORT_MD =
  "# 报告\n\n## 市场口径表\n\n口径内容\n\n## 行业结构\n\n结构内容\n\n## 趋势与风险\n\n趋势内容";

function makeFakes(script: {
  search: (query: string, key: string) => SearchHit[];
  stage: (stage: string, key: string) => unknown;
}): Adapters {
  return {
    search: { search: async (query, key) => script.search(query, key) },
    page: {
      fetch: async (url): Promise<FetchedPage> => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }),
    },
    parser: {
      parse: async (page) => ({ bodyText: BODIES[page.url] ?? "", parseStatus: "ok" as const }),
    },
    model: {
      extractClaims: async ({ snapshot }) => ({ claims: CLAIMS_BY_URL[snapshot.url] ?? [], usage: { modelCalls: 1, outputTokens: 16 } }),
      runStage: async (stage, _input, key) => ({ output: script.stage(stage, key), usage: { modelCalls: 1, outputTokens: 16 } }),
      runAgent: scriptedRunAgent(),
    },
  };
}

describe("金样本 G1:干净全流程(plan→gather→analyze→draft→polish→review→publish)", () => {
  const request = ResearchRequestSchema.parse({
    id: "req-golden-1",
    module: "industry",
    goal: "中国咖啡行业规模与结构",
    scope: { summary: "中国大陆 2025", queries: ["咖啡 市场规模"] },
  });
  const options: RunOptions = { runId: "run-golden-1" };
  const fakes = () =>
    makeFakes({
      search: () => [
        { url: "https://gov.cn/a", title: "官方统计", snippet: "" },
        { url: "https://iresearch.com.cn/r", title: "行业报告", snippet: "" },
      ],
      stage: (stage) => {
        if (stage === "plan") return { questions: [{ id: "q1", question: "咖啡市场规模与口径", status: "open" }] };
        if (stage === "analyze") return { findings: [{ questionId: "q1", summary: "规模明确", claimIds: [] }], gaps: [] };
        if (stage === "draft") return { reportMd: REPORT_MD };
        if (stage === "polish") return { reportMd: `${REPORT_MD}\n\n(润色)` };
        if (stage === "review") return { issues: [], counterexampleChecked: true };
        throw new Error(`未预期 stage: ${stage}`);
      },
    });

  it("callKey 序列与 saveRun 序列匹配金样本;record/replay 产物一致", async () => {
    const recorded = await recordGolden(request, fakes(), options);
    const golden = checkGolden("g1-clean-pipeline", recorded);
    // 已知良好来源(人工推导,非由代码重算):persistRun 时机序列
    expect(recorded.capture.saveRuns).toEqual([
      { stage: "gather", status: "running" },
      { stage: "gather", status: "running" },
      { stage: "analyze", status: "running" },
      { stage: "draft", status: "running" },
      { stage: "draft", status: "running" }, // polish 段刻意 persistRun("draft")
      { stage: "review", status: "running" },
      { stage: "publish", status: "published" },
    ]);
    expect(recorded.capture.result.run.progress).toMatchObject({ answered: 1, open: 0, skipped: 0, total: 1 });
    const replayed = await collectRun(request, replayAdapters(golden.calls), options);
    expectSameOutcome(recorded.capture, replayed);
  });
});

describe("金样本 G2:修复回环(analyze gap 补采 + review regather + rephrase)", () => {
  const request = ResearchRequestSchema.parse({
    id: "req-golden-2",
    module: "industry",
    goal: "G2 修复回环",
    scope: { summary: "中国大陆 2025", queries: ["咖啡市场规模"] },
  });
  const options: RunOptions = {
    runId: "run-golden-2",
    plan: {
      questions: [
        { id: "q1", question: "咖啡市场规模", status: "open" },
        { id: "q2", question: "门店数量", status: "open" },
      ],
    },
  };
  const fakes = () =>
    makeFakes({
      search: (_query, key) => {
        if (key.includes(":r0:a:q2:search:")) return []; // 首轮 q2 无结果 → unanswered
        if (key.includes(":r1:a:q2:search:")) return [{ url: "https://iresearch.com.cn/b", title: "门店数据", snippet: "" }];
        return [{ url: "https://gov.cn/a", title: "官方统计", snippet: "" }];
      },
      stage: (stage, key) => {
        if (stage === "analyze")
          return {
            findings: [{ questionId: "q1", summary: "规模明确", claimIds: [] }],
            gaps: [{ questionId: "q2", reason: "首轮未回答" }],
          };
        if (stage === "draft") return { reportMd: key.includes(":fix") ? `${REPORT_MD}\n\n(重写)` : REPORT_MD };
        if (stage === "polish") return { reportMd: `${REPORT_MD}\n\n(润色)` };
        if (stage === "review") {
          if (key.endsWith(":review:0"))
            return {
              issues: [
                { severity: "high", kind: "gap", detail: "q1 需补采", targetQuestionId: "q1", fix: "regather" },
                { severity: "high", kind: "citation", detail: "摘要段重写", fix: "rephrase" },
              ],
              counterexampleChecked: false,
            };
          return { issues: [], counterexampleChecked: true };
        }
        throw new Error(`未预期 stage: ${stage}`);
      },
    });

  it("callKey 序列含 gather:r1 / gather:r10 / draft:fix0;record/replay 产物一致", async () => {
    const recorded = await recordGolden(request, fakes(), options);
    const golden = checkGolden("g2-repair-loop", recorded);
    const keys = recorded.calls.map((c) => c.key);
    expect(keys).toContain("req-golden-2:gather:r1:a:q2:search:1");
    expect(keys).toContain("req-golden-2:gather:r10:a:q1:search:1");
    expect(keys).toContain("req-golden-2:draft:fix0");
    expect(keys).toContain("req-golden-2:review:0");
    expect(keys).toContain("req-golden-2:review:1");
    const replayed = await collectRun(request, replayAdapters(golden.calls), options);
    expectSameOutcome(recorded.capture, replayed);
  });
});

describe("金样本 G3:执行中干预(add-source 文本 + add-questions)", () => {
  const request = ResearchRequestSchema.parse({
    id: "req-golden-3",
    module: "industry",
    goal: "G3 干预",
    scope: { summary: "中国大陆 2025", queries: ["咖啡市场规模"] },
  });
  const makeOptions = (): RunOptions => {
    const batches: Intervention[][] = [
      [
        { id: "ins-a", submittedAt: "2026-10-14T00:00:00.000Z", instruction: { type: "add-source", text: "补充材料:门店结构持续优化" } },
        { id: "ins-b", submittedAt: "2026-10-14T00:00:00.000Z", instruction: { type: "add-questions", questions: ["门店结构"] } },
      ],
    ];
    return {
      runId: "run-golden-3",
      plan: { questions: [{ id: "q1", question: "咖啡市场规模", status: "open" }] },
      pollInstructions: () => batches.shift() ?? [],
    };
  };
  const fakes = () =>
    makeFakes({
      search: (_query, key) =>
        key.includes(":a:q-ins-1:search:")
          ? [{ url: "https://iresearch.com.cn/r", title: "行业报告", snippet: "" }]
          : [{ url: "https://gov.cn/a", title: "官方统计", snippet: "" }],
      stage: (stage) => {
        if (stage === "analyze") return { findings: [], gaps: [] };
        if (stage === "draft") return { reportMd: REPORT_MD };
        if (stage === "polish") return { reportMd: `${REPORT_MD}\n\n(润色)` };
        if (stage === "review") return { issues: [], counterexampleChecked: true };
        throw new Error(`未预期 stage: ${stage}`);
      },
    });

  it("callKey 序列含 instruct:model 与 q-ins-1 采证;record/replay 产物一致", async () => {
    const recorded = await recordGolden(request, fakes(), makeOptions());
    const golden = checkGolden("g3-intervention", recorded);
    const keys = recorded.calls.map((c) => c.key);
    expect(keys).toContain("req-golden-3:instruct:model:ins-a");
    expect(keys).toContain("req-golden-3:gather:r0:a:q-ins-1:search:1");
    expect(recorded.capture.result.run.progress).toMatchObject({ answered: 2, open: 0, skipped: 0, total: 2 });
    const replayed = await collectRun(request, replayAdapters(golden.calls), makeOptions());
    expectSameOutcome(recorded.capture, replayed);
  });
});
