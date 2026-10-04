import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mcpWebSearch, parseSearchResults } from "./mcpSearch.js";

const fixture = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../scripts/fixtures/fake-mcp-search.mjs",
);

describe("mcpWebSearch(MiniMax MCP web_search,stdio JSON-RPC)", () => {  it("经 MCP 协议拿到结构化搜索结果", async () => {
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

describe("parseSearchResults(结果文本解析)", () => {
  it("MiniMax organic 包装键(2026-10-04 实测格式):整段解析出真实标题", () => {
    const text = JSON.stringify(
      { organic: [{ title: "真实标题", link: "https://a.example/1", snippet: "摘要", date: "2026/09/01" }], base_resp: {} },
      null,
      2,
    );
    expect(parseSearchResults(text)).toEqual([
      { url: "https://a.example/1", title: "真实标题", snippet: "摘要" },
    ]);
  });

  it("results/data 包装键保持兼容", () => {
    expect(parseSearchResults(JSON.stringify({ results: [{ url: "https://a.example/2", title: "T" }] }))[0].title).toBe("T");
    expect(parseSearchResults(JSON.stringify({ data: [{ link: "https://a.example/3", name: "N" }] }))[0].title).toBe("N");
  });

  it("整段 JSON 被前缀污染:顶层对象块扫描仍取到记录", () => {
    const good = JSON.stringify({ organic: [{ title: "块扫描命中", link: "https://a.example/4", snippet: "" }] }, null, 2);
    const hits = parseSearchResults("data: " + good);
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("块扫描命中");
  });

  it("纯文本按行兜底:JSON 碎片行不作标题(置空,展示回退用 URL)", () => {
    const hits = parseSearchResults('  "link": "https://a.example/5",\n');
    expect(hits).toHaveLength(1);
    expect(hits[0].url).toBe("https://a.example/5");
    expect(hits[0].title).toBe("");
  });
});
