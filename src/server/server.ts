import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Adapters } from "../adapters/types.js";
import { buildExportFiles, zipExport } from "../app/exportBundle.js";
import { createProject, publishBundle, runOnProject } from "../app/projectService.js";
import { ResearchRequestSchema } from "../contracts.js";
import { DEFAULT_BUDGET } from "../core/runResearch.js";
import { PlanOutputSchema } from "../core/stages.js";
import { getModuleConfig } from "../modules/registry.js";
import { FsProjectStore } from "../stores/fsStore.js";
import { defaultDataDir } from "../app/dataDir.js";
import { dataSync } from "../app/dataSync.js";

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
    const body = method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};

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

      if (method === "POST" && rest === "/runs") {
        const request = ResearchRequestSchema.parse(body.request);
        const controller = new AbortController();
        controllers.set(request.id ?? "", controller);
        const runId = randomUUID();
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
            // 数据寄居仓库内时,run 结束即同步到远端(双机共享);失败只提示不阻断
            if (deps.dataDir === defaultDataDir()) {
              void Promise.resolve(dataSync()).then((r) => {
                if (!r.ok) console.error(`[data-sync] ${r.action}: ${r.detail}`);
              });
            }
          });
        json(res, 200, { started: true, requestId: request.id });
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
            if (deps.dataDir === defaultDataDir()) {
              void Promise.resolve(dataSync()).then((r) => {
                if (!r.ok) console.error(`[data-sync] ${r.action}: ${r.detail}`);
              });
            }
          });
        json(res, 200, { resumed: true, requestId: request.id });
        return;
      }

      if (method === "POST" && rest === "/publish") {
        json(res, 200, await publishBundle(dir, body.runId));
        return;
      }

      const versionMatch = rest.match(/^\/versions\/(\d+)\/(bundle|export)$/);
      if (method === "GET" && versionMatch) {
        const [, v, kind] = versionMatch;
        const bundlePath = join(dir, "reports", `v${v}`, "bundle.json");
        if (!existsSync(bundlePath)) {
          json(res, 404, { error: `版本不存在: v${v}` });
          return;
        }
        const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
        if (kind === "bundle") {
          json(res, 200, bundle);
          return;
        }
        const files = buildExportFiles(bundle);
        const zipped = zipExport(files);
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="research-v${v}.zip"`,
        });
        res.end(Buffer.from(zipped));
        return;
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
        mkdirSync(deps.dataDir, { recursive: true });
        writeFileSync(configPath, JSON.stringify(body, null, 2));
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
