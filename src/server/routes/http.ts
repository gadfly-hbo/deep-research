import type { ServerResponse } from "node:http";

// P1-3 路由域共享件(D1):无反向依赖,保证 import 单向(routes/* → http.ts,server.ts → routes/*)。
// T2 先迁 json/PROJECT_ID;Ctx 暂定义于 projectsRuns.ts,T5 统一迁入本文件。

export const PROJECT_ID = /^p-[a-z0-9-]+$/;

export const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
