import { describe, expect, it } from "vitest";
import { buildInvertedIndex, searchIndex, tokenize } from "./searchIndex.js";

describe("tokenize(中文 bigram + 英文 token,冻结口径)", () => {
  it("中文按 bigram 切分,英文按整词并小写", () => {
    expect(tokenize("安克")).toEqual(["安克"]);
    expect(tokenize("中国咖啡市场")).toEqual(["中国", "国咖", "咖啡", "啡市", "市场"]);
    expect(tokenize("Anker 2025 年营收 150 亿元")).toContain("anker");
    expect(tokenize("Anker 2025 年营收 150 亿元")).toContain("150");
  });

  it("数字口径参与检索(冻结夹具:数字必须可召回)", () => {
    const terms = tokenize("市场规模约 1,200 亿元");
    expect(terms).toContain("1200");
  });
});

describe("倒排索引构建与检索", () => {
  const docs = [
    { docId: "s-1", text: "安克(Anker)在中国市场的品牌定位与充电器份额" },
    { docId: "s-2", text: "中国咖啡零售行业规模约 1200 亿元,含现磨与即饮" },
    { docId: "s-3", text: "森马服饰 2024 年年报:营收与渠道结构" },
  ];

  it("中文正文可召回(冻结夹具)", () => {
    const index = buildInvertedIndex(docs);
    expect(searchIndex(index, "咖啡").map((r) => r.docId)).toEqual(["s-2"]);
    expect(searchIndex(index, "安克").map((r) => r.docId)).toEqual(["s-1"]);
    expect(searchIndex(index, "森马").map((r) => r.docId)).toEqual(["s-3"]);
  });

  it("英文别名命中同一文档", () => {
    const index = buildInvertedIndex(docs);
    expect(searchIndex(index, "Anker").map((r) => r.docId)).toEqual(["s-1"]);
  });

  it("数字口径可召回", () => {
    const index = buildInvertedIndex(docs);
    expect(searchIndex(index, "1200").map((r) => r.docId)).toEqual(["s-2"]);
  });

  it("无命中返回空,不抛错;命中带位置用于片段预览", () => {
    const index = buildInvertedIndex(docs);
    expect(searchIndex(index, "不存在的词xyz")).toEqual([]);
    const hit = searchIndex(index, "咖啡")[0];
    expect(hit.positions.length).toBeGreaterThan(0);
  });
});
