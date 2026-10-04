import { spawn, type ChildProcess } from "node:child_process";
import type { SearchHit, SearchProvider } from "./types.js";

export interface McpSearchConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface McpSearchProvider extends SearchProvider {
  close(): Promise<void>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

/** 从 web_search 结果文本提取命中:JSON 整段解析(已知/未知包装键)→ 顶层对象块扫描 → URL 逐行兜底。 */
export function parseSearchResults(text: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const push = (url: string, title: string, snippet: string) => {
    if (!url.startsWith("http")) return;
    if (hits.some((h) => h.url === url)) return;
    hits.push({ url, title, snippet });
  };
  for (const rec of extractRecords(text)) {
    push(
      String(rec.url ?? rec.link ?? ""),
      String(rec.title ?? rec.name ?? "").trim(),
      String(rec.snippet ?? rec.content ?? rec.description ?? ""),
    );
  }
  if (hits.length === 0) {
    // 兜底:按行提取 URL;剔除 URL 后只剩 JSON 碎片(如 `"link": "",`)的行不当标题,置空回退用 URL
    for (const line of text.split("\n")) {
      const m = line.match(/https?:\/\/[^\s)\]>"']+/);
      if (!m) continue;
      const rest = line.replace(m[0], "").trim().slice(0, 120);
      push(m[0], /^[\s"{}[\],:]+$/.test(rest) || rest.includes('":') ? "" : rest, "");
    }
  }
  return hits;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && ("url" in (x as object) || "link" in (x as object));

/** 从解析出的 JSON 里取搜索记录数组:已知包装键优先,否则扫任意"对象数组"字段(MiniMax 用 organic)。 */
function recordsFrom(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (parsed === null || typeof parsed !== "object") return [];
  const o = parsed as Record<string, unknown>;
  for (const key of ["results", "data", "organic"]) {
    if (Array.isArray(o[key])) {
      const recs = (o[key] as unknown[]).filter(isRecord);
      if (recs.length > 0) return recs;
    }
  }
  for (const v of Object.values(o)) {
    if (Array.isArray(v)) {
      const recs = (v as unknown[]).filter(isRecord);
      if (recs.length > 0) return recs;
    }
  }
  return [];
}

/** 整段 JSON 被日志前缀/截断污染时:括号配平扫描顶层 {...} 块逐个解析(字符串感知)。 */
function topLevelJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        blocks.push(text.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return blocks;
}

function extractRecords(text: string): Record<string, unknown>[] {
  try {
    return recordsFrom(JSON.parse(text));
  } catch {
    const out: Record<string, unknown>[] = [];
    for (const block of topLevelJsonBlocks(text)) {
      try {
        out.push(...recordsFrom(JSON.parse(block)));
      } catch {
        /* 单块解析失败忽略,继续下一块 */
      }
    }
    return out;
  }
}

export function mcpWebSearch(cfg: McpSearchConfig): McpSearchProvider {
  let child: ChildProcess | null = null;
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  let startError: Error | null = null;

  const onData = (chunk: Buffer) => {
    // MCP stdio 传输:换行分隔的 JSON(NDJSON),无 Content-Length 帧
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const nl = buffer.indexOf(0x0a);
      if (nl < 0) return;
      const line = buffer.subarray(0, nl).toString("utf8").trim();
      buffer = buffer.subarray(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        const entry = pending.get(msg.id);
        if (entry) {
          pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(`MCP 错误 ${msg.error.code}: ${msg.error.message}`));
          else entry.resolve(msg);
        }
      } catch {
        // 忽略非 JSON 行(如服务器日志)
      }
    }
  };

  const sendFrame = (proc: ChildProcess, obj: unknown) => {
    proc.stdin!.write(JSON.stringify(obj) + "\n");
  };

  const ensureStarted = async (): Promise<void> => {
    if (child) return;
    if (startError) throw startError;
    await new Promise<void>((resolve, reject) => {
      const spawned = spawn(cfg.command, cfg.args, {
        env: { ...process.env, ...cfg.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      spawned.on("error", (e) => {
        startError = new Error(`MCP 搜索服务启动失败(${cfg.command}): ${e.message}`);
        reject(startError);
      });
      let handshakeDone = false;
      spawned.stdout?.on("data", onData);
      spawned.on("exit", (code) => {
        const err = new Error(`MCP 搜索进程退出 code=${code}`);
        for (const entry of pending.values()) entry.reject(err);
        pending.clear();
        child = null;
        if (!handshakeDone) {
          startError = err;
          reject(err);
        }
      });
      child = spawned;
      // initialize 握手
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error("MCP initialize 超时")), cfg.timeoutMs ?? 20_000);
      pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          handshakeDone = true;
          sendFrame(spawned, { jsonrpc: "2.0", method: "notifications/initialized" });
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      const init = {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "deep-research", version: "0.1.0" } },
      };
      sendFrame(spawned, init);
    });
  };

  const call = async (method: string, params: unknown): Promise<unknown> => {
    await ensureStarted();
    if (!child?.stdin) throw new Error("MCP 搜索进程不可用");
    const id = nextId++;
    const timeoutMs = cfg.timeoutMs ?? 20_000;
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP 调用超时(${method})`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      sendFrame(child!, { jsonrpc: "2.0", id, method, params });
    });
    return response.result;
  };

  return {
    search: async (query, _callKey) => {
      const result = (await call("tools/call", { name: "web_search", arguments: { query } })) as {
        content?: { type: string; text?: string }[];
      };
      const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
      // MiniMax MCP 把 API 失败(如配额 2067)返回为文本而不是 MCP error;工具失败必须显式抛出,不伪装成"无来源"
      if (/Failed to perform search|API Error/i.test(text)) {
        throw new Error(`MiniMax web_search 失败: ${text.slice(0, 200)}`);
      }
      return parseSearchResults(text);
    },
    close: async () => {
      if (child) {
        // uvx 是启动器,真正的 python 服务器是孙进程;销毁管道并 SIGKILL,避免孙进程持管导致主进程挂住
        try {
          child.stdin?.destroy();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.kill("SIGKILL");
        } catch {
          // 已退出则忽略
        }
        child = null;
      }
    },
  };
}
