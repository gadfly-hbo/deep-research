import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapters } from "../adapters/types.js";
import type { ResearchRequest, ResearchResultBundle } from "../contracts.js";
import { runResearch, type RunOptions, type RunResult } from "../core/runResearch.js";
import { FormalOutputSchema, type FormalOutput } from "../core/stages.js";
import { assembleFormalReport, renderFormalHtml, renderFormalPptx } from "./formalReport.js";
import { splitMdSections } from "./markdown.js";
import { FsProjectStore } from "../stores/fsStore.js";

export interface DiffSummary {
  addedClaims: string[];
  removedClaims: string[];
  evidenceDelta: number;
  addedLimitations: string[];
  removedLimitations: string[];
}

export function diffBundles(prev: ResearchResultBundle | null, next: ResearchResultBundle): DiffSummary {
  if (!prev) {
    return {
      addedClaims: next.claims.map((c) => c.statement),
      removedClaims: [],
      evidenceDelta: next.evidence.length,
      addedLimitations: next.limitations,
      removedLimitations: [],
    };
  }
  const prevStatements = new Set(prev.claims.map((c) => c.statement));
  const nextStatements = new Set(next.claims.map((c) => c.statement));
  const prevLimitations = new Set(prev.limitations);
  const nextLimitations = new Set(next.limitations);
  return {
    addedClaims: next.claims.filter((c) => !prevStatements.has(c.statement)).map((c) => c.statement),
    removedClaims: prev.claims.filter((c) => !nextStatements.has(c.statement)).map((c) => c.statement),
    evidenceDelta: next.evidence.length - prev.evidence.length,
    addedLimitations: next.limitations.filter((l) => !prevLimitations.has(l)),
    removedLimitations: prev.limitations.filter((l) => !nextLimitations.has(l)),
  };
}

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

export function configHashOf(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export function createProject(
  dataDir: string,
  input: { module: "brand" | "industry"; goal: string; scope: { summary: string; queries: string[] } },
): string {
  const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(dataDir, "projects", id);
  FsProjectStore.create(dir, input);
  return dir;
}

export async function runOnProject(
  dir: string,
  request: ResearchRequest,
  adapters: Adapters,
  options: RunOptions = {},
): Promise<RunResult> {
  const store = FsProjectStore.open(dir);
  await store.saveRequest(request);
  return runResearch(request, adapters, store, options);
}

export async function publishBundle(
  dir: string,
  runId: string,
  library?: import("../library/types.js").LibraryStore,
): Promise<{ version: number; diffSummary: DiffSummary }> {
  const store = FsProjectStore.open(dir);
  const bundle = await store.readBundle(runId);
  if (!bundle) throw new Error(`run 无成果包,不能发布: ${runId}`);
  const meta = store.meta();
  if (meta.versions.some((v) => v.runId === runId)) {
    throw new Error(`run 已发布: ${runId}`);
  }
  // 2.0 发布门禁(§14.3):引用闭合到固定版本、来源未撤回、提取无致命问题、无越权绑定
  if (library) {
    for (const ev of bundle.evidence) {
      if (!ev.versionId) continue;
      const version = await library.getVersion(ev.versionId);
      if (!version) {
        throw new Error(`发布阻断:证据 ${ev.id} 绑定的来源版本不存在(${ev.versionId}),引用不闭合`);
      }
      const source = await library.getSource(version.sourceId);
      if (source?.lifecycle === "WITHDRAWN") {
        throw new Error(`发布阻断:证据 ${ev.id} 的来源已撤回(${source.title});移除相关主张或改用有效来源`);
      }
      if (ev.extractionCheck === "EXTRACTION_ISSUE") {
        throw new Error(`发布阻断:证据 ${ev.id} 标记提取问题;修正摘录/口径或移除主张后再发布`);
      }
    }
    const forbidden = (await library.bindingsForRun(runId)).find((b) => b.applicability === "FORBIDDEN");
    if (forbidden) throw new Error(`发布阻断:运行包含越权绑定(${forbidden.sourceId})`);
    for (const verdict of bundle.verdicts) {
      await library.saveReview({
        reviewId: `rr-${verdict.evidenceId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16)}`,
        objectRef: verdict.evidenceId,
        scope: runId,
        checkType: "extraction",
        result: verdict.verdict === "quote-hit" ? "pass" : "fail",
        reason: `${verdict.verdict}${verdict.entailment ? ` / entailment=${verdict.entailment}` : ""}${
          verdict.numeric ? ` / numeric=${verdict.numeric}` : ""
        }`,
        reviewedAt: new Date().toISOString(),
        reviewer: "system:citationVerifier",
      });
    }
  }
  const version = meta.versions.length + 1;
  const target = join(dir, "reports", `v${version}`);
  if (existsSync(target)) {
    throw new Error(`版本目录已存在,发布被拒绝(版本不可变): ${target}`);
  }
  let prev: ResearchResultBundle | null = null;
  if (meta.versions.length > 0) {
    const prevPath = join(dir, "reports", `v${version - 1}`, "bundle.json");
    if (existsSync(prevPath)) {
      prev = JSON.parse(readFileSync(prevPath, "utf8")) as ResearchResultBundle;
    }
  }
  const diffSummary = diffBundles(prev, bundle);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "bundle.json"), JSON.stringify(bundle, null, 2));
  writeFileSync(join(target, "report.md"), bundle.reportMd);
  store.saveMeta({
    versions: [
      ...meta.versions,
      { version, runId, publishedAt: new Date().toISOString(), diffSummary },
    ],
  });
  store.audit("published", {
    version,
    runId,
    configHash: configHashOf({ module: meta.module, goal: meta.goal, scope: meta.scope, version }),
  });
  return { version, diffSummary };
}

export function templateRequest(dir: string): ResearchRequest {
  const meta = FsProjectStore.open(dir).meta();
  return {
    module: meta.module,
    goal: meta.goal,
    scope: { ...meta.scope, queries: [...meta.scope.queries] },
    attachments: [],
  };
}

const MODULE_LABEL: Record<string, string> = { brand: "品牌研究", industry: "行业研究" };

/**
 * 生成正式报告:对已发布版本做定稿化装配(HTML/PPTX)。
 * LLM formal 阶段仅做摘要提炼,失败或输出不合格时确定性兜底;不新增任何事实。
 */
export async function generateFormal(
  dir: string,
  version: number,
  model: Adapters["model"],
): Promise<{ version: number; formats: string[]; summarySource: "model" | "fallback" }> {
  const store = FsProjectStore.open(dir);
  const meta = store.meta();
  const target = join(dir, "reports", `v${version}`);
  const bundlePath = join(target, "bundle.json");
  if (!existsSync(bundlePath)) throw new Error(`版本不存在: v${version}`);
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as ResearchResultBundle;

  const draftSections = splitMdSections(bundle.reportMd)
    .filter((s) => s.heading !== undefined && s.level !== 1)
    .map((s, i) => ({
      sectionId: bundle.outline?.sections[i]?.id ?? `x${i + 1}`,
      title: s.heading ?? "",
      text: s.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1600),
    }));
  let formalOutput: FormalOutput | undefined;
  let summarySource: "model" | "fallback" = "fallback";
  try {
    const res = await model.runStage(
      "formal",
      {
        goal: meta.goal,
        delivery: bundle.limitations.length > 0 ? "limited" : "full",
        sections: draftSections,
        claims: bundle.claims.map((c) => ({ statement: c.statement, kind: c.kind })),
      },
      `formal:${dir}:v${version}`,
    );
    const parsed = FormalOutputSchema.safeParse(res.output);
    if (parsed.success) {
      formalOutput = parsed.data;
      summarySource = "model";
    }
  } catch {
    // 模型不可用:走确定性兜底,正式报告仍然可产
  }

  const formal = assembleFormalReport(bundle, { moduleLabel: MODULE_LABEL[meta.module] ?? meta.module, goal: meta.goal }, formalOutput);
  const outDir = join(target, "formal");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "formal.json"), JSON.stringify(formal, null, 2));
  writeFileSync(join(outDir, "report.html"), renderFormalHtml(formal));
  writeFileSync(join(outDir, "report.pptx"), Buffer.from(await renderFormalPptx(formal)));
  store.audit("formal", { version, summarySource, delivery: formal.delivery });
  return { version, formats: ["html", "pptx", "json"], summarySource };
}
