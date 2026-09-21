import { describe, expect, it } from "vitest";
import { draftFromText } from "./live.js";

describe("draftFromText(draft 输出鲁棒解析)", () => {
  it("合法 JSON 包装 → 取 reportMd", () => {
    expect(draftFromText('{"reportMd":"# 报告\\n\\n正文"}')).toEqual({ reportMd: "# 报告\n\n正文" });
  });

  it("模型直接输出 Markdown(未包 JSON)→ 原文即报告", () => {
    expect(draftFromText("# 行业研究报告\n\n## 市场口径表\n内容。")).toEqual({
      reportMd: "# 行业研究报告\n\n## 市场口径表\n内容。",
    });
  });

  it("Markdown 外面围了代码围栏 → 去围栏", () => {
    expect(draftFromText("```markdown\n# 报告\n```")).toEqual({ reportMd: "# 报告" });
  });
});
