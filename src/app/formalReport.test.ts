import { describe, expect, it } from "vitest";
import type { ResearchResultBundle } from "../contracts.js";
import { assembleFormalReport, renderFormalHtml, renderFormalPptx } from "./formalReport.js";

const bundle: ResearchResultBundle = {
  runId: "run-1",
  version: 2,
  reportMd: [
    "# 品牌研究报告:森马",
    "",
    "## 品牌档案",
    "- **品牌历史**:森马创业已29年。",
    "",
    "## 价格与渠道",
    "| 渠道 | 状态 |",
    "|---|---|",
    "| 线上 | 增长 |",
  ].join("\n"),
  claims: [{ id: "cl:1", statement: "森马创业已29年", kind: "fact", evidenceIds: ["ev:1"] }],
  evidence: [{ id: "ev:1", snapshotId: "snap:1", quote: "森马创业已29年" }],
  snapshots: [
    { id: "snap:1", url: "https://a/1", title: "来源A", fetchedAt: "2026-09-21", bodyText: "正文", parseStatus: "ok", contentType: "text/html" },
  ],
  limitations: ["样本有限"],
  unresolved: [],
  verdicts: [{ evidenceId: "ev:1", verdict: "quote-hit" }],
  outline: {
    title: "品牌研究报告:森马",
    subtitle: "近三年经营情况分析",
    sections: [
      { id: "s1", title: "品牌档案", purpose: "梳理定位与历史", bullets: ["品牌历史", "品牌定位"] },
      { id: "s2", title: "价格与渠道", bullets: ["价格区间"] },
      { id: "s3", title: "竞品格局", bullets: ["主要竞品"] },
    ],
  },
};

const meta = { moduleLabel: "品牌研究", goal: "森马近三年经营情况", generatedAt: "2026-09-21T00:00:00.000Z" };

describe("formalReport(正式报告装配)", () => {
  it("无 LLM 输出时确定性兜底:摘要非空,章节按框架对齐排序", () => {
    const r = assembleFormalReport(bundle, meta);
    expect(r.title).toBe("品牌研究报告:森马");
    expect(r.delivery).toBe("limited");
    expect(r.stats).toMatchObject({ claims: 1, verified: 1, sources: 1 });
    expect(r.executiveSummary.length).toBeGreaterThan(0);
    const ids = r.sections.map((s) => s.id);
    expect(ids[0]).toBe("s1");
    expect(ids[1]).toBe("s2");
    expect(ids[2]).toBe("s3");
    expect(r.sections[0].purpose).toBe("梳理定位与历史");
    expect(r.sections[0].html).toContain("森马创业已29年");
  });

  it("框架有而草稿缺的章节如实标注,不补写内容", () => {
    const r = assembleFormalReport(bundle, meta);
    const missing = r.sections.find((s) => s.id === "s3");
    expect(missing?.html).toContain("草稿未覆盖本节");
  });

  it("LLM formal 输出覆盖摘要与要点", () => {
    const r = assembleFormalReport(bundle, meta, {
      executiveSummary: ["结论一", "结论二"],
      sectionHighlights: [{ sectionId: "s1", bullets: ["提炼要点"] }],
    });
    expect(r.executiveSummary).toEqual(["结论一", "结论二"]);
    expect(r.sections.find((s) => s.id === "s1")?.highlights).toEqual(["提炼要点"]);
  });
});

describe("formalReport(产物)", () => {
  it("HTML 含封面/目录锚点/摘要/限制/来源,且内容转义", () => {
    const dirty: ResearchResultBundle = {
      ...bundle,
      reportMd: bundle.reportMd + "\n\n- <script>alert(1)</script>",
    };
    const html = renderFormalHtml(assembleFormalReport(dirty, meta));
    expect(html).toContain("品牌研究报告:森马");
    expect(html).toContain('href="#s1"');
    expect(html).toContain("摘要");
    expect(html).toContain("有限交付");
    expect(html).toContain("来源清单");
    // 模板自带的打印触发脚本除外;用户内容中的脚本必须被转义
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("window.print");
  });

  it("PPTX 产出为有效 zip 容器(PK 头)", async () => {
    const bytes = await renderFormalPptx(assembleFormalReport(bundle, meta));
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
    expect(bytes.length).toBeGreaterThan(2000);
  });
});
