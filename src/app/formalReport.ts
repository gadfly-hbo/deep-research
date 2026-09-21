/**
 * 正式报告引擎:把已发布的草稿版本装配为定稿产物(精排 HTML / PPTX)。
 * 原则:只重组草稿既有内容与主张,LLM 仅做摘要提炼且有确定性兜底,严禁新增事实。
 */
import pptxmod from "pptxgenjs";
import type { ResearchResultBundle } from "../contracts.js";
import type { FormalOutput } from "../core/stages.js";
import { escapeHtml, renderInline, splitMdSections } from "./markdown.js";

// pptxgenjs 的 d.ts 用 ESM `export default` 描述一个 CJS 构造器,NodeNext 下默认导入类型错位;此处按声明里的 default 提取构造器类型
type PptxCtor = typeof import("pptxgenjs")["default"] extends infer T
  ? T extends new (...args: never[]) => infer I
    ? new () => I
    : never
  : never;
const PptxGenJS = pptxmod as unknown as PptxCtor;

export interface FormalSection {
  id: string;
  title: string;
  purpose?: string;
  highlights: string[];
  html: string;
}

export interface FormalReport {
  title: string;
  subtitle?: string;
  moduleLabel: string;
  goal: string;
  version: number;
  generatedAt: string;
  delivery: "full" | "limited";
  stats: { claims: number; verified: number; unverified: number; inference: number; sources: number };
  executiveSummary: string[];
  sections: FormalSection[];
  limitations: string[];
  unresolved: string[];
  sources: { title: string; url: string }[];
  claimsTable: { statement: string; kind: string; verdict: string }[];
}

export interface FormalMeta {
  moduleLabel: string;
  goal: string;
  generatedAt?: string;
}

const norm = (s: string) => s.replace(/[\s,，。.·、:：()（）]/g, "").toLowerCase();

/** 草稿收尾时由编排器自动追加的章节:正式报告在附录单独呈现,不进入正文/目录/摘要提取。 */
const MACHINE_SECTIONS = ["口径冲突披露", "主张状态与引用判定", "未解决问题", "限制"];

const isContentSection = (s: { heading?: string; level?: number }): boolean =>
  s.level !== 1 && !MACHINE_SECTIONS.some((t) => norm(s.heading ?? "").includes(norm(t)));

/** 清理提取文本中的机器噪音:判定方括号、主张 id 括注;并还原 HTML 实体(文本后序还会再转义)。 */
const cleanLine = (text: string): string =>
  text
    .replace(/^\s*[-*]?\s*\[[^\]]*\]\s*/, "")
    .replace(/\(主张[^)]*\)/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();

/** LLM formal 输出不合格时的确定性兜底:从草稿正文(剔除机器附加章节)提取要点。 */
function deterministicFormal(bundle: ResearchResultBundle): FormalOutput {
  const sections = splitMdSections(bundle.reportMd).filter(isContentSection);
  const execFallback: string[] = [];
  for (const s of sections) {
    for (const line of s.html.split(/<li>/).slice(1)) {
      const text = cleanLine(line.split("</li>")[0].replace(/<[^>]+>/g, ""));
      if (text.length >= 8 && execFallback.length < 4) execFallback.push(text.slice(0, 120));
    }
    if (execFallback.length >= 4) break;
  }
  return {
    executiveSummary:
      execFallback.length > 0 ? execFallback : ["(摘要生成失败,请直接阅读正文与主张核查表)"],
    sectionHighlights: [],
  };
}

export function assembleFormalReport(
  bundle: ResearchResultBundle,
  meta: FormalMeta,
  formalOutput?: FormalOutput,
): FormalReport {
  const formal = formalOutput ?? deterministicFormal(bundle);
  const verdictByEvidence = new Map(bundle.verdicts.map((v) => [v.evidenceId, v.verdict]));
  const claimVerdict = (kind: string, evidenceIds: string[]): string => {
    if (kind === "unverified") return "unverified";
    if (evidenceIds.length === 0) return "no-evidence";
    return evidenceIds.every((eid) => verdictByEvidence.get(eid) === "quote-hit") ? "quote-hit" : "mismatch";
  };
  const stats = {
    claims: bundle.claims.length,
    verified: bundle.claims.filter((c) => claimVerdict(c.kind, c.evidenceIds) === "quote-hit").length,
    unverified: bundle.claims.filter((c) => c.kind === "unverified").length,
    inference: bundle.claims.filter((c) => c.kind === "inference").length,
    sources: bundle.snapshots.length,
  };
  const highlightBySection = new Map(formal.sectionHighlights.map((h) => [h.sectionId, h.bullets]));

  // 草稿按 ## 标题切节(剔除文档标题与机器附加章节),与确认框架按标题归一匹配
  const draftSections = splitMdSections(bundle.reportMd).filter((s) => s.heading !== undefined && isContentSection(s));
  const outline = bundle.outline;
  const sections: FormalSection[] = [];
  const usedDraftIdx = new Set<number>();
  if (outline) {
    for (const os of outline.sections) {
      const idx = draftSections.findIndex(
        (ds, i) => !usedDraftIdx.has(i) && (norm(ds.heading ?? "").includes(norm(os.title)) || norm(os.title).includes(norm(ds.heading ?? ""))),
      );
      if (idx >= 0) {
        usedDraftIdx.add(idx);
        sections.push({
          id: os.id,
          title: os.title,
          purpose: os.purpose,
          highlights: highlightBySection.get(os.id) ?? os.bullets.slice(0, 4),
          html: draftSections[idx].html,
        });
      } else {
        // 框架有而草稿缺:如实标注,不补写内容
        sections.push({
          id: os.id,
          title: os.title,
          purpose: os.purpose,
          highlights: [],
          html: "<p>(草稿未覆盖本节,详见「限制与未解决问题」。)</p>",
        });
      }
    }
  }
  draftSections.forEach((ds, i) => {
    if (usedDraftIdx.has(i)) return;
    sections.push({
      id: `x${i + 1}`,
      title: ds.heading ?? `补充 ${i + 1}`,
      highlights: [],
      html: ds.html,
    });
  });

  return {
    title: bundle.outline?.title ?? bundle.reportMd.split("\n")[0]?.replace(/^#+\s*/, "") ?? meta.goal,
    subtitle: bundle.outline?.subtitle ?? meta.goal,
    moduleLabel: meta.moduleLabel,
    goal: meta.goal,
    version: bundle.version,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    delivery: bundle.limitations.length > 0 ? "limited" : "full",
    stats,
    executiveSummary: formal.executiveSummary,
    sections,
    limitations: bundle.limitations,
    unresolved: bundle.unresolved,
    sources: bundle.snapshots.map((s) => ({ title: s.title || s.url, url: s.url })),
    claimsTable: bundle.claims.map((c) => ({
      statement: c.statement,
      kind: c.kind,
      verdict: claimVerdict(c.kind, c.evidenceIds),
    })),
  };
}

const KIND_LABEL: Record<string, string> = { fact: "事实", inference: "推断", unverified: "未验证" };
const VERDICT_LABEL: Record<string, string> = {
  "quote-hit": "已核查",
  mismatch: "未命中",
  unverified: "未验证",
  "no-evidence": "无证据",
  "snapshot-missing": "快照缺失",
};

const FORMAL_CSS = `
:root{--ink:#1a2233;--soft:#5b6474;--line:#dde2ea;--accent:#1e4e8c;--accent-soft:#eef3fa;--paper:#fff;--warn-bg:#fdf6ec;--warn-line:#e6c07f}
*{box-sizing:border-box}
body{margin:0;background:#f2f4f8;color:var(--ink);font:15px/1.85 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.page{max-width:880px;margin:0 auto;background:var(--paper);box-shadow:0 1px 24px rgba(20,32,60,.08)}
.cover{padding:64px 56px 40px;border-top:6px solid var(--accent)}
.cover .kicker{font-size:12.5px;letter-spacing:.35em;color:var(--accent);text-transform:uppercase;margin-bottom:18px}
.cover h1{font-family:"Songti SC","Noto Serif SC",serif;font-size:34px;line-height:1.35;margin:0 0 10px}
.cover .subtitle{color:var(--soft);font-size:15px;margin:0 0 26px}
.meta-strip{display:flex;flex-wrap:wrap;gap:10px 26px;padding:14px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:13px;color:var(--soft)}
.meta-strip b{color:var(--ink);font-weight:600}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:600}
.badge.full{background:#e8f5ec;color:#1c7c40}.badge.limited{background:var(--warn-bg);color:#9a6b16;border:1px solid var(--warn-line)}
.toc{padding:30px 56px 8px;font-size:14px}
.toc h2{font-size:13px;letter-spacing:.25em;color:var(--soft);font-weight:600;margin:0 0 12px}
.toc ol{margin:0;padding-left:20px}
.toc li{margin:5px 0}
.toc a{color:var(--ink);text-decoration:none;border-bottom:1px dotted var(--line)}
.section{padding:26px 56px}
.section h2{font-family:"Songti SC","Noto Serif SC",serif;font-size:22px;margin:0 0 4px;padding-left:14px;border-left:4px solid var(--accent)}
.section .purpose{color:var(--soft);font-size:13px;margin:6px 0 12px}
.highlights{background:var(--accent-soft);border-radius:8px;padding:12px 18px;margin:0 0 14px}
.highlights li{margin:4px 0}
.body h3{font-size:16.5px;margin:18px 0 8px}
.body p{margin:8px 0}
.md-table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13.5px}
.md-table th{background:#f6f8fb;text-align:left}
.md-table th,.md-table td{border:1px solid var(--line);padding:7px 10px;vertical-align:top}
blockquote{margin:10px 0;padding:8px 14px;border-left:3px solid var(--accent);background:#fafbfd;color:var(--soft)}
.summary-card{margin:24px 56px 8px;padding:22px 26px;border:1px solid var(--line);border-radius:10px;background:linear-gradient(180deg,#fbfcfe,#f4f7fb)}
.summary-card h2{font-size:13px;letter-spacing:.25em;color:var(--accent);margin:0 0 12px;font-weight:600}
.summary-card li{margin:7px 0}
.appendix{padding:26px 56px 56px}
.appendix h2{font-size:18px;margin:22px 0 10px;padding-left:12px;border-left:4px solid var(--line)}
.appendix .warn{background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:8px;padding:12px 16px}
.appendix ol{padding-left:20px;font-size:13px;color:var(--soft)}
.appendix ol li{margin:4px 0;word-break:break-all}
.foot{padding:18px 56px;border-top:1px solid var(--line);color:var(--soft);font-size:12px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px}
@media print{
  body{background:#fff}.page{box-shadow:none;max-width:none}
  .section{page-break-before:always;padding:20px 0}
  .cover{border-top:none;padding-top:24px}
  .summary-card{page-break-inside:avoid}
  a{color:inherit}
}
`;

/** 精排 HTML:浏览即读,打印(@media print + ?print=1)即 PDF。 */
export function renderFormalHtml(r: FormalReport): string {
  const date = new Date(r.generatedAt);
  const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const toc = r.sections
    .map((s, i) => `<li><a href="#${s.id}">${escapeHtml(s.title)}</a></li>`)
    .join("");
  const sections = r.sections
    .map(
      (s) => `
<section class="section" id="${escapeHtml(s.id)}">
  <h2>${escapeHtml(s.title)}</h2>
  ${s.purpose ? `<p class="purpose">${renderInline(s.purpose)}</p>` : ""}
  ${s.highlights.length ? `<ul class="highlights">${s.highlights.map((b) => `<li>${renderInline(b)}</li>`).join("")}</ul>` : ""}
  <div class="body">${s.html}</div>
</section>`,
    )
    .join("\n");
  const claimsRows = r.claimsTable
    .map(
      (c) =>
        `<tr><td>${renderInline(c.statement)}</td><td>${KIND_LABEL[c.kind] ?? c.kind}</td><td>${VERDICT_LABEL[c.verdict] ?? c.verdict}</td></tr>`,
    )
    .join("");
  const limited = r.delivery === "limited";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(r.title)}</title>
<style>${FORMAL_CSS}</style>
</head>
<body>
<div class="page">
  <header class="cover">
    <div class="kicker">Deep Research Report</div>
    <h1>${escapeHtml(r.title)}</h1>
    ${r.subtitle ? `<p class="subtitle">${escapeHtml(r.subtitle)}</p>` : ""}
    <div class="meta-strip">
      <span>模块 <b>${escapeHtml(r.moduleLabel)}</b></span>
      <span>版本 <b>v${r.version}</b></span>
      <span>日期 <b>${dateStr}</b></span>
      <span>交付 <b><span class="badge ${limited ? "limited" : "full"}">${limited ? "有限交付" : "完整交付"}</span></b></span>
      <span>主张 <b>${r.stats.claims}</b>(已核查 ${r.stats.verified} · 推断 ${r.stats.inference} · 未验证 ${r.stats.unverified})</span>
      <span>来源 <b>${r.stats.sources}</b></span>
    </div>
  </header>
  <nav class="toc">
    <h2>目录</h2>
    <ol>${toc}</ol>
  </nav>
  <div class="summary-card">
    <h2>摘要</h2>
    <ul>${r.executiveSummary.map((b) => `<li>${renderInline(b)}</li>`).join("")}</ul>
  </div>
  ${sections}
  <div class="appendix">
    <h2>主张与核查</h2>
    <table class="md-table"><thead><tr><th>主张</th><th>类型</th><th>核查</th></tr></thead><tbody>${claimsRows}</tbody></table>
    ${r.limitations.length ? `<h2>限制</h2><div class="warn"><ul>${r.limitations.map((l) => `<li>${renderInline(l)}</li>`).join("")}</ul></div>` : ""}
    ${r.unresolved.length ? `<h2>未解决问题</h2><ul>${r.unresolved.map((u) => `<li>${renderInline(u)}</li>`).join("")}</ul>` : ""}
    <h2>来源清单</h2>
    <ol>${r.sources.map((s) => `<li>${escapeHtml(s.title)} — ${escapeHtml(s.url)}</li>`).join("")}</ol>
  </div>
  <div class="foot">
    <span>独立深度研究工作台 · 证据可追溯</span>
    <span>run ${escapeHtml(String(r.version))} · ${dateStr} 生成</span>
  </div>
</div>
<script>if(location.search.indexOf("print=1")>=0){setTimeout(function(){window.print()},300)}</script>
</body>
</html>`;
}

/** PPTX:封面/摘要/分节/主张统计/限制与来源,16:9。 */
export async function renderFormalPptx(r: FormalReport): Promise<Uint8Array> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "W169", width: 13.33, height: 7.5 });
  pptx.layout = "W169";
  const ACCENT = "1E4E8C";
  const INK = "1A2233";
  const dateStr = r.generatedAt.slice(0, 10);

  const cover = pptx.addSlide();
  cover.background = { color: "F4F7FB" };
  cover.addText(r.moduleLabel, { x: 0.9, y: 2.1, w: 11.5, h: 0.5, fontSize: 16, color: ACCENT, bold: true, charSpacing: 4 });
  cover.addText(r.title, { x: 0.9, y: 2.6, w: 11.5, h: 1.6, fontSize: 40, bold: true, color: INK });
  if (r.subtitle) cover.addText(r.subtitle, { x: 0.9, y: 4.2, w: 11.5, h: 0.6, fontSize: 16, color: "5B6474" });
  cover.addText(
    [
      { text: `v${r.version} · ${dateStr}`, options: { breakLine: true } },
      { text: r.delivery === "limited" ? "有限交付(限制见文内披露)" : "完整交付", options: { breakLine: true } },
      { text: `主张 ${r.stats.claims} · 已核查 ${r.stats.verified} · 来源 ${r.stats.sources}` },
    ],
    { x: 0.9, y: 5.3, w: 11.5, h: 1.2, fontSize: 13, color: "5B6474", lineSpacingMultiple: 1.4 },
  );
  cover.addShape(pptx.ShapeType.rect, { x: 0.9, y: 2.02, w: 0.6, h: 0.06, fill: { color: ACCENT } });

  const summary = pptx.addSlide();
  summary.addText("摘要", { x: 0.9, y: 0.55, w: 11.5, h: 0.8, fontSize: 28, bold: true, color: INK });
  summary.addText(
    r.executiveSummary.slice(0, 6).map((t) => ({ text: t, options: { bullet: true, breakLine: true } })),
    { x: 1.0, y: 1.7, w: 11.3, h: 4.8, fontSize: 16, color: INK, lineSpacingMultiple: 1.5 },
  );

  for (const s of r.sections) {
    const slide = pptx.addSlide();
    slide.addShape(pptx.ShapeType.rect, { x: 0.9, y: 0.72, w: 0.45, h: 0.06, fill: { color: ACCENT } });
    slide.addText(s.title, { x: 0.9, y: 0.9, w: 11.5, h: 0.9, fontSize: 26, bold: true, color: INK });
    if (s.purpose) slide.addText(s.purpose, { x: 0.9, y: 1.75, w: 11.5, h: 0.5, fontSize: 13, color: "5B6474" });
    const bullets = (s.highlights.length ? s.highlights : s.html.replace(/<[^>]+>/g, " ").split(/(?<=[。；;])/).map((t) => t.trim()).filter(Boolean)).slice(0, 6);
    if (bullets.length === 0) bullets.push("(本节证据不足,详见限制披露)");
    slide.addText(
      bullets.map((t) => ({ text: t.slice(0, 120), options: { bullet: true, breakLine: true } })),
      { x: 1.0, y: 2.35, w: 11.3, h: 4.4, fontSize: 15, color: INK, lineSpacingMultiple: 1.5 },
    );
    slide.slideNumber = { x: 12.5, y: 7.05, fontSize: 10, color: "9AA3B2" };
  }

  const stats = pptx.addSlide();
  stats.addText("证据与核查", { x: 0.9, y: 0.55, w: 11.5, h: 0.8, fontSize: 28, bold: true, color: INK });
  const cards: [string, string | number][] = [
    ["主张总数", r.stats.claims],
    ["引用已核查", r.stats.verified],
    ["推断(已标注)", r.stats.inference],
    ["未验证(已降级)", r.stats.unverified],
    ["来源快照", r.stats.sources],
  ];
  cards.forEach(([label, value], i) => {
    const x = 0.9 + i * 2.36;
    stats.addText(String(value), { x, y: 2.0, w: 2.1, h: 1.1, fontSize: 36, bold: true, color: ACCENT, align: "center" });
    stats.addText(label, { x, y: 3.1, w: 2.1, h: 0.5, fontSize: 12.5, color: "5B6474", align: "center" });
  });
  stats.addText("全部结论可回溯至来源快照原文;未通过核查的主张已降级并披露。", { x: 0.9, y: 4.4, w: 11.5, h: 0.6, fontSize: 13, color: "5B6474" });

  const tail = pptx.addSlide();
  tail.addText("限制与来源", { x: 0.9, y: 0.55, w: 11.5, h: 0.8, fontSize: 28, bold: true, color: INK });
  tail.addText(
    r.limitations.slice(0, 5).map((t) => ({ text: t.slice(0, 110), options: { bullet: true, breakLine: true } })),
    { x: 1.0, y: 1.55, w: 6.3, h: 4.6, fontSize: 12.5, color: "8A6A1F", lineSpacingMultiple: 1.4 },
  );
  tail.addText(
    r.sources.slice(0, 8).map((s) => ({ text: `${s.title.slice(0, 40)} — ${s.url.slice(0, 60)}`, options: { bullet: true, breakLine: true } })),
    { x: 7.5, y: 1.55, w: 5.0, h: 4.6, fontSize: 10.5, color: "5B6474", lineSpacingMultiple: 1.35 },
  );

  const buffer = (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
  return new Uint8Array(buffer);
}
