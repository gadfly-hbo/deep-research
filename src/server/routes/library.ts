import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fetchAssetContent, registerAssets, type RegisterInput } from "../../library/assetService.js";
import { changeLifecycle, correctVersion, deleteAsset } from "../../library/lifecycle.js";
import { checkReuse, changeReuseScope } from "../../library/reuse.js";
import { SourceSchema } from "../../library/contracts.js";
import { searchAssets } from "../../library/searchService.js";
import { migrateProjectsToLibrary } from "../../app/migrateLibrary.js";
import { json } from "./http.js";
import type { Ctx } from "./http.js";

// P1-3 T4:library 域(附录 A 第 18–33 项:15 个情报库匹配块 + /api/migrate)。
// HTTP 行为与拆分前逐位一致;5 处局部 try/catch→400 原样机械搬迁(diff gate 注记 8),regex 匹配顺序逐位保留。

/** 返回 true=已处理;false=落到后续域(settings、静态、catch-all)。 */
export const handleLibraryRoutes = async (
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: any,
): Promise<boolean> => {
  const path = url.pathname;
  const method = req.method ?? "GET";
  const library = ctx.library;

  // ---- 外部情报库(U2-01):不依赖研究任务的直接入库 ----
  if (path === "/api/library/assets" && method === "POST") {
    const inputs: RegisterInput[] = (Array.isArray(body.items) ? body.items : [body]).map(
      (item: Record<string, unknown>) => {
        if (item.kind === "file" && typeof item.contentBase64 === "string") {
          const { contentBase64, ...rest } = item;
          return { ...rest, content: new Uint8Array(Buffer.from(contentBase64, "base64")) } as RegisterInput;
        }
        return item as unknown as RegisterInput;
      },
    );
    const results = await registerAssets(library, inputs, { parsePdf: ctx.parsePdf });
    json(res, 200, { results });
    return true;
  }

  if (path === "/api/library/assets" && method === "GET") {
    const sources = await library.listSources();
    const assets = await Promise.all(
      sources.map(async (source) => {
        const versions = await library.versionsForSource(source.sourceId);
        const sorted = [...versions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const latestVersion = sorted[sorted.length - 1] ?? null;
        const acqs = latestVersion ? await library.acquisitionsForVersion(latestVersion.versionId) : [];
        // 可复用性取该版本所有取得记录中最宽松的一档,如实展示
        const scopes = acqs.map((a) => a.reuseScope);
        const reuseScope = scopes.includes("WORKSPACE_REUSABLE")
          ? "WORKSPACE_REUSABLE"
          : scopes.includes("RESTRICTED")
            ? "RESTRICTED"
            : "PROJECT_ONLY";
        return { source, latestVersion, reuseScope, acquisitionCount: acqs.length };
      }),
    );
    json(res, 200, { assets });
    return true;
  }

  if (path === "/api/library/bindings" && method === "GET") {
    const runId = url.searchParams.get("runId") ?? "";
    const bindings = await library.bindingsForRun(runId);
    const usages = await library.usagesForRun(runId);
    json(res, 200, { bindings, usages });
    return true;
  }

  if (path === "/api/library/search" && method === "GET") {
    const q = url.searchParams.get("q") ?? "";
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const docType = url.searchParams.get("docType") ?? undefined;
    const fetchStatus = (url.searchParams.get("fetchStatus") ?? undefined) as
      | "DISCOVERED"
      | "SNIPPET_ONLY"
      | "READ_PARTIAL"
      | "READ_FULL"
      | "UNAVAILABLE"
      | undefined;
    const reuseScope = (url.searchParams.get("reuseScope") ?? undefined) as
      | "PROJECT_ONLY"
      | "WORKSPACE_REUSABLE"
      | "RESTRICTED"
      | undefined;
    const dataPeriod = url.searchParams.get("dataPeriod") ?? undefined;
    const outcome = await searchAssets(
      library,
      q,
      { docType, fetchStatus, reuseScope, dataPeriod },
      { projectId },
    );
    // 选择器四组信息(§11.4):服务端给出每个命中在当前研究上下文中的适用性
    const withApplicability = await Promise.all(
      outcome.results.map(async (r) => {
        const check = await checkReuse(library, {
          runId: "selector-preview",
          projectId: projectId ?? "",
          sourceId: r.sourceId,
          versionId: r.versionId,
          purpose: "selector",
        });
        return { ...r, applicability: projectId ? check.applicability : null, checkNotes: projectId ? check.checkNotes : [] };
      }),
    );
    json(res, 200, { ...outcome, results: withApplicability });
    return true;
  }

  if (path === "/api/library/check" && method === "GET") {
    const sourceId = url.searchParams.get("sourceId") ?? "";
    const versionId = url.searchParams.get("versionId") ?? "";
    const projectId = url.searchParams.get("projectId") ?? "";
    const check = await checkReuse(library, {
      runId: url.searchParams.get("runId") ?? "check-preview",
      projectId,
      sourceId,
      versionId,
      purpose: url.searchParams.get("purpose") ?? "check",
      asOf: url.searchParams.get("asOf") ?? undefined,
    });
    json(res, 200, check);
    return true;
  }

  if (path === "/api/library/entities") {
    if (method === "GET") {
      const entities = await library.listEntities();
      const sources = await library.listSources();
      const withCounts = entities.map((e) => ({
        ...e,
        assetCount: sources.filter((s) => s.entityIds.includes(e.entityId)).length,
      }));
      json(res, 200, { entities: withCounts });
      return true;
    }
    if (method === "POST") {
      const entityId = `en-${randomUUID().slice(0, 8)}`;
      await library.saveEntity({
        entityId,
        type: body.type ?? "other",
        name: String(body.name ?? ""),
        aliases: Array.isArray(body.aliases) ? body.aliases.map(String) : [],
        parentEntityId: body.parentEntityId,
        confirmStatus: body.confirmStatus ?? "CANDIDATE",
        basis: body.basis,
      });
      json(res, 200, { entityId });
      return true;
    }
  }

  const libraryLifecycleMatch = path.match(/^\/api\/library\/assets\/([^/]+)\/lifecycle$/);
  if (libraryLifecycleMatch && method === "POST") {
    try {
      const outcome = await changeLifecycle(
        library,
        decodeURIComponent(libraryLifecycleMatch[1]),
        body.lifecycle,
        body.reason ? String(body.reason) : undefined,
      );
      json(res, 200, outcome);
    } catch (error) {
      json(res, 400, { error: String(error instanceof Error ? error.message : error) });
    }
    return true;
  }

  const libraryScopeMatch = path.match(/^\/api\/library\/assets\/([^/]+)\/scope$/);
  if (libraryScopeMatch && method === "POST") {
    try {
      const outcome = await changeReuseScope(library, {
        versionId: String(body.versionId ?? ""),
        projectId: body.projectId ? String(body.projectId) : undefined,
        targetScope: body.targetScope,
        basis: String(body.basis ?? ""),
      });
      json(res, 200, outcome);
    } catch (error) {
      json(res, 400, { error: String(error instanceof Error ? error.message : error) });
    }
    return true;
  }

  const libraryCorrectionMatch = path.match(/^\/api\/library\/assets\/([^/]+)\/corrections$/);
  if (libraryCorrectionMatch && method === "POST") {
    try {
      const version = await correctVersion(
        library,
        decodeURIComponent(libraryCorrectionMatch[1]),
        String(body.versionId ?? ""),
        String(body.content ?? ""),
      );
      json(res, 200, { version });
    } catch (error) {
      json(res, 400, { error: String(error instanceof Error ? error.message : error) });
    }
    return true;
  }

  const libraryMigrateMatch = path.match(/^\/api\/migrate$/);
  if (libraryMigrateMatch && method === "POST") {
    const dryRun = body.dryRun !== false;
    if (!dryRun && body.confirm !== true) {
      json(res, 400, { error: "应用迁移需 confirm:true(先 dry-run 预演并备份)" });
      return true;
    }
    const report = await migrateProjectsToLibrary(join(ctx.dataDir, "projects"), library, { dryRun });
    json(res, 200, report);
    return true;
  }

  const libraryPatchMatch = path.match(/^\/api\/library\/assets\/([^/]+)$/);
  if (libraryPatchMatch && method === "PATCH") {
    const source = await library.getSource(decodeURIComponent(libraryPatchMatch[1]));
    if (!source) {
      json(res, 404, { error: `资产不存在: ${libraryPatchMatch[1]}` });
      return true;
    }
    // 白名单元数据更正:其余字段一律忽略,防止经 API 注入状态字段
    const patch: Record<string, unknown> = {};
    for (const key of ["title", "publisher", "docType", "tags"] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (Array.isArray(body.entityIds)) patch.entityIds = body.entityIds.map(String);
    const updated = SourceSchema.parse({ ...source, ...patch });
    await library.saveSource(updated);
    library.audit("source-meta-corrected", { sourceId: source.sourceId, patch: Object.keys(patch) });
    json(res, 200, { source: updated });
    return true;
  }

  if (path === "/api/library/assets/fetch" && method === "POST") {
    try {
      const adapters = ctx.makeAdapters();
      const out = await fetchAssetContent(library, String(body.versionId ?? ""), {
        page: adapters.page,
        parser: adapters.parser,
      });
      json(res, 200, out);
    } catch (error) {
      json(res, 400, { error: String(error instanceof Error ? error.message : error) });
    }
    return true;
  }

  const libraryAssetMatch = path.match(/^\/api\/library\/assets\/([^/]+)$/);
  if (libraryAssetMatch && method === "GET") {
    const sourceId = decodeURIComponent(libraryAssetMatch[1]);
    const source = await library.getSource(sourceId);
    if (!source) {
      json(res, 404, { error: `资产不存在: ${sourceId}` });
      return true;
    }
    const versions = (await library.versionsForSource(sourceId)).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const acquisitions = (
      await Promise.all(versions.map((v) => library.acquisitionsForVersion(v.versionId)))
    ).flat();
    json(res, 200, { source, versions, acquisitions });
    return true;
  }

  if (libraryAssetMatch && method === "DELETE") {
    const sourceId = decodeURIComponent(libraryAssetMatch[1]);
    try {
      const preview = url.searchParams.get("preview") === "1";
      const outcome = await deleteAsset(library, sourceId, {
        previewOnly: preview,
        confirm: body.confirm === true || url.searchParams.get("confirm") === "1",
        force: body.force === true || url.searchParams.get("force") === "1",
      });
      json(res, 200, outcome);
    } catch (error) {
      json(res, 400, { error: String(error instanceof Error ? error.message : error) });
    }
    return true;
  }

  const libraryContentMatch = path.match(/^\/api\/library\/content\/([^/]+)$/);
  if (libraryContentMatch && method === "GET") {
    const version = await library.getVersion(decodeURIComponent(libraryContentMatch[1]));
    // §9.3 原文读取检查点:带项目上下文时按授权过滤;缺省为属主本机视图
    const ctxProjectId = url.searchParams.get("projectId");
    if (version && ctxProjectId) {
      const acqs = await library.acquisitionsForVersion(version.versionId);
      const allowedRead = acqs.some(
        (a) => a.projectId === ctxProjectId || a.reuseScope === "WORKSPACE_REUSABLE",
      );
      if (!allowedRead) {
        json(res, 403, { error: "该项目无权读取此版本原文(S-01)" });
        return true;
      }
    }
    const content = version?.contentRef ? await library.readContent(version.contentRef) : null;
    if (!version || content === null) {
      json(res, 404, { error: `原文不可得: ${libraryContentMatch[1]}(可能仅登记入口或解析失败)` });
      return true;
    }
    // 与项目快照路由一致:只回传纯文本,原始 HTML/字节永不下发
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(content);
    return true;
  }

  return false;
};
