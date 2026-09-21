import { describe, expect, it } from "vitest";
import type { Claim } from "../contracts.js";
import { checkCalibration } from "./calibrationChecker.js";

const claim = (
  id: string,
  calibration?: { entity: string; period: string; unit: string; value?: number },
): Claim => ({
  id,
  statement: `陈述 ${id}`,
  kind: "fact",
  evidenceIds: [`ev-${id}`],
  calibration,
});

describe("checkCalibration", () => {
  it("同口径同数值 → 无冲突", () => {
    const conflicts = checkCalibration([
      claim("c1", { entity: "中国咖啡市场", period: "2025", unit: "亿元", value: 1200 }),
      claim("c2", { entity: "中国咖啡市场", period: "2025", unit: "亿元", value: 1200 }),
    ]);
    expect(conflicts).toEqual([]);
  });

  it("同对象同期间不同单位 → unit-mix(口径混用)", () => {
    const conflicts = checkCalibration([
      claim("c1", { entity: "中国咖啡市场", period: "2025", unit: "亿元", value: 1200 }),
      claim("c3", { entity: "中国咖啡市场", period: "2025", unit: "百万美元", value: 170 }),
    ]);
    expect(conflicts).toEqual([
      {
        entity: "中国咖啡市场",
        period: "2025",
        kind: "unit-mix",
        claimIds: ["c1", "c3"],
        units: ["亿元", "百万美元"],
      },
    ]);
  });

  it("同口径不同数值 → value-conflict(须披露解释)", () => {
    const conflicts = checkCalibration([
      claim("c1", { entity: "中国咖啡市场", period: "2025", unit: "亿元", value: 1200 }),
      claim("c4", { entity: "中国咖啡市场", period: "2025", unit: "亿元", value: 1500 }),
    ]);
    expect(conflicts).toEqual([
      {
        entity: "中国咖啡市场",
        period: "2025",
        kind: "value-conflict",
        claimIds: ["c1", "c4"],
        values: [
          { claimId: "c1", value: 1200, unit: "亿元" },
          { claimId: "c4", value: 1500, unit: "亿元" },
        ],
      },
    ]);
  });

  it("不同对象互不干扰;缺数值的主张只做单位检查", () => {
    const conflicts = checkCalibration([
      claim("c1", { entity: "中国咖啡市场", period: "2025", unit: "亿元", value: 1200 }),
      claim("c5", { entity: "中国现磨咖啡门店数", period: "2025", unit: "万家", value: 12 }),
    ]);
    expect(conflicts).toEqual([]);
  });
});
