import { describe, expect, it } from "vitest";
import { checkEntailment } from "./entailment.js";
import { checkMultiSource, mergeCrossSourceClaims } from "./multiSource.js";
import { checkNumericConsistency, extractScaledNumbers, scaleOf } from "./numericVerifier.js";
import { tierOfSource } from "./sourceTier.js";
import type { Claim, Evidence, SourceSnapshot } from "../contracts.js";

describe("sourceTier(信源分级)", () => {
  it("政府/交易所/权威媒体=A,行业报告与门户=B,社媒与未知=C", () => {
    expect(tierOfSource("https://www.stats.gov.cn/sj/zxfb/1.html")).toBe("A");
    expect(tierOfSource("https://www.sse.com.cn/disclosure/1.html")).toBe("A");
    expect(tierOfSource("https://www.xinhuanet.com/fortune/1.htm")).toBe("A");
    expect(tierOfSource("https://www.21jingji.com/article/1.html")).toBe("B");
    expect(tierOfSource("https://www.iresearch.com.cn/report/1.shtml")).toBe("B");
    expect(tierOfSource("https://finance.sina.com.cn/stock/1.html")).toBe("B");
    expect(tierOfSource("https://zhuanlan.zhihu.com/p/123")).toBe("C");
    expect(tierOfSource("https://www.xiaohongshu.com/note/1")).toBe("C");
    expect(tierOfSource("https://unknown-blog.example.com/x")).toBe("C");
  });

  it("模块 preferredDomains 命中提为 A(品牌官网等一手来源)", () => {
    expect(tierOfSource("https://www.semir.com.cn/news/1", ["semir.com.cn"])).toBe("A");
  });
});

describe("entailment(语义蕴涵确定性检查)", () => {
  it("主张数字不在引句中 → fail", () => {
    expect(checkEntailment("森马门店数达2000家", "门店数达1488家，居行业前列")).toBe("fail");
  });
  it("引句千分位逗号不影响数字比对", () => {
    expect(checkEntailment("市场规模约1200亿元", "市场规模约 1,200 亿元")).toBe("strong");
  });
  it("年份豁免疫份(期间由口径检查负责)", () => {
    expect(checkEntailment("市场规模约1200亿元(2025)", "市场规模约 1,200 亿元")).toBe("strong");
  });
  it("引句不支持转述(重合度低)→ fail;弱支撑 → weak", () => {
    expect(checkEntailment("森马门店数位居全国行业榜首", "门店数达1488家，居行业前列")).toBe("fail");
    expect(checkEntailment("森马门店数行业第一", "门店数达1488家，居行业前列")).toBe("weak");
  });
  it("空输入 na", () => {
    expect(checkEntailment("", "x")).toBe("na");
  });
});

describe("numericVerifier(数值复算)", () => {
  const claim = (value: number, unit: string): Claim => ({
    id: "cl:1", statement: "s", kind: "fact", evidenceIds: ["ev:1"],
    calibration: { entity: "市场规模", period: "2025", unit, value },
  });
  it("口径值与引句一致(含千分位)", () => {
    expect(checkNumericConsistency(claim(1200, "亿元"), "市场规模约 1,200 亿元")).toBe("ok");
  });
  it("单位换算:1.2万亿元 = 12000亿元", () => {
    expect(checkNumericConsistency(claim(12000, "亿元"), "规模约 1.2 万亿元")).toBe("ok");
    expect(scaleOf("万亿元人民币")).toBe(1e12);
  });
  it("数值不一致 → mismatch", () => {
    expect(checkNumericConsistency(claim(999, "亿元"), "规模约 1,200 亿元")).toBe("mismatch");
  });
  it("无口径值 → na;引句无数字 → mismatch", () => {
    expect(checkNumericConsistency({ id: "c", statement: "s", kind: "fact", evidenceIds: [] }, "无数字")).toBe("na");
    expect(checkNumericConsistency(claim(1200, "亿元"), "没有任何数字")).toBe("mismatch");
  });
  it("抽取:多数字与量纲", () => {
    const nums = extractScaledNumbers("主力价位 15 至 35 美元,门店 1,488 家");
    expect(nums.map((n) => n.scaled)).toContain(15);
    expect(nums.map((n) => n.scaled)).toContain(35);
    expect(nums.map((n) => n.scaled)).toContain(1488);
  });
});

describe("multiSource(跨源合并与单源判定)", () => {
  const snap = (id: string, url: string): SourceSnapshot => ({
    id, url, title: "", fetchedAt: "t", bodyText: "", parseStatus: "ok", contentType: "text/html",
  });
  const ev = (id: string, snapshotId: string): Evidence => ({ id, snapshotId, quote: "q" });

  it("同口径同数值跨源合并,证据并集", () => {
    const a: Claim = { id: "c1", statement: "规模1200亿元", kind: "fact", evidenceIds: ["e1"], calibration: { entity: "规模", period: "2025", unit: "亿元", value: 1200 } };
    const b: Claim = { id: "c2", statement: "市场规模约1200亿元", kind: "fact", evidenceIds: ["e2"], calibration: { entity: "规模", period: "2025", unit: "亿元人民币", value: 1200 } };
    const merged = mergeCrossSourceClaims([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.evidenceIds.sort()).toEqual(["e1", "e2"]);
  });

  it("同题不同值是冲突,不合并", () => {
    const a: Claim = { id: "c1", statement: "市场规模约1200亿元", kind: "fact", evidenceIds: ["e1"] };
    const b: Claim = { id: "c2", statement: "市场规模约2000亿元", kind: "fact", evidenceIds: ["e2"] };
    expect(mergeCrossSourceClaims([a, b])).toHaveLength(2);
  });

  it("单源判定:带口径主张进 calibrated,叙述性事实进 plain", () => {
    const claims: Claim[] = [
      { id: "c1", statement: "规模1200亿元", kind: "fact", evidenceIds: ["e1"], calibration: { entity: "规模", period: "2025", unit: "亿元", value: 1200 } },
      { id: "c2", statement: "品牌历史悠久", kind: "fact", evidenceIds: ["e2"] },
      { id: "c3", statement: "双源主张", kind: "fact", evidenceIds: ["e3", "e4"] },
    ];
    const r = checkMultiSource(
      claims,
      [ev("e1", "s1"), ev("e2", "s2"), ev("e3", "s3"), ev("e4", "s4")],
      [snap("s1", "https://a.21jingji.com/1"), snap("s2", "https://b.yicai.com/1"), snap("s3", "https://c.21jingji.com/2"), snap("s4", "https://d.yicai.com/2")],
      new Set(["e1", "e2", "e3", "e4"]),
    );
    expect(r.singleSourceCalibrated).toEqual(["c1"]);
    expect(r.singleSourcePlain).toEqual(["c2"]);
  });
});
