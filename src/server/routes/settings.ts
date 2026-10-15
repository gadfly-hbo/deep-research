import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DEFAULT_BUDGET } from "../../core/runResearch.js";
import { json } from "./http.js";
import type { Ctx } from "./http.js";

// P1-3 T5:settings 域(附录 A 第 34–35 项)。stripKeys/KEYISH 自 server.ts 迁入(R2-5);
// 合并语义、模型链首替换、chmod 0600 逐位保留;其余方法 fall-through 落 catch-all 404。

const KEYISH = /key|token|secret|password/i;

const stripKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(([k]) => !KEYISH.test(k)),
    );
  }
  return value;
};

/** 返回 true=已处理;false=落到后续域(静态文件、catch-all)。 */
export const handleSettingsRoutes = async (
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: any,
): Promise<boolean> => {
  if (url.pathname !== "/api/settings") return false;
  const method = req.method ?? "GET";
  const configPath = ctx.configPath;

  if (method === "GET") {
    const raw = existsSync(configPath)
      ? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>)
      : {};
    json(res, 200, { config: stripKeys(raw), budgetDefaults: DEFAULT_BUDGET });
    return true;
  }
  if (method === "POST") {
    for (const key of Object.keys(body)) {
      if (KEYISH.test(key)) {
        json(res, 400, { error: `密钥不通过 API 写入(字段 ${key});请用环境变量或自行编辑 config.json` });
        return true;
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
    mkdirSync(ctx.dataDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify(merged, null, 2));
    chmodSync(configPath, 0o600);
    json(res, 200, { saved: true });
    return true;
  }
  return false;
};
