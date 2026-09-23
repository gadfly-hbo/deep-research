import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchStatus, ReuseScope } from "./contracts.js";
import type { FsLibraryStore } from "./fsLibraryStore.js";
import { buildInvertedIndex, makeSnippet, searchIndex, type InvertedIndex } from "./searchIndex.js";

/** 检索上下文:projectId 存在时按项目权限过滤;缺省为工作台属主视图(全量) */
export interface SearchContext {
  projectId?: string;
}

export interface SearchFilters {
  docType?: string;
  lifecycle?: "ACTIVE" | "ARCHIVED" | "WITHDRAWN";
  fetchStatus?: FetchStatus;
  reuseScope?: ReuseScope;
  dataPeriod?: string;
  entityIds?: string[];
}

export interface AssetSearchResult {
  sourceId: string;
  title: string;
  docType: string;
  fetchStatus: FetchStatus;
  reuseScope: ReuseScope;
  versionId: string;
  snippet: string;
  matchedTerms: string[];
}

export interface SearchOutcome {
  results: AssetSearchResult[];
  /** ok=命中已有索引;rebuilt=索引缺失/落后已重建;unavailable=索引不可用(列表访问仍可用) */
  indexState: "ok" | "rebuilt" | "unavailable";
}

const INDEX_FILE = "index.json";

interface IndexMeta extends InvertedIndex {
  sourceSignature: string;
}

/** 索引签名含版本集合:更正/新增版本必须触发重建(§12.3 索引状态不得谎报) */
function signatureOf(sourceIds: string[], versionIds: string[]): string {
  return `${[...sourceIds].sort().join("|")}#${[...versionIds].sort().join("|")}`;
}

function loadIndex(dir: string): IndexMeta | null {
  const path = join(dir, INDEX_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as IndexMeta;
  } catch {
    return null;
  }
}

export async function rebuildIndex(store: FsLibraryStore): Promise<IndexMeta> {
  const sources = await store.listSources();
  const allVersionIds: string[] = [];
  const docs: { docId: string; text: string }[] = [];
  for (const source of sources) {
    const versions = await store.versionsForSource(source.sourceId);
    allVersionIds.push(...versions.map((v) => v.versionId));
    const latest = [...versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop();
    const content = latest?.contentRef ? await store.readContent(latest.contentRef) : null;
    const entityText = (source.entityIds ?? []).join(" ");
    docs.push({
      docId: source.sourceId,
      text: [
        source.title,
        source.publisher ?? "",
        source.tags.join(" "),
        entityText,
        latest?.dataPeriod ?? "",
        content ?? "",
      ].join(" "),
    });
  }
  const meta: IndexMeta = {
    ...buildInvertedIndex(docs),
    sourceSignature: signatureOf(
      sources.map((s) => s.sourceId),
      allVersionIds,
    ),
  };
  writeFileSync(join(store.dir, INDEX_FILE), JSON.stringify(meta));
  return meta;
}

export function dropIndex(store: { dir: string }): void {
  rmSync(join(store.dir, INDEX_FILE), { force: true });
}

/** S-01 权限过滤:项目上下文只看见自己的 + WORKSPACE_REUSABLE;属主视图全量 */
function allowed(sourceId: string, scopes: ReuseScope[], projectIds: string[], ctx: SearchContext): boolean {
  if (!ctx.projectId) return true;
  return projectIds.includes(ctx.projectId) || scopes.includes("WORKSPACE_REUSABLE");
}

export async function searchAssets(
  store: FsLibraryStore,
  query: string,
  filters: SearchFilters,
  ctx: SearchContext,
): Promise<SearchOutcome> {
  const sources = await store.listSources();
  let meta = loadIndex(store.dir);
  let indexState: SearchOutcome["indexState"] = "ok";
  const versionIds = (
    await Promise.all(sources.map((s) => store.versionsForSource(s.sourceId)))
  ).flat();
  const signature = signatureOf(
    sources.map((s) => s.sourceId),
    versionIds.map((v) => v.versionId),
  );
  if (!meta || meta.sourceSignature !== signature) {
    meta = await rebuildIndex(store);
    indexState = "rebuilt";
  }
  if (!meta) return { results: [], indexState: "unavailable" };
  if (!query.trim()) return { results: [], indexState };

  const hits = searchIndex(meta, query);
  const results: AssetSearchResult[] = [];
  for (const hit of hits) {
    const source = sources.find((s) => s.sourceId === hit.docId);
    if (!source) continue;
    if (filters.docType && source.docType !== filters.docType) continue;
    if (filters.lifecycle && source.lifecycle !== filters.lifecycle) continue;
    if (filters.entityIds && filters.entityIds.length > 0) {
      if (!filters.entityIds.some((id) => source.entityIds.includes(id))) continue;
    }
    const versions = (await store.versionsForSource(source.sourceId)).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const latest = versions[versions.length - 1];
    if (!latest) continue;
    if (filters.fetchStatus && latest.fetchStatus !== filters.fetchStatus) continue;
    if (filters.dataPeriod && (latest.dataPeriod ?? "").includes(filters.dataPeriod) === false) continue;

    // 授权判定与 checkReuse 一致:本版本无取得记录(如更正版本)时回落到同源任一版本
    let acquisitions = await store.acquisitionsForVersion(latest.versionId);
    if (acquisitions.length === 0) {
      acquisitions = (
        await Promise.all(versions.map((v) => store.acquisitionsForVersion(v.versionId)))
      ).flat();
    }
    const scopes = acquisitions.map((a) => a.reuseScope);
    const projectIds = acquisitions.map((a) => a.projectId ?? "").filter(Boolean);
    const reuseScope: ReuseScope = scopes.includes("WORKSPACE_REUSABLE")
      ? "WORKSPACE_REUSABLE"
      : scopes.includes("RESTRICTED")
        ? "RESTRICTED"
        : "PROJECT_ONLY";
    if (filters.reuseScope && reuseScope !== filters.reuseScope) continue;
    if (!allowed(source.sourceId, scopes, projectIds, ctx)) continue;

    const content = latest.contentRef ? await store.readContent(latest.contentRef) : null;
    const snippet = content && hit.positions.length > 0 ? makeSnippet(content, hit.positions[0]) : source.title;
    results.push({
      sourceId: source.sourceId,
      title: source.title,
      docType: source.docType,
      fetchStatus: latest.fetchStatus,
      reuseScope,
      versionId: latest.versionId,
      snippet,
      matchedTerms: hit.matchedTerms,
    });
  }
  return { results, indexState };
}
