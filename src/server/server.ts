import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { Adapters } from "../adapters/types.js";
import { buildExportFilesV2, zipExport } from "../app/exportBundle.js";
import { createProject, generateFormal, publishBundle, runOnProject } from "../app/projectService.js";
import {
  ResearchRequestSchema,
  InterventionSchema,
  RunInstructionSchema,
  type Intervention,
  type ResearchRequest,
} from "../contracts.js";
import { DEFAULT_BUDGET } from "../core/runResearch.js";
import { OutlineOutputSchema, PlanOutputSchema, type PlanOutput } from "../core/stages.js";
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

const IncrementalRefSchema = z.object({ runId: z.string().min(1), requestId: z.string().min(1) });

/** 2.1 追问扩展:解析并校验增量基准——本项目内已完成(published/limited)的 run 及其成果包。 */
const resolveIncrementalBase = async (
  store: FsProjectStore,
  raw: unknown,
): Promise<
  | { error: string; status: number }
  | {
      base: {
        runId: string;
        summary: Record<string, unknown>;
        answeredQuestions: string[];
        outline: unknown;
      };
    }
> => {
  const ref = IncrementalRefSchema.safeParse(raw);
  if (!ref.success) return { status: 400, error: "incrementalOf 需含 runId 与 requestId" };
  const run = (await store.listRuns()).find((r) => r.id === ref.data.runId && r.requestId === ref.data.requestId);
  if (!run) return { status: 404, error: `基准 run 不属于本项目: ${ref.data.runId}` };
  if (run.status !== "published" && run.status !== "limited") {
    return {
      status: 409,
      error: `基准 run 未完成(${run.status});只有已完成(published/limited)的运行可作为增量基准`,
    };
  }
  const bundle = await store.readBundle(ref.data.runId);
  if (!bundle) return { status: 404, error: `基准成果包缺失: ${ref.data.runId}` };
  const cps = await store.checkpoints(ref.data.runId);
  const gatherCp = cps.find((c) => c.stage === "gather");
  const planCp = cps.find((c) => c.stage === "plan");
  const questions =
    (gatherCp?.data as { questions?: Array<{ question: string; status: string }> } | undefined)?.questions ??
    (planCp?.data as { questions?: Array<{ question: string; status: string }> } | undefined)?.questions ??
    [];
  const answeredQuestions = questions
    .filter((q) => q.status === "answered" || q.status === "partially")
    .map((q) => q.question);
  const lastFetchedAt = bundle.snapshots.reduce((m, s) => (s.fetchedAt > m ? s.fetchedAt : m), "");
  return {
    base: {
      runId: ref.data.runId,
      summary: {
        runId: ref.data.runId,
        answeredQuestions: answeredQuestions.length,
        evidence: bundle.evidence.length,
        snapshots: bundle.snapshots.length,
        claims: bundle.claims.length,
        lastFetchedAt,
      },
      answeredQuestions,
      outline: bundle.outline ?? null,
    },
  };
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
  // 2.1 执行中干预:per-run 待消费指令队列(内存 + pending-instructions.json 落盘)
  const instructionQueues = new Map<string, Intervention[]>();
  const configPath = join(deps.dataDir, "config.json");

  const getQueue = (runId: string): Intervention[] => {
    let q = instructionQueues.get(runId);
    if (!q) {
      q = [];
      instructionQueues.set(runId, q);
    }
    return q;
  };
  const drainFor =
    (runId: string, dir: string): (() => Promise<Intervention[]>) =>
    async () => {
      const q = instructionQueues.get(runId);
      if (!q || q.length === 0) return [];
      const drained = q.splice(0);
      await FsProjectStore.open(dir).savePendingInstructions(runId, []);
      return drained;
    };

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
        // 2.1 增量追问:基准必须是本项目已完成的 run,预览只为新问题生成计划
        let base: { runId: string; summary: Record<string, unknown>; answeredQuestions: string[] } | undefined;
        if (body.incrementalOf !== undefined) {
          const resolved = await resolveIncrementalBase(store(), body.incrementalOf);
          if ("error" in resolved) {
            json(res, resolved.status, { error: resolved.error });
            return;
          }
          base = resolved.base;
        }
        const result = await deps
          .makeAdapters()
          .model.runStage(
            "plan",
            {
              goal: body.goal,
              scope: body.scope,
              questionFramework: cfg.questionFramework,
              ...(base
                ? {
                    incremental: {
                      answeredQuestions: base.answeredQuestions,
                      newQuestionBudget: 6,
                      note: "只为追问生成新问题,不重复基准研究已回答的问题",
                    },
                  }
                : {}),
            },
            `plan-preview:${id}:${Date.now()}`,
          );
        const plan = PlanOutputSchema.parse(result.output);
        if (base && plan.questions.length > 6) plan.questions = plan.questions.slice(0, 6);
        json(res, 200, { plan, cost: result.cost, ...(base ? { base: base.summary } : {}) });
        return;
      }

      if (method === "POST" && rest === "/outline-preview") {
        const cfg = getModuleConfig(body.module ?? store().meta().module);
        let base: { runId: string; summary: Record<string, unknown>; answeredQuestions: string[]; outline: unknown } | undefined;
        if (body.incrementalOf !== undefined) {
          const resolved = await resolveIncrementalBase(store(), body.incrementalOf);
          if ("error" in resolved) {
            json(res, resolved.status, { error: resolved.error });
            return;
          }
          base = resolved.base;
        }
        const result = await deps
          .makeAdapters()
          .model.runStage(
            "outline",
            {
              goal: body.goal,
              scope: body.scope,
              questions: Array.isArray(body.questions) ? body.questions : [],
              reportTemplate: cfg.reportTemplate,
              ...(base
                ? {
                    incremental: {
                      baseOutline: base.outline ?? null,
                      answeredQuestions: base.answeredQuestions,
                      note: "基于基准研究框架生成增量框架:保留原有章节,标注新问题章节的插入位置",
                    },
                  }
                : {}),
            },
            `outline-preview:${id}:${Date.now()}`,
          );
        json(res, 200, { outline: OutlineOutputSchema.parse(result.output), cost: result.cost, ...(base ? { base: base.summary } : {}) });
        return;
      }

      // 运行启动核心:落 running 记录并挂载后台流水线;/runs 与 /runs/rerun 共用
      const launchRun = async (
        request: ResearchRequest,
        plan: PlanOutput | undefined,
        selectedAssets?: unknown,
      ): Promise<{
        runId: string;
        requestId: string;
        reuse: { bound: number; rejected: Array<{ sourceId: string; reason: string }> };
      }> => {
        const controller = new AbortController();
        controllers.set(request.id ?? "", controller);
        const runId = randomUUID();
        // 2.0 复用选择(§5.2):启动前服务端检查并固定版本绑定;越权项拒绝并回报
        let bindReport: { bound: number; rejected: Array<{ sourceId: string; reason: string }> } = {
          bound: 0,
          rejected: [],
        };
        if (Array.isArray(selectedAssets) && selectedAssets.length > 0) {
          const outcome = await bindAssets(library, {
            runId,
            projectId: id,
            idempotencyKey: `select-${runId}`,
            bindings: (selectedAssets as Array<Record<string, unknown>>).map((a) => ({
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
          plan,
          signal: controller.signal,
          runId,
          library,
          projectId: id,
          pollInstructions: drainFor(runId, dir),
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
        return { runId, requestId: request.id ?? "", reuse: bindReport };
      };

      if (method === "POST" && rest === "/runs") {
        const request = ResearchRequestSchema.parse(body.request);
        // 2.1:增量基准与预览端点同一校验——本项目已完成的 run 才可作为基准
        if (request.incrementalOf) {
          const resolved = await resolveIncrementalBase(store(), request.incrementalOf);
          if ("error" in resolved) {
            json(res, resolved.status, { error: resolved.error });
            return;
          }
        }
        const started = await launchRun(request, body.plan, body.selectedAssets);
        json(res, 200, { started: true, requestId: started.requestId, reuse: started.reuse });
        return;
      }

      // 重跑:读原研究请求,换预算档位与全新请求 ID;沿用原已确认问题清单,不重新规划
      if (method === "POST" && rest === "/runs/rerun") {
        const original = await store().readRequest(String(body.requestId ?? ""));
        if (!original) {
          json(res, 404, { error: `原始请求不存在(${String(body.requestId ?? "")}),无法重跑` });
          return;
        }
        const priorRun = await store().findRunByRequestId(String(body.requestId ?? ""));
        if (priorRun?.status === "running") {
          json(res, 409, { error: "该请求的运行仍在进行中,结束后才能重跑" });
          return;
        }
        const tier = z.enum(["low", "medium", "high"]).default("medium").parse(body.budgetTier);
        const request = ResearchRequestSchema.parse({
          ...original,
          id: `req-${Date.now().toString(36)}`,
          budgetTier: tier,
          budget: undefined,
        });
        if (request.incrementalOf) {
          const resolved = await resolveIncrementalBase(store(), request.incrementalOf);
          if ("error" in resolved) {
            json(res, resolved.status, { error: resolved.error });
            return;
          }
        }
        const plan: PlanOutput = {
          questions: request.scope.queries.map((q, i) => ({ id: `q${i + 1}`, question: q, status: "open" })),
        };
        const started = await launchRun(request, plan);
        json(res, 200, { started: true, requestId: started.requestId, reuse: started.reuse });
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

      if (method === "POST" && rest === "/runs/instruct") {
        // 2.1 执行中干预:入队并在采证问题间隙被消费;队列随 run 目录落盘
        const run = await store().findRunByRequestId(String(body.requestId ?? ""));
        if (!run || run.status !== "running") {
          json(res, 409, { error: `没有正在运行的 run: ${body.requestId}` });
          return;
        }
        const parsed = RunInstructionSchema.safeParse(body.instruction);
        if (!parsed.success) {
          json(res, 400, { error: "干预指令不合法", issues: parsed.error.issues.map((i) => i.message) });
          return;
        }
        const queue = getQueue(run.id);
        if (queue.length >= 20) {
          json(res, 409, { error: "指令队列已满(20),请等待当前问题完成" });
          return;
        }
        const record: Intervention = {
          id: `ins:${randomUUID().slice(0, 8)}`,
          submittedAt: new Date().toISOString(),
          instruction: parsed.data,
        };
        queue.push(record);
        await store().savePendingInstructions(run.id, queue);
        json(res, 200, {
          queued: true,
          instructionId: record.id,
          pending: queue.length,
          note: "已入队,将在当前问题完成后生效",
        });
        return;
      }

      if (method === "POST" && rest === "/runs/resume") {
        const request = await store().readRequest(body.requestId);
        if (!request) {
          json(res, 404, { error: `找不到请求: ${body.requestId}` });
          return;
        }
        // 恢复必须命中已取消的原 run:不预落新记录(会与 findRunByRequestId 竞争导致静默全量重跑),
        // 沿用原 runId,由编排器在恢复瞬间把原记录置回 running(启动即可见)
        const prior = request.id ? await store().findRunByRequestId(request.id) : undefined;
        if (!prior || prior.status !== "cancelled") {
          json(res, 409, { error: `没有可恢复的已取消运行: ${body.requestId}` });
          return;
        }
        const controller = new AbortController();
        controllers.set(request.id ?? "", controller);
        // 恢复未消费的干预指令(取消/中断前入队的继续有效)
        for (const raw of await store().readPendingInstructions(prior.id)) {
          const check = InterventionSchema.safeParse(raw);
          if (check.success) getQueue(prior.id).push(check.data);
        }
        void runOnProject(dir, request, deps.makeAdapters(), {
          plan: body.plan,
          signal: controller.signal,
          library,
          projectId: id,
          pollInstructions: drainFor(prior.id, dir),
        })
          .catch(async (error) => {
            // 失败不冒充完成:更新原 run 记录为 failed,带错误信息
            const current = request.id ? await store().findRunByRequestId(request.id) : undefined;
            if (current) {
              await FsProjectStore.open(dir).saveRun({
                ...current,
                status: "failed",
                error: String(error instanceof Error ? error.message : error),
              });
            }
          })
          .finally(() => {
            controllers.delete(request.id ?? "");
          });
        json(res, 200, { resumed: true, requestId: request.id, runId: prior.id });
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
