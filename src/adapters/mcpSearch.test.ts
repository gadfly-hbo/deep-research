import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mcpWebSearch } from "./mcpSearch.js";

const fixture = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../scripts/fixtures/fake-mcp-search.mjs",
);

describe("mcpWebSearch(MiniMax MCP web_search,stdio JSON-RPC)", () => {
  it("经 MCP 协议拿到结构化搜索结果", async () => {
    const search = mcpWebSearch({
      command: process.execPath,
      args: [fixture],
      env: {},
      timeoutMs: 10_000,
    });
    try {
      const hits = await search.search("中国咖啡市场规模 2025", "t:0");
      expect(hits).toHaveLength(2);
      expect(hits[0]).toEqual({
        url: "https://a.example/report",
        title: "中国咖啡市场规模报告",
        snippet: "中国咖啡市场规模约 1,200 亿元(2025 年)。",
      });
    } finally {
      await search.close();
    }
  }, 15_000);

  it("web_search 返回工具失败文本(如配额)→ 抛出而非伪装无来源", async () => {
    const search = mcpWebSearch({ command: process.execPath, args: [fixture], env: {}, timeoutMs: 10_000 });
    try {
      await expect(search.search("quota 测试", "t:1")).rejects.toThrow(/web_search 失败/);
    } finally {
      await search.close();
    }
  }, 15_000);

  it("MCP 进程启动失败 → 明确报错(不静默降级)", async () => {
    const search = mcpWebSearch({ command: "/nonexistent/binary", args: [], env: {}, timeoutMs: 5_000 });
    await expect(search.search("q", "t:0")).rejects.toThrow(/mcp|spawn|启动/i);
  }, 10_000);
});
