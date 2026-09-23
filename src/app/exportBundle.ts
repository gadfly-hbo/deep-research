import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import type { ResearchResultBundle } from "../contracts.js";
import type { LibraryStore } from "../library/types.js";

export interface ExportFile {
  path: string;
  content: string | Uint8Array;
}

/** 2.0 成果包增量上下文(§12.5):无上下文时保持一期包结构 */
export interface ExportContext {
  library: LibraryStore;
  runId: string;
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

const jsonl = (rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");

const sha256of = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

/** 一期成果包结构(report/manifest/evidence),保持同步以兼容既有调用与测试。 */
export function buildExportFiles(bundle: ResearchResultBundle): ExportFile[] {
  const manifest = {
    schemaVersion: "1.0",
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
        sha256: sha256of(s.bodyText),
      })),
      null,
      2,
    ),
  });
  return files;
}

/**
 * 2.0 成果包增量(§12.5):在一期结构上追加 claims/evidence/sources/source_versions/
 * calculations/asset_bindings jsonl、review_summary、limitations.md 与 permitted_assets/,
 * manifest 升级到 schema 2.0 并带资产版本清单与删减/缺失原因。
 * 未含原文时如实说明"引用可追溯但接收方未必能访问"。
 */
export async function buildExportFilesV2(bundle: ResearchResultBundle, ctx: ExportContext): Promise<ExportFile[]> {
  const files = buildExportFiles(bundle);
  const bindings = await ctx.library.bindingsForRun(ctx.runId);

  files.push({ path: "claims.jsonl", content: jsonl(bundle.claims) });
  files.push({ path: "evidence.jsonl", content: jsonl(bundle.evidence) });
  files.push({ path: "calculations.jsonl", content: jsonl([]) });
  files.push({ path: "asset_bindings.jsonl", content: jsonl(bindings) });
  files.push({
    path: "review_summary.json",
    content: JSON.stringify(
      {
        runId: bundle.runId,
        verdicts: bundle.verdicts,
        unresolved: bundle.unresolved,
        note: "程序化核查结果;语义支持/外推/反例由研究评审与人工抽检承担",
      },
      null,
      2,
    ),
  });
  files.push({
    path: "limitations.md",
    content: bundle.limitations.length
      ? `# 限制与缺口\n\n${bundle.limitations.map((l) => `- ${l}`).join("\n")}\n`
      : "# 限制与缺口\n\n(本次运行未记录额外限制)\n",
  });

  const assetVersions: unknown[] = [];
  const omissions: Array<{ asset: string; reason: string }> = [];
  const seenSources = new Map<string, unknown>();
  const seenVersions = new Map<string, unknown>();
  for (const binding of bindings) {
    const version = await ctx.library.getVersion(binding.versionId);
    const source = version ? await ctx.library.getSource(version.sourceId) : null;
    if (version) seenVersions.set(version.versionId, version);
    if (source) seenSources.set(source.sourceId, source);
    assetVersions.push({
      sourceId: binding.sourceId,
      versionId: binding.versionId,
      purpose: binding.purpose,
      applicability: binding.applicability,
      asOf: binding.asOf ?? null,
    });
    // 许可转交:仅在取得记录显式授权时包含全文或摘录;否则只留引用并说明缺失
    const acquisitions = await ctx.library.acquisitionsForVersion(binding.versionId);
    const fulltext = acquisitions.some((a) => a.rights.exportFulltext === true);
    const excerpt = acquisitions.some((a) => a.rights.exportExcerpt === true);
    const content = version?.contentRef ? await ctx.library.readContent(version.contentRef) : null;
    if (fulltext && content !== null) {
      files.push({ path: `permitted_assets/${binding.versionId}.txt`, content });
    } else if (excerpt && content !== null) {
      files.push({ path: `permitted_assets/${binding.versionId}.excerpt.txt`, content: content.slice(0, 800) });
    } else {
      omissions.push({
        asset: `${source?.title ?? binding.sourceId}@${binding.versionId}`,
        reason: "未取得全文/摘录转交授权:引用可追溯但接收方未必能访问",
      });
    }
  }
  files.push({ path: "sources.jsonl", content: jsonl([...seenSources.values()]) });
  files.push({ path: "source_versions.jsonl", content: jsonl([...seenVersions.values()]) });

  const manifestIndex = files.findIndex((f) => f.path === "manifest.json");
  const base = JSON.parse(files[manifestIndex].content as string) as Record<string, unknown>;
  files[manifestIndex] = {
    path: "manifest.json",
    content: JSON.stringify(
      {
        ...base,
        schemaVersion: "2.0",
        assetVersions,
        omissions,
        includesPermittedOriginals: omissions.length === 0 && assetVersions.length > 0,
        fileHashes: Object.fromEntries(files.filter((f) => f.path !== "manifest.json").map((f) => [f.path, sha256of(f.content)])),
      },
      null,
      2,
    ),
  };
  return files;
}

export function zipExport(files: ExportFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    entries[file.path] = typeof file.content === "string" ? strToU8(file.content) : file.content;
  }
  return zipSync(entries);
}
