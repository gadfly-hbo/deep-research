/**
 * publishGate 纯函数单测(P0-1 T5,GRILL R1.3):
 * 断言完整输出快照,limitationsToAppend 用有序 toEqual(禁 includes 弱断言)。
 * 输出 claims 与输入共享对象(门禁就地突变),各用例独立构造输入,不复用。
 */
import { describe, expect, it } from "vitest";
import type { Claim, Evidence, SourceSnapshot } from "../contracts.js";
import type { ModuleConfig } from "../modules/types.js";
import { industryConfig } from "../modules/industry.js";
import { evaluatePublishGate, type PublishGateInput } from "./publishGate.js";

const CFG: ModuleConfig = {
  schemaVersion: "1.0",
  module: "industry",
  questionFramework: [],
  sourceStrategy: { validationRules: [] },
  reportTemplate: { title: "测试模板", sections: [] },
};

const snap = (id: string, url: string, bodyText: string, tier?: "A" | "B" | "C"): SourceSnapshot => ({
  id,
  url,
  title: id,
  fetchedAt: "2026-10-14T00:00:00.000Z",
  bodyText,
  parseStatus: "ok",
  contentType: "text/html",
  ...(tier ? { tier } : {}),
});

const ev = (id: string, snapshotId: string, quote: string): Evidence => ({ id, snapshotId, quote });

const cl = (
  id: string,
  statement: string,
  evidenceIds: string[],
  calibration?: Claim["calibration"],
): Claim => ({ id, statement, kind: "fact", evidenceIds, ...(calibration ? { calibration } : {}) });

const MARKET = {
  statement: "中国咖啡市场规模约 1,200 亿元(2025 年)",
  quote: "中国咖啡市场规模约 1,200 亿元(2025 年)",
  calibration: { entity: "中国咖啡市场", period: "2025", unit: "亿元", value: 1200 },
};

function input(overrides: Partial<PublishGateInput>): PublishGateInput {
  return {
    claims: [],
    evidence: [],
    snapshots: [],
    questions: [],
    claimQuestions: {},
    draftMd: "# 草稿",
    capped: false,
    counterexampleChecked: true,
    limitations: [],
    goal: "测试目标",
    moduleConfig: CFG,
    ...overrides,
  };
}

describe("evaluatePublishGate", () => {
  it("干净通过:跨源合并同事实,多源 + A/B 级信源 → published + high 置信度", () => {
    const out = evaluatePublishGate(
      input({
        snapshots: [
          snap("s1", "https://gov.cn/a", `正文。${MARKET.quote}。`, "A"),
          snap("s2", "https://iresearch.com.cn/r", `另一来源。${MARKET.quote}。`, "B"),
        ],
        evidence: [ev("e1", "s1", MARKET.quote), ev("e2", "s2", MARKET.quote)],
        claims: [
          cl("c1", MARKET.statement, ["e1"], MARKET.calibration),
          cl("c2", MARKET.statement, ["e2"], MARKET.calibration),
        ],
        questions: [{ id: "q1", question: "规模", status: "answered" }],
      }),
    );
    expect(out.status).toBe("published");
    expect(out.reasons).toEqual([]);
    expect(out.limitationsToAppend).toEqual([]);
    expect(out.unresolved).toEqual([]);
    // 跨源合并:c1/c2 并为一主张,证据并集保序
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0].id).toBe("c1");
    expect(out.claims[0].evidenceIds).toEqual(["e1", "e2"]);
    expect(out.claims[0].kind).toBe("fact");
    expect(out.claims[0].confidence).toBe("high");
    expect(out.verdicts.map((v) => `${v.verdict}:${v.entailment}:${v.numeric}:${v.tier}`)).toEqual([
      "quote-hit:strong:ok:A",
      "quote-hit:strong:ok:B",
    ]);
    expect(out.reportMd).toContain("## 主张状态与引用判定");
    expect(out.reportMd).not.toContain("## 限制");
  });

  it("引句未命中:硬降级 unverified + 披露行 + 命中率原因,limitationsToAppend 有序", () => {
    const out = evaluatePublishGate(
      input({
        snapshots: [snap("s1", "https://gov.cn/a", "正文没有这句话。", "A")],
        evidence: [ev("e1", "s1", "不存在的引句")],
        claims: [cl("c1", "某事实主张", ["e1"])],
      }),
    );
    expect(out.status).toBe("limited");
    expect(out.claims[0].kind).toBe("unverified");
    expect(out.claims[0].confidence).toBe("low");
    expect(out.limitationsToAppend).toEqual([
      "以下主张引用核查未通过,已降级为未验证:c1",
      "存在引用/蕴涵/数值核查未通过的关键结论",
      "关键主张引句命中率 0% 低于 80%",
    ]);
    expect(out.reportMd).toContain("## 限制");
  });

  it("蕴涵失败与数值复算不一致:独立披露、独立降级", () => {
    const out = evaluatePublishGate(
      input({
        snapshots: [
          snap("s1", "https://gov.cn/a", "门店数持续增长。", "A"),
          snap("s2", "https://gov.cn/b", "中国咖啡市场规模约 800 亿元。", "A"),
        ],
        evidence: [ev("e1", "s1", "门店数持续增长"), ev("e2", "s2", "中国咖啡市场规模约 800 亿元")],
        claims: [
          // 主张数字 50% 不在引句中 → 蕴涵 fail
          cl("c1", "门店数增长 50%", ["e1"]),
          // 主张无数字(蕴涵按文本判),口径值 1200 亿 vs 引句 800 亿 → 数值 mismatch
          cl("c2", "中国咖啡市场规模达千亿元级", ["e2"], { entity: "中国咖啡市场", period: "2025", unit: "亿元", value: 1200 }),
        ],
      }),
    );
    expect(out.limitationsToAppend).toEqual([
      "以下主张的引句不支持其转述(语义蕴涵未通过),已降级为未验证:c1",
      "以下主张数值与引句不一致(数值复算未通过),已降级为未验证:c2",
      "存在引用/蕴涵/数值核查未通过的关键结论",
    ]);
    expect(out.claims.map((c) => c.kind)).toEqual(["unverified", "unverified"]);
    expect(out.status).toBe("limited");
  });

  it("单源带口径数值主张:降级为推断并披露;叙述性事实单源仅降置信度", () => {
    const out = evaluatePublishGate(
      input({
        snapshots: [snap("s1", "https://gov.cn/a", `${MARKET.quote}。现磨咖啡门店数持续增长。`, "A")],
        evidence: [ev("e1", "s1", MARKET.quote), ev("e2", "s1", "现磨咖啡门店数持续增长")],
        claims: [
          cl("c1", MARKET.statement, ["e1"], MARKET.calibration),
          cl("c2", "现磨咖啡门店数持续增长", ["e2"]),
        ],
      }),
    );
    expect(out.limitationsToAppend).toEqual(["以下主张仅单一来源支撑,已降级为推断(需交叉验证):c1"]);
    expect(out.claims[0].kind).toBe("inference");
    expect(out.claims[0].confidence).toBe("medium");
    expect(out.claims[1].kind).toBe("fact");
    expect(out.claims[1].confidence).toBe("medium"); // 叙述性单源不降类型,置信度 medium
    expect(out.status).toBe("published"); // 单源降级不进 reasons
  });

  it("仅 C 级信源支撑:不降级但置信度 low 并披露", () => {
    const out = evaluatePublishGate(
      input({
        snapshots: [snap("s1", "https://zhihu.com/p/1", "现磨咖啡门店数持续增长。", "C")],
        evidence: [ev("e1", "s1", "现磨咖啡门店数持续增长")],
        claims: [cl("c1", "现磨咖啡门店数持续增长", ["e1"])],
      }),
    );
    expect(out.claims[0].kind).toBe("fact");
    expect(out.claims[0].confidence).toBe("low");
    expect(out.limitationsToAppend).toEqual([
      "以下主张仅有 C 级信源(社媒/自媒体/未知来源)支撑,置信度低:c1",
    ]);
    expect(out.status).toBe("published");
  });

  it("capped 与反例未完成:reason 规则;capped 时反例原因被抑制", () => {
    const capped = evaluatePublishGate(input({ capped: true, counterexampleChecked: false }));
    expect(capped.status).toBe("limited");
    expect(capped.reasons).toEqual(["预算上限到达,部分采证未完成"]);
    const unchecked = evaluatePublishGate(input({ counterexampleChecked: false }));
    expect(unchecked.reasons).toEqual(["反例检查未完成"]);
    expect(unchecked.status).toBe("limited");
  });

  it("模块专项核查进门内:缺必备章节/主题未覆盖 → reason 带明细", () => {
    const out = evaluatePublishGate(
      input({ moduleConfig: industryConfig, draftMd: "# 草稿\n\n什么都没有" }),
    );
    expect(out.status).toBe("limited");
    expect(out.reasons).toHaveLength(1);
    expect(out.reasons[0]).toContain("模块质量检查未通过");
    expect(out.reasons[0]).toContain("缺必备章节「市场口径表」");
    expect(out.reasons[0]).toContain("主题未覆盖「行业边界」");
    expect(out.limitationsToAppend).toEqual(out.reasons);
  });

  it("增量注记与基准复用标记:reportMd 头部注记 + 主张行 |基准复用", () => {
    const out = evaluatePublishGate(
      input({
        snapshots: [snap("s1", "https://gov.cn/a", "现磨咖啡门店数持续增长。", "A")],
        evidence: [ev("e1", "s1", "现磨咖啡门店数持续增长")],
        claims: [cl("c1", "现磨咖啡门店数持续增长", ["e1"])],
        claimQuestions: { c1: "base" },
        questions: [{ id: "q1", question: "规模", status: "answered" }],
        incremental: { baseRunId: "run-base", reusedSnapshots: 3, reusedEvidence: 5, reusedClaims: 4, newQuestions: 2 },
      }),
    );
    expect(out.reportMd).toContain("> 增量研究:基于 run-base 追问扩展;复用快照 3 / 证据 5 / 主张 4,本次新问 2");
    expect(out.reportMd).toContain("[fact|基准复用");
  });

  it("unresolved 归纳:非 answered 问题带状态标签,answered 不入列", () => {
    const out = evaluatePublishGate(
      input({
        questions: [
          { id: "q1", question: "规模", status: "answered" },
          { id: "q2", question: "门店", status: "partially" },
          { id: "q3", question: "格局", status: "unanswered" },
          { id: "q4", question: "风险", status: "skipped" },
        ],
      }),
    );
    expect(out.unresolved).toEqual(["门店(部分回答)", "格局(未回答)", "风险(已跳过)"]);
    expect(out.reportMd).toContain("## 未解决问题");
  });

  it("既有 limitations 并入限制段且 reasons 对其去重", () => {
    const out = evaluatePublishGate(
      input({
        capped: true,
        limitations: ["既有披露", "预算上限到达,部分采证未完成"],
      }),
    );
    // reasons 与既有重复 → 不再追加
    expect(out.limitationsToAppend).toEqual([]);
    expect(out.reportMd).toContain("- 既有披露\n- 预算上限到达,部分采证未完成");
  });
});
