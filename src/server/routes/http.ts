import type { ServerResponse } from "node:http";
import type { Adapters } from "../../adapters/types.js";
import type { FsLibraryStore } from "../../library/fsLibraryStore.js";
import type { FsProjectStore } from "../../stores/fsStore.js";
import type { RunRegistry } from "../runRegistry.js";

// P1-3 路由域共享件(D1):无反向依赖,保证 import 单向(routes/* → http.ts,server.ts → routes/*)。
// T2 迁入 json/PROJECT_ID;T5 迁入 Ctx(自 projectsRuns.ts)。

export const PROJECT_ID = /^p-[a-z0-9-]+$/;

export const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

/** D2:启动级单例 ctx,各域 handler 共享;storeFor 每调新开实例(语义与拆分前请求级 store() 闭包逐字相同)。 */
export interface Ctx {
  dataDir: string;
  makeAdapters: () => Adapters;
  library: FsLibraryStore;
  parsePdf: (bytes: Uint8Array) => Promise<{ bodyText: string; parseStatus: "ok" | "failed" }>;
  projectDir: (id: string) => string;
  /** = FsProjectStore.open(projectDir(id)):每调新开实例,语义与现状请求级 store() 闭包逐字相同 */
  storeFor: (id: string) => FsProjectStore;
  configPath: string;
  registry: RunRegistry;
}
