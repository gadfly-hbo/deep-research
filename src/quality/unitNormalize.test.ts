import { describe, expect, it } from "vitest";
import { normalizeUnit } from "./calibrationChecker.js";

describe("normalizeUnit(口径单位归一)", () => {
  it("等价单位写法归一后相等", () => {
    expect(normalizeUnit("万亿元人民币")).toBe(normalizeUnit("万亿元"));
    expect(normalizeUnit("亿元人民币")).toBe(normalizeUnit("亿元"));
    expect(normalizeUnit("万家(门店)")).toBe(normalizeUnit("万家"));
  });

  it("不同单位仍不同", () => {
    expect(normalizeUnit("亿元")).not.toBe(normalizeUnit("百万美元"));
  });
});
