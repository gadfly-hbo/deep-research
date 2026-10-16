import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { Adapters } from "../adapters/types.js";
import { FsProjectStore } from "../stores/fsStore.js";
import { FsLibraryStore } from "../library/fsLibraryStore.js";
import { RunRegistry } from "./runRegistry.js";
import { json, PROJECT_ID, type Ctx } from "./routes/http.js";
import { handleProjectsRoutes } from "./routes/projectsRuns.js";
import { handleLibraryRoutes } from "./routes/library.js";
import { handleSettingsRoutes } from "./routes/settings.js";
import { resolveSessionCandidates, writeSessionDigest, createProjectSessionRuntime } from "./sessionRuntime.js";
import type { ModelConfig, ModelTransport } from "pi-agent-runtime";

export interface ServerDeps {
  dataDir: string;
  makeAdapters: () => Adapters;
  /** P2-5:会话候选链(config.model 解析;缺省无会话记忆,CLI 传)。 */
  sessionCandidates?: Array<{ model: ModelConfig; transport: ModelTransport }>;
}

export interface RunningServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
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
  // P2-5:会话研究记忆装配(候选链由 cli.ts 装配注入 deps.sessionCandidates;缺省不挂=降级零纪要)
  const ctx: Ctx = {
    dataDir: deps.dataDir,
    makeAdapters: deps.makeAdapters,
    library,
    parsePdf,
    projectDir,
    storeFor,
    configPath,
    registry,
    ...(deps.sessionCandidates
      ? {
          sessionRuntime: (id: string, dir: string) =>
            createProjectSessionRuntime({ projectDir: dir, candidates: deps.sessionCandidates!, auditPath: join(deps.dataDir, "model-audit.jsonl") }),
          onRunComplete: (dir: string) => (result) => {
            const rt = createProjectSessionRuntime({ projectDir: dir, candidates: deps.sessionCandidates!, auditPath: join(deps.dataDir, "model-audit.jsonl") });
            void writeSessionDigest(rt, result.run, result.bundle).catch((e) => {
              if (process.env.DR_DEBUG) console.error(`[session] 摘要写入失败: ${e instanceof Error ? e.message : e}`);
            });
          },
        }
      : {}),
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

    // settings 域(T5 拆至 routes/settings.ts):GET/POST /api/settings,其余方法落 catch-all。
    if (await handleSettingsRoutes(ctx, req, res, url, body)) return;

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
