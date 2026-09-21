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

/** 从 web_search 结果文本提取命中:优先按 JSON 数组解析,否则退化到 URL 逐行提取。 */
export function parseSearchResults(text: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const push = (url: string, title: string, snippet: string) => {
    if (!url.startsWith("http")) return;
    if (hits.some((h) => h.url === url)) return;
    hits.push({ url, title, snippet });
  };
  try {
    const parsed: unknown = JSON.parse(text);
    const arr = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null
        ? ((parsed as Record<string, unknown>).results ?? (parsed as Record<string, unknown>).data ?? [])
        : [];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item !== "object" || item === null) continue;
        const rec = item as Record<string, unknown>;
        push(
          String(rec.url ?? rec.link ?? ""),
          String(rec.title ?? rec.name ?? ""),
          String(rec.snippet ?? rec.content ?? rec.description ?? ""),
        );
      }
    }
  } catch {
    // 非 JSON:按行提取 URL
  }
  if (hits.length === 0) {
    for (const line of text.split("\n")) {
      const m = line.match(/https?:\/\/[^\s)\]>"']+/);
      if (m) push(m[0], line.replace(m[0], "").trim().slice(0, 120), "");
    }
  }
  return hits;
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
