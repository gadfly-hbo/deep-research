import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Adapters } from "../adapters/types.js";
import { DEFAULT_BUDGET } from "../core/runResearch.js";
import { FsProjectStore } from "../stores/fsStore.js";
import { FsLibraryStore } from "../library/fsLibraryStore.js";
import { RunRegistry } from "./runRegistry.js";
import { json, PROJECT_ID } from "./routes/http.js";
import { handleProjectsRoutes, type Ctx } from "./routes/projectsRuns.js";
import { handleLibraryRoutes } from "./routes/library.js";

export interface ServerDeps {
  dataDir: string;
  makeAdapters: () => Adapters;
}

export interface RunningServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

const KEYISH = /key|token|secret|password/i;

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
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
  // 运行态收敛到纯内存 Registry(P1-3 D3):AbortController 按 requestId、干预指令队列按 run.id;
  // 2.1 执行中干预的双写编排(内存 + pending-instructions.json 落盘)仍由本层完成
  const registry = new RunRegistry();
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

  const storeFor = (id: string): FsProjectStore => FsProjectStore.open(projectDir(id));
  // D2:启动级单例 ctx,各域 handler 共享(T2 起 projectsRuns 域先行消费)
  const ctx: Ctx = {
    dataDir: deps.dataDir,
    makeAdapters: deps.makeAdapters,
    library,
    parsePdf,
    projectDir,
    storeFor,
    configPath,
    registry,
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

    // projectsRuns 域(T2 拆至 routes/projectsRuns.ts):/api/projects 列表/创建与 :id 子树;
    // versions/snapshots 子树由该域在验 id 后委托 routes/versions.ts(T3,R2-1),不再进入本文件。
    // 匹配顺序保留现状:该域最先匹配,id 校验先于子路由分发;未知 rest 返回 false 落到后续域。
    if (await handleProjectsRoutes(ctx, req, res, url, body)) return;

    // library 域(T4 拆至 routes/library.ts):15 个情报库匹配块 + /api/migrate,regex 顺序逐位保留。
    if (await handleLibraryRoutes(ctx, req, res, url, body)) return;

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
