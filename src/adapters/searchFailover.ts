import type { SearchProvider } from "./types.js";

/** 搜索主备:配额/限流/缺密钥类失败切下一个,其余错误直接抛出。 */

/**
 * 供应商瞬时故障判定(配额/限流/中止/超时/连接/5xx)——搜索主备链沿用;
 * 模型链的同类判定已由 pi-agent-runtime fallbacks 接管(P2-1,熔断按用户决策退役)。
 */
const TRANSIENT = /429|402|rate.?limit|quota|用量上限|2067|insufficient|额度|缺少模型密钥|No API key|aborted|timeout|timed? ?out|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|network|HTTP 5\d\d|服务暂时|overloaded/i;

export function isTransientProviderError(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error);
  return TRANSIENT.test(text);
}

export function searchWithFallback(chain: SearchProvider[]): SearchProvider & { close: () => Promise<void> } {
  return {
    search: async (query, callKey) => {
      let lastError: unknown;
      for (const provider of chain) {
        try {
          return await provider.search(query, callKey);
        } catch (error) {
          if (!isTransientProviderError(error)) throw error;
          lastError = error;
        }
      }
      throw new Error(`全部搜索渠道不可用(配额/限流);最后错误: ${String(lastError instanceof Error ? lastError.message : lastError).slice(0, 200)}`);
    },
    close: async () => {
      for (const provider of chain) {
        await (provider as { close?: () => Promise<void> }).close?.();
      }
    },
  };
}
