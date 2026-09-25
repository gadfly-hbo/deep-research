import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Adapters } from "../adapters/types.js";
import { buildExportFilesV2, zipExport } from "../app/exportBundle.js";
import { createProject, generateFormal, publishBundle, runOnProject } from "../app/projectService.js";
import { ResearchRequestSchema } from "../contracts.js";
import { DEFAULT_BUDGET } from "../core/runResearch.js";
import { OutlineOutputSchema, PlanOutputSchema } from "../core/stages.js";
import { getModuleConfig } from "../modules/registry.js";
import { FsProjectStore } from "../stores/fsStore.js";
import { fetchAssetContent, registerAssets, type RegisterInput } from "../library/assetService.js";
import { changeLifecycle, correctVersion, deleteAsset } from "../library/lifecycle.js";
import { checkReuse, changeReuseScope } from "../library/reuse.js";
import type { AssetBinding } from "../library/contracts.js";
import { SourceSchema } from "../library/contracts.js";
import { FsLibraryStore } from "../library/fsLibraryStore.js";
import { bindAssets } from "../library/reuse.js";
import { searchAssets } from "../library/searchService.js";
import { migrateProjectsToLibrary } from "../app/migrateLibrary.js";

export interface ServerDeps {
  dataDir: string;
  makeAdapters: () => Adapters;
}

export interface RunningServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

const PROJECT_ID = /^p-[a-z0-9-]+$/;
const KEYISH = /key|token|secret|password/i;

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const stripKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([k]) => !KEYISH.test(k)),
    );
  }
  return value;
};

export async function startServer(deps: ServerDeps, port = 0): Promise<RunningServer> {
  const controllers = new Map<string, AbortController>();
  const configPath = join(deps.dataDir, "config.json");

  const projectDir = (id: string): string => {
    if (!PROJECT_ID.test(id)) throw new Error(`非法项目 id: ${id}`);
    return join(deps.dataDir, "projects", id);
  };

  // 情报库(workspace 级):启动时打开并做暂存协调检查(§12.3 半写入恢复)
  const library = FsLibraryStore.openOrCreate(join(deps.dataDir, "library"));
  void library.recoverStaging().then((leftovers) => {
    if (leftovers.length > 0) {
      library.audit("staging-leftover", { count: leftovers.length, note: "上次中断残留暂存,未进可用清单" });
    }
  });

  // PDF 解析注入(unpdf);失败返回 failed 而非抛出,让缺口如实登记(A-04)
  const parsePdf = async (bytes: Uint8Array): Promise<{ bodyText: string; parseStatus: "ok" | "failed" }> => {
    try {
      const { extractText } = await import("unpdf");
      const { text } = await extractText(bytes);
      const bodyText = Array.isArray(text) ? text.join("\n") : String(text ?? "");
      return { bodyText, parseStatus: bodyText.trim() ? "ok" : "failed" };
    } catch {
      return { bodyText: "", parseStatus: "failed" };
    }
  };

  // 启动清扫:上次进程中断遗留的 running 记录标记为 failed,可自检查点重跑
  const projectsRoot = join(deps.dataDir, "projects");
  if (existsSync(projectsRoot)) {
    for (const pid of readdirSync(projectsRoot)) {
      const pdir = join(projectsRoot, pid);
      if (!existsSync(join(pdir, "project.json"))) continue;
      try {
        const store = FsProjectStore.open(pdir);
        for (const run of await store.listRuns()) {
          if (run.status === "running") {
            await store.saveRun({ ...run, status: "failed", error: "服务中断,运行未完成(可重新发起)" });
          }
        }
      } catch { /* 单个项目清扫失败不影响启动 */ }
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      json(res, 500, { error: String(error instanceof Error ? error.message : error) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const body =
      method === "POST" || method === "PATCH" || method === "PUT"
        ? JSON.parse((await readBody(req)) || "{}")
        : {};

    if (method === "GET" && path === "/api/projects") {
      const root = join(deps.dataDir, "projects");
      const projects = existsSync(root)
        ? readdirSync(root)
            .filter((id) => PROJECT_ID.test(id) && existsSync(join(root, id, "project.json")))
            .map((id) => FsProjectStore.open(join(root, id)).meta())
        : [];
      json(res, 200, { projects });
      return;
    }

    if (method === "POST" && path === "/api/projects") {
      const dir = createProject(deps.dataDir, {
        module: body.module,
        goal: body.goal,
        scope: body.scope,
      });
      json(res, 200, { dir, id: dir.split("/").pop() });
      return;
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(.*)$/);
    if (projectMatch) {
      const [, id, rest] = projectMatch;
      const dir = projectDir(id);
      const store = () => FsProjectStore.open(dir);

      if (method === "GET" && rest === "") {
        const s = store();
        json(res, 200, {
          meta: s.meta(),
          runs: await s.listRuns(),
          snapshots: await s.listSnapshots(),
        });
        return;
      }

      if (method === "POST" && rest === "/plan-preview") {
        const cfg = getModuleConfig(body.module ?? store().meta().module);
        const result = await deps
          .makeAdapters()
          .model.runStage(
            "plan",
            { goal: body.goal, scope: body.scope, questionFramework: cfg.questionFramework },
            `plan-preview:${id}:${Date.now()}`,
          );
        json(res, 200, { plan: PlanOutputSchema.parse(result.output), cost: result.cost });
        return;
      }

      if (method === "POST" && rest === "/outline-preview") {
        const cfg = getModuleConfig(body.module ?? store().meta().module);
        const result = await deps
          .makeAdapters()
          .model.runStage(
            "outline",
            {
              goal: body.goal,
              scope: body.scope,
              questions: Array.isArray(body.questions) ? body.questions : [],
              reportTemplate: cfg.reportTemplate,
            },
            `outline-preview:${id}:${Date.now()}`,
          );
        json(res, 200, { outline: OutlineOutputSchema.parse(result.output), cost: result.cost });
        return;
      }

      if (method === "POST" && rest === "/runs") {
        const request = ResearchRequestSchema.parse(body.request);
        const controller = new AbortController();
        controllers.set(request.id ?? "", controller);
        const runId = randomUUID();
        // 2.0 复用选择(§5.2):启动前服务端检查并固定版本绑定;越权项拒绝并回报
        let bindReport: { bound: number; rejected: Array<{ sourceId: string; reason: string }> } = {
          bound: 0,
          rejected: [],
        };
        if (Array.isArray(body.selectedAssets) && body.selectedAssets.length > 0) {
          const outcome = await bindAssets(library, {
            runId,
            projectId: id,
            idempotencyKey: `select-${runId}`,
            bindings: (body.selectedAssets as Array<Record<string, unknown>>).map((a) => ({
              sourceId: String(a.sourceId),
              versionId: String(a.versionId),
              purpose: String(a.purpose ?? "研究复用"),
              applicability: (a.applicability as AssetBinding["applicability"]) ?? "ELIGIBLE",
              asOf: a.asOf ? String(a.asOf) : undefined,
            })),
          });
          bindReport = { bound: outcome.bindings.length, rejected: outcome.rejected };
        }
        // 先落一条 running 记录:启动即可见,进程中断也不至于"无痕消失"
        await FsProjectStore.open(dir).saveRun({
          id: runId,
          requestId: request.id ?? runId,
          stage: "plan",
          status: "running",
          checkpoints: [],
          usage: { searches: 0, fetches: 0, costEstimate: 0, wallMs: 0 },
        });
        void runOnProject(dir, request, deps.makeAdapters(), {
          plan: body.plan,
          signal: controller.signal,
          runId,
          library,
          projectId: id,
        })
          .catch(async (error) => {
            // 失败不冒充完成:落一条 failed run 记录,带错误信息
            await FsProjectStore.open(dir).saveRun({
              id: runId,
              requestId: request.id ?? runId,
              stage: "gather",
              status: "failed",
              checkpoints: [],
              usage: { searches: 0, fetches: 0, costEstimate: 0, wallMs: 0 },
              error: String(error instanceof Error ? error.message : error),
            });
          })
          .finally(() => {
            controllers.delete(request.id ?? "");
          });
        json(res, 200, { started: true, requestId: request.id, reuse: bindReport });
        return;
      }

      if (method === "POST" && rest === "/runs/cancel") {
        const controller = controllers.get(body.requestId);
        if (!controller) {
          json(res, 404, { error: `没有正在运行的 run: ${body.requestId}` });
          return;
        }
        controller.abort();
        json(res, 200, { cancelled: true });
        return;
      }

      if (method === "POST" && rest === "/runs/resume") {
        const request = await store().readRequest(body.requestId);
        if (!request) {
          json(res, 404, { error: `找不到请求: ${body.requestId}` });
          return;
        }
        const controller = new AbortController();
        controllers.set(request.id ?? "", controller);
        const resumeRunId = randomUUID();
        await FsProjectStore.open(dir).saveRun({
          id: resumeRunId,
          requestId: request.id ?? resumeRunId,
          stage: "plan",
          status: "running",
          checkpoints: [],
          usage: { searches: 0, fetches: 0, costEstimate: 0, wallMs: 0 },
        });
        void runOnProject(dir, request, deps.makeAdapters(), {
          plan: body.plan,
          signal: controller.signal,
          runId: resumeRunId,
          library,
          projectId: id,
        })
          .catch(async (error) => {
            await FsProjectStore.open(dir).saveRun({
              id: resumeRunId,
              requestId: request.id ?? resumeRunId,
              stage: "gather",
              status: "failed",
              checkpoints: [],
              usage: { searches: 0, fetches: 0, costEstimate: 0, wallMs: 0 },
              error: String(error instanceof Error ? error.message : error),
            });
          })
          .finally(() => {
            controllers.delete(request.id ?? "");
          });
        json(res, 200, { resumed: true, requestId: request.id });
        return;
      }

      if (method === "POST" && rest === "/publish") {
        json(res, 200, await publishBundle(dir, body.runId, library));
        return;
      }

      if (method === "POST" && rest === "/archive") {
        const archived = body.archived !== false;
        const s = store();
        s.saveMeta({ status: archived ? "archived" : "active" });
        s.audit(archived ? "archived" : "unarchived", {});
        json(res, 200, { status: archived ? "archived" : "active" });
        return;
      }

      const versionMatch = rest.match(/^\/versions\/(\d+)(\/.*)?$/);
      if (versionMatch) {
        const [, vRaw, vRest = ""] = versionMatch;
        const v = Number(vRaw);
        const bundlePath = join(dir, "reports", `v${v}`, "bundle.json");
        if (!existsSync(bundlePath)) {
          json(res, 404, { error: `版本不存在: v${v}` });
          return;
        }

        // 生成正式报告(幂等:重新生成覆盖旧产物)
        if (method === "POST" && vRest === "/formal") {
          json(res, 200, await generateFormal(dir, v, deps.makeAdapters().model));
          return;
        }

        if (method === "GET" && vRest === "/bundle") {
          json(res, 200, JSON.parse(readFileSync(bundlePath, "utf8")));
          return;
        }

        const formalMatch = vRest.match(/^\/formal\/(html|pptx|json)$/);
        if (method === "GET" && formalMatch) {
          const formalDir = join(dir, "reports", `v${v}`, "formal");
          const file =
            formalMatch[1] === "html"
              ? { path: join(formalDir, "report.html"), type: "text/html; charset=utf-8", name: `research-v${v}.html` }
              : formalMatch[1] === "pptx"
                ? {
                    path: join(formalDir, "report.pptx"),
                    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                    name: `research-v${v}.pptx`,
                  }
                : { path: join(formalDir, "formal.json"), type: "application/json; charset=utf-8", name: `research-v${v}-formal.json` };
          if (!existsSync(file.path)) {
            json(res, 404, { error: `正式报告尚未生成: v${v}(先 POST /versions/${v}/formal)` });
            return;
          }
          const buf = readFileSync(file.path);
          res.writeHead(200, {
            "content-type": file.type,
            "content-disposition": `${formalMatch[1] === "json" ? "inline" : "attachment"}; filename="${file.name}"`,
          });
          res.end(buf);
          return;
        }

        if (method === "GET" && vRest === "/export") {
          const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
          const files = await buildExportFilesV2(bundle, { library, runId: bundle.runId });
          const formalDir = join(dir, "reports", `v${v}`, "formal");
          if (existsSync(formalDir)) {
            files.push({
              path: "formal/report.html",
              content: readFileSync(join(formalDir, "report.html"), "utf8"),
            });
            files.push({
              path: "formal/report.pptx",
              content: new Uint8Array(readFileSync(join(formalDir, "report.pptx"))),
            });
            files.push({
              path: "formal/formal.json",
              content: readFileSync(join(formalDir, "formal.json"), "utf8"),
            });
          }
          const zipped = zipExport(files);
          res.writeHead(200, {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="research-v${v}.zip"`,
          });
          res.end(Buffer.from(zipped));
          return;
        }
      }

      if (method === "GET" && rest === "/snapshots") {
        const sid = url.searchParams.get("sid") ?? "";
        const snapshot = (await store().listSnapshots()).find((s) => s.id === sid);
        if (!snapshot) {
          json(res, 404, { error: `快照不存在: ${sid}` });
          return;
        }
        // 只回传净化后的纯文本正文,来源 HTML 永不下发(06 数据与工具权限)
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(snapshot.bodyText);
        return;
      }
    }

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
      const results = await registerAssets(library, inputs, { parsePdf });
      json(res, 200, { results });
      return;
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
      return;
    }

    if (path === "/api/library/bindings" && method === "GET") {
      const runId = url.searchParams.get("runId") ?? "";
      const bindings = await library.bindingsForRun(runId);
      const usages = await library.usagesForRun(runId);
      json(res, 200, { bindings, usages });
      return;
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
      return;
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
      return;
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
        return;
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
        return;
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
      return;
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
      return;
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
      return;
    }

    const libraryMigrateMatch = path.match(/^\/api\/migrate$/);
    if (libraryMigrateMatch && method === "POST") {
      const dryRun = body.dryRun !== false;
      if (!dryRun && body.confirm !== true) {
        json(res, 400, { error: "应用迁移需 confirm:true(先 dry-run 预演并备份)" });
        return;
      }
      const report = await migrateProjectsToLibrary(join(deps.dataDir, "projects"), library, { dryRun });
      json(res, 200, report);
      return;
    }

    const libraryPatchMatch = path.match(/^\/api\/library\/assets\/([^/]+)$/);
    if (libraryPatchMatch && method === "PATCH") {
      const source = await library.getSource(decodeURIComponent(libraryPatchMatch[1]));
      if (!source) {
        json(res, 404, { error: `资产不存在: ${libraryPatchMatch[1]}` });
        return;
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
      return;
    }

    if (path === "/api/library/assets/fetch" && method === "POST") {
      try {
        const adapters = deps.makeAdapters();
        const out = await fetchAssetContent(library, String(body.versionId ?? ""), {
          page: adapters.page,
          parser: adapters.parser,
        });
        json(res, 200, out);
      } catch (error) {
        json(res, 400, { error: String(error instanceof Error ? error.message : error) });
      }
      return;
    }

    const libraryAssetMatch = path.match(/^\/api\/library\/assets\/([^/]+)$/);
    if (libraryAssetMatch && method === "GET") {
      const sourceId = decodeURIComponent(libraryAssetMatch[1]);
      const source = await library.getSource(sourceId);
      if (!source) {
        json(res, 404, { error: `资产不存在: ${sourceId}` });
        return;
      }
      const versions = (await library.versionsForSource(sourceId)).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      const acquisitions = (
        await Promise.all(versions.map((v) => library.acquisitionsForVersion(v.versionId)))
      ).flat();
      json(res, 200, { source, versions, acquisitions });
      return;
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
      return;
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
          return;
        }
      }
      const content = version?.contentRef ? await library.readContent(version.contentRef) : null;
      if (!version || content === null) {
        json(res, 404, { error: `原文不可得: ${libraryContentMatch[1]}(可能仅登记入口或解析失败)` });
        return;
      }
      // 与项目快照路由一致:只回传纯文本,原始 HTML/字节永不下发
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(content);
      return;
    }

    if (path === "/api/settings") {
      if (method === "GET") {
        const raw = existsSync(configPath)
          ? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)
          : {};
        json(res, 200, { config: stripKeys(raw), budgetDefaults: DEFAULT_BUDGET });
        return;
      }
      if (method === "POST") {
        for (const key of Object.keys(body)) {
          if (KEYISH.test(key)) {
            json(res, 400, { error: `密钥不通过 API 写入(字段 ${key});请用环境变量或自行编辑 config.json` });
            return;
          }
        }
        // 合并而非整体覆盖:body 未提及的键(如 search 链路)必须保留
        const existing = existsSync(configPath)
          ? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)
          : {};
        const merged: Record<string, unknown> = { ...existing, ...body };
        // 模型为主备链(数组)时,UI 只编辑链首
        if (body.model && !Array.isArray(body.model) && Array.isArray(existing.model)) {
          merged.model = [body.model, ...(existing.model as unknown[]).slice(1)];
        }
        mkdirSync(deps.dataDir, { recursive: true });
        writeFileSync(configPath, JSON.stringify(merged, null, 2));
        chmodSync(configPath, 0o600);
        json(res, 200, { saved: true });
        return;
      }
    }

    if (method === "GET" && !path.startsWith("/api/")) {
      const root = join(process.cwd(), "ui-dist");
      const rel = path === "/" ? "index.html" : path.slice(1);
      const file = join(root, rel);
      const target = existsSync(file) && !rel.includes("..") ? file : join(root, "index.html");
      if (existsSync(target)) {
        const ext = target.split(".").pop() ?? "";
        const types: Record<string, string> = {
          html: "text/html; charset=utf-8",
          js: "text/javascript",
          css: "text/css",
          svg: "image/svg+xml",
          map: "application/json",
        };
        res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" });
        res.end(readFileSync(target));
        return;
      }
    }

    json(res, 404, { error: `未找到: ${method} ${path}` });
  }

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    port: typeof address === "object" && address ? address.port : 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
