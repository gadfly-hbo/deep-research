import { describe, expect, it } from "vitest";
import { searchWithFallback } from "./searchFailover.js";
import { xiaomiWebSearch } from "./xiaomiSearch.js";
import type { SearchProvider } from "./types.js";

const cannedResponse = {
  choices: [
    {
      message: {
        role: "assistant",
        content: "",
        annotations: [
          {
            type: "url_citation",
            url: "https://www.docin.com/p-4918311399.html",
            title: "2025至2030中国咖啡行业市场发展分析",
            summary: "预计到2025年,中国咖啡消费市场规 …",
            site_name: "豆丁网",
          },
          {
            type: "url_citation",
            url: "https://wenku.baidu.com/view/abc.html",
            title: "2025年中国咖啡细分市场分析",
            summary: "按产品形态和消费场景,中国咖啡市场可细分为…",
          },
        ],
      },
    },
  ],
};

describe("xiaomiWebSearch(MIMO token plan 服务端 web_search)", () => {
  it("annotations url_citation 映射为结构化命中", async () => {
    const fetcher = async () =>
      new Response(JSON.stringify(cannedResponse), { status: 200 });
    const search = xiaomiWebSearch({ apiKey: "k", model: "mimo-v2.5-pro" }, fetcher as typeof fetch);
    const hits = await search.search("中国咖啡市场规模", "t:0");
    expect(hits).toEqual([
      { url: "https://www.docin.com/p-4918311399.html", title: "2025至2030中国咖啡行业市场发展分析", snippet: "预计到2025年,中国咖啡消费市场规 …" },
      { url: "https://wenku.baidu.com/view/abc.html", title: "2025年中国咖啡细分市场分析", snippet: "按产品形态和消费场景,中国咖啡市场可细分为…" },
    ]);
  });

  it("HTTP 错误显式抛出(含配额)", async () => {
    const fetcher = async () => new Response("402 quota", { status: 402 });
    const search = xiaomiWebSearch({ apiKey: "k" }, fetcher as typeof fetch);
    await expect(search.search("q", "t:0")).rejects.toThrow(/402/);
  });
});

describe("searchWithFallback(搜索主备:minimax 主,xiaomi 备)", () => {
  const hit = { url: "https://x/1", title: "t", snippet: "s" };
  it("主用失败(配额/限流)自动切备用", async () => {
    const calls: string[] = [];
    const primary: SearchProvider = {
      search: async () => {
        calls.push("primary");
        throw new Error("MiniMax web_search 失败: API Error: 2067 用量上限");
      },
    };
    const backup: SearchProvider = {
      search: async () => {
        calls.push("backup");
        return [hit];
      },
    };
    const search = searchWithFallback([primary, backup]);
    expect(await search.search("q", "t:0")).toEqual([hit]);
    expect(calls).toEqual(["primary", "backup"]);
  });

  it("非配额类错误不触发备用(配置错误不掩盖)", async () => {
    const primary: SearchProvider = {
      search: async () => {
        throw new Error("MCP 搜索服务启动失败: spawn uvx ENOENT");
      },
    };
    const backup: SearchProvider = { search: async () => [hit] };
    await expect(searchWithFallback([primary, backup]).search("q", "t:0")).rejects.toThrow(/ENOENT/);
  });
});
