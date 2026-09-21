import type { SearchHit, SearchProvider } from "./types.js";

export interface XiaomiSearchConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

interface UrlCitation {
  type: string;
  url?: string;
  title?: string;
  summary?: string;
}

/** Xiaomi MIMO token plan 的服务端联网检索:tools=[{type:"web_search"}],结果在 message.annotations 的 url_citation 里。 */
export function xiaomiWebSearch(
  cfg: XiaomiSearchConfig,
  fetcher: typeof fetch = fetch,
): SearchProvider {
  const baseUrl = cfg.baseUrl ?? "https://token-plan-cn.xiaomimimo.com/v1";
  const model = cfg.model ?? "mimo-v2.5-pro";
  return {
    search: async (query, _callKey) => {
      const response = await fetcher(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: `搜索:${query}` }],
          tools: [{ type: "web_search" }],
          max_tokens: 2048,
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 240_000),
      });
      if (!response.ok) {
        throw new Error(`xiaomi web_search HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }
      const json = (await response.json()) as {
        choices?: { message?: { annotations?: UrlCitation[] } }[];
      };
      const annotations = json.choices?.[0]?.message?.annotations ?? [];
      const hits: SearchHit[] = [];
      for (const a of annotations) {
        if (a.type !== "url_citation" || !a.url) continue;
        if (hits.some((h) => h.url === a.url)) continue;
        hits.push({ url: a.url, title: a.title ?? "", snippet: a.summary ?? "" });
      }
      return hits;
    },
  };
}
