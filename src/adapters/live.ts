/* 采证三件套的网络/解析实现:搜索(HTTP)、抓页、文档解析。模型通道见 piRuntime.ts(P2-1 起
   本文件不再持有任何 Pi SDK 依赖,提示词与解析器在 modelText.ts)。 */
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { extractText } from "unpdf";
import type { PageFetcher, DocParser, SearchProvider } from "./types.js";

const FETCH_TIMEOUT_MS = 20_000;

export interface HttpSearchConfig {
  endpoint: string;
  headers?: Record<string, string>;
  queryField?: string;
  hitsPath?: string;
  urlField: string;
  titleField: string;
  snippetField: string;
}

const dig = (value: unknown, path?: string): unknown => {
  if (!path) return value;
  return path.split(".").reduce<unknown>((acc, key) => {
    if (typeof acc !== "object" || acc === null) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, value);
};

export function httpSearch(config: HttpSearchConfig): SearchProvider {
  return {
    search: async (query, _callKey) => {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...config.headers },
        body: JSON.stringify({ [config.queryField ?? "query"]: query }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`搜索服务 HTTP ${response.status}`);
      const json: unknown = await response.json();
      const hitsRaw = dig(json, config.hitsPath);
      if (!Array.isArray(hitsRaw)) return [];
      return hitsRaw
        .map((item) => {
          const rec = item as Record<string, unknown>;
          return {
            url: String(rec[config.urlField] ?? ""),
            title: String(rec[config.titleField] ?? ""),
            snippet: String(rec[config.snippetField] ?? ""),
          };
        })
        .filter((hit) => hit.url.startsWith("http"));
    },
  };
}

export function livePage(): PageFetcher {
  return {
    fetch: async (url, _callKey) => {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          headers: { "user-agent": "deep-research-spike/0.1 (+local single-user research tool)" },
        });
        const contentType = response.headers.get("content-type") ?? "";
        // 重定向后的最终地址一并回传,调用方据此复查 SSRF 边界(S-06)
        const finalUrl = response.url && response.url !== url ? response.url : undefined;
        if (!response.ok) {
          return { url, finalUrl, status: response.status, contentType, error: `HTTP ${response.status}` };
        }
        if (contentType.includes("pdf")) {
          return { url, finalUrl, status: 200, contentType, pdf: new Uint8Array(await response.arrayBuffer()) };
        }
        const body = await response.text();
        return contentType.includes("html")
          ? { url, finalUrl, status: 200, contentType, html: body }
          : { url, finalUrl, status: 200, contentType, text: body };
      } catch (error) {
        return { url, status: 0, contentType: "", error: String(error) };
      }
    },
  };
}

/** 清理候选标题:去空白折叠;过短或 JSON 碎片形态视为无效。 */
export function cleanPageTitle(raw: string | null | undefined): string | undefined {
  const t = (raw ?? "").replace(/\s+/g, " ").trim();
  if (t.length < 4 || t.length > 300) return undefined;
  if (/^[{\[]/.test(t)) return undefined; // JSON 形态碎片(如 {"link": ""})不是标题
  if (/\ufffd/.test(t)) return undefined; // 编码误码
  // 乱码守卫:GBK 等误码会产生大量超出 CJK/ASCII/常用标点的字符
  const garbage = [...t].filter((c) => {
    const cp = c.codePointAt(0) ?? 0;
    return (
      cp > 0x2fff &&
      !(cp >= 0x4e00 && cp <= 0x9fff) &&
      !(cp >= 0x3400 && cp <= 0x4dbf) &&
      !(cp >= 0x3000 && cp <= 0x303f) &&
      !(cp >= 0xff00 && cp <= 0xffef)
    );
  }).length;
  if (garbage / t.length > 0.3) return undefined;
  if (/^(document|untitled|无标题)$/i.test(t)) return undefined; // 占位标题
  return t;
}

export function liveParser(): DocParser {
  return {
    parse: async (page, _callKey) => {
      try {
        if (page.pdf) {
          const { text } = await extractText(page.pdf);
          const bodyText = Array.isArray(text) ? text.join("\n\n") : String(text);
          return { bodyText, parseStatus: bodyText.trim() ? "ok" : "failed" };
        }
        if (page.text != null) {
          return { bodyText: page.text, parseStatus: "ok" };
        }
        if (!page.html) {
          return { bodyText: "", parseStatus: "failed" };
        }
        const { document } = parseHTML(page.html);
        // 标题在 Readability 消费 document 前取:og:title(站方摘要)> <title> 标签;Readability 自己的推导作补充
        const ogTitle = cleanPageTitle(document.querySelector('meta[property="og:title"]')?.getAttribute("content"));
        const tagTitle = cleanPageTitle(document.querySelector("title")?.textContent);
        const article = new Readability(document).parse();
        const bodyText = article?.textContent ?? document.body?.textContent ?? "";
        const title = cleanPageTitle(article?.title) ?? ogTitle ?? tagTitle;
        return { bodyText, parseStatus: bodyText.trim() ? "ok" : "failed", title };
      } catch {
        return { bodyText: "", parseStatus: "failed" };
      }
    },
  };
}
