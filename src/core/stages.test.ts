import { describe, expect, it } from "vitest";
import { DraftOutputSchema, coerceDraftOutput } from "./stages.js";

describe("coerceDraftOutput(模型双重编码还原)", () => {
  it("正常输出原样透传,schema 可解析", () => {
    const raw = { reportMd: "# 标题\n\n正文" };
    expect(coerceDraftOutput(raw)).toEqual(raw);
    expect(() => DraftOutputSchema.parse(coerceDraftOutput(raw))).not.toThrow();
  });

  it("reportMd 值本身是 JSON 文本(2026-10-04 线上实际案例):解包出内层 markdown", () => {
    const inner = '# 森马近3年品牌经营情况研究报告\n\n## 执行摘要\n\n- 已从"国民休闲"演变为"儿童驱动"';
    const raw = { reportMd: JSON.stringify({ report: inner }) };
    expect(coerceDraftOutput(raw)).toEqual({ reportMd: inner });
    expect(() => DraftOutputSchema.parse(coerceDraftOutput(raw))).not.toThrow();
  });

  it("多层嵌套(≤3 层)逐层解包", () => {
    const deep = JSON.stringify({ reportMd: JSON.stringify({ report: "# 深层报告" }) });
    expect(coerceDraftOutput({ reportMd: deep })).toEqual({ reportMd: "# 深层报告" });
  });

  it("别名字段 report:归一为 reportMd", () => {
    expect(coerceDraftOutput({ report: "# 别名" })).toEqual({ reportMd: "# 别名" });
  });

  it("以 { 开头但不是合法 JSON 的文本:原样保留(交给 schema 判定)", () => {
    const raw = { reportMd: "{这不是JSON" };
    expect(coerceDraftOutput(raw)).toEqual(raw);
  });

  it("JSON 解出对象但无 report/reportMd 字段:原样保留", () => {
    const raw = { reportMd: '{"other":"x"}' };
    expect(coerceDraftOutput(raw)).toEqual(raw);
  });

  it("非对象输入(如纯字符串)透传,由 schema 拒绝后走兜底", () => {
    expect(coerceDraftOutput("纯文本")).toBe("纯文本");
  });
});
