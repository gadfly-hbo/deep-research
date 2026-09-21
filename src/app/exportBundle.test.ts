import { unzipSync, strFromU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { ResearchResultBundle } from "../contracts.js";
import { buildExportFiles, renderReportHtml, zipExport } from "./exportBundle.js";

const bundle: ResearchResultBundle = {
  runId: "run-1",
  version: 1,
  reportMd: "# 行业研究\n\n## 市场口径表\n\n- 规模 1200 亿元\n\n<script>alert(1)</script>",
  claims: [
    { id: "c1", statement: "市场规模约 1200 亿元(2025)", kind: "fact", evidenceIds: ["e1"] },
  ],
  evidence: [{ id: "e1", snapshotId: "s1", quote: "1200 亿元" }],
  snapshots: [
    {
      id: "s1",
      url: "https://a/1",
      title: "A",
      fetchedAt: "2026-09-21T00:00:00.000Z",
      bodyText: "正文含 1200 亿元<script>alert(2)</script>",
      parseStatus: "ok",
      contentType: "text/html",
    },
  ],
  limitations: ["样本有限"],
  unresolved: [],
  verdicts: [{ evidenceId: "e1", verdict: "quote-hit" }],
};

describe("导出成果包", () => {
  it("zip 含 report.md / report.html / manifest.json / evidence 文件", () => {
    const files = buildExportFiles(bundle);
    const paths = files.map((f) => f.path).sort();
    expect(paths).toContain("report.md");
    expect(paths).toContain("report.html");
    expect(paths).toContain("manifest.json");
    expect(paths.some((p) => p.startsWith("evidence/"))).toBe(true);

    const zipped = zipExport(files);
    const unzipped = unzipSync(zipped);
    expect(Object.keys(unzipped).sort()).toEqual(paths);
  });

  it("manifest.json 含 runId/version/主张/限制/判定", () => {
    const files = buildExportFiles(bundle);
    const manifest = JSON.parse(files.find((f) => f.path === "manifest.json")!.content) as Record<string, unknown>;
    expect(manifest.runId).toBe("run-1");
    expect(manifest.version).toBe(1);
    expect((manifest.claims as unknown[]).length).toBe(1);
    expect(manifest.limitations).toEqual(["样本有限"]);
    expect((manifest.verdicts as unknown[]).length).toBe(1);
  });

  it("report.html 自包含且转义来源与报告中的脚本(不可信内容)", () => {
    const html = renderReportHtml(bundle);
    expect(html).toContain("<h1>行业研究</h1>");
    expect(html).toContain("<li>规模 1200 亿元</li>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("快照导出为纯文本文件", () => {
    const files = buildExportFiles(bundle);
    const snap = files.find((f) => f.path.startsWith("evidence/snapshot-"))!;
    expect(snap.content).toContain("1200 亿元");
    expect(snap.path.endsWith(".txt")).toBe(true);
  });
});
