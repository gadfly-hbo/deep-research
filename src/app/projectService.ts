import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapters } from "../adapters/types.js";
import type { ResearchRequest, ResearchResultBundle } from "../contracts.js";
import { runResearch, type RunOptions, type RunResult } from "../core/runResearch.js";
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
): Promise<{ version: number; diffSummary: DiffSummary }> {
  const store = FsProjectStore.open(dir);
  const bundle = await store.readBundle(runId);
  if (!bundle) throw new Error(`run 无成果包,不能发布: ${runId}`);
  const meta = store.meta();
  if (meta.versions.some((v) => v.runId === runId)) {
    throw new Error(`run 已发布: ${runId}`);
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
