import { describe, expect, it } from "vitest";
import type { Claim } from "../contracts.js";
import type { PlanQuestion } from "../core/stages.js";
import type { ModuleConfig } from "../modules/types.js";
import { checkModuleOutput } from "./moduleCheck.js";

const cfg: ModuleConfig = {
  schemaVersion: "1.0",
  module: "brand",
  questionFramework: [{ id: "t1", title: "品牌定位", keywords: ["定位"] }],
  sourceStrategy: { validationRules: ["numeric-claims-calibrated", "fact-claims-evidenced"] },
  reportTemplate: {
    title: "品牌研究报告",
    sections: [{ id: "s1", title: "品牌档案", required: true }],
  },
};

const claim = (over: Partial<Claim>): Claim => ({
  id: "c1",
  statement: "品牌定位高端",
  kind: "fact",
  evidenceIds: ["e1"],
  ...over,
});

const answered: PlanQuestion[] = [{ id: "q1", question: "品牌定位是什么", status: "answered" }];

const input = (over: {
  reportMd?: string;
  claims?: Claim[];
  questions?: PlanQuestion[];
}) => ({
  reportMd: over.reportMd ?? "## 品牌档案\n\n品牌定位高端。",
  claims: over.claims ?? [claim({})],
  questions: over.questions ?? answered,
});

describe("checkModuleOutput", () => {
  it("必备章节齐全、主题覆盖、规则通过 → passed", () => {
    const result = checkModuleOutput(cfg, input({}));
    expect(result).toEqual({ passed: true, missingSections: [], uncoveredTopics: [], violations: [] });
  });

  it("缺必备章节 → missingSections 且不通过", () => {
    const result = checkModuleOutput(cfg, input({ reportMd: "## 其他\n\nx" }));
    expect(result.passed).toBe(false);
    expect(result.missingSections).toEqual(["品牌档案"]);
  });

  it("数值主张缺口径 → 规则违规", () => {
    const result = checkModuleOutput(
      cfg,
      input({ claims: [claim({ statement: "客单价 299 元", calibration: undefined })] }),
    );
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.startsWith("numeric-claims-calibrated"))).toBe(true);
  });

  it("主题无主张且问题未回答 → uncoveredTopics", () => {
    const result = checkModuleOutput(
      cfg,
      input({
        claims: [claim({ statement: "渠道分布广泛" })],
        questions: [{ id: "q1", question: "渠道?", status: "unanswered" }],
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.uncoveredTopics).toEqual(["品牌定位"]);
  });

  it("fact 主张无证据 → 规则违规", () => {
    const result = checkModuleOutput(cfg, input({ claims: [claim({ evidenceIds: [] })] }));
    expect(result.passed).toBe(false);
    expect(result.violations.some((v) => v.startsWith("fact-claims-evidenced"))).toBe(true);
  });
});
