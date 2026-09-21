import { zipSync, strToU8 } from "fflate";
import type { ResearchResultBundle } from "../contracts.js";

export interface ExportFile {
  path: string;
  content: string;
}

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** 最小 Markdown 渲染:标题/列表/段落;所有文本转义,不信任来源内容。 */
export function renderReportHtml(bundle: ResearchResultBundle): string {
  const lines = bundle.reportMd.split("\n");
  const body: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      body.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    if (line.startsWith("## ")) {
      closeList();
      body.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
    } else if (line.startsWith("# ")) {
      closeList();
      body.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
    } else if (line.startsWith("- ")) {
      if (!inList) {
        body.push("<ul>");
        inList = true;
      }
      body.push(`<li>${escapeHtml(line.slice(2))}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      body.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  closeList();
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(bundle.reportMd.split("\n")[0]?.replace(/^#+\s*/, "") || "研究报告")}</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;max-width:52em;margin:2em auto;padding:0 1em;line-height:1.7}h1{border-bottom:2px solid #333;padding-bottom:.3em}h2{margin-top:1.6em}</style>
</head>
<body>
${body.join("\n")}
</body>
</html>`;
}

export function buildExportFiles(bundle: ResearchResultBundle): ExportFile[] {
  const manifest = {
    runId: bundle.runId,
    version: bundle.version,
    claims: bundle.claims,
    evidence: bundle.evidence,
    limitations: bundle.limitations,
    unresolved: bundle.unresolved,
    verdicts: bundle.verdicts,
    auditSummary: bundle.auditSummary ?? null,
  };
  const files: ExportFile[] = [
    { path: "report.md", content: bundle.reportMd },
    { path: "report.html", content: renderReportHtml(bundle) },
    { path: "manifest.json", content: JSON.stringify(manifest, null, 2) },
  ];
  bundle.snapshots.forEach((snapshot, i) => {
    files.push({
      path: `evidence/snapshot-${i + 1}.txt`,
      content: `URL: ${snapshot.url}\n标题: ${snapshot.title}\n抓取时间: ${snapshot.fetchedAt}\n\n${snapshot.bodyText}`,
    });
  });
  files.push({
    path: "evidence/index.json",
    content: JSON.stringify(
      bundle.snapshots.map((s, i) => ({
        file: `evidence/snapshot-${i + 1}.txt`,
        id: s.id,
        url: s.url,
        title: s.title,
        fetchedAt: s.fetchedAt,
        parseStatus: s.parseStatus,
      })),
      null,
      2,
    ),
  });
  return files;
}

export function zipExport(files: ExportFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    entries[file.path] = strToU8(file.content);
  }
  return zipSync(entries);
}
