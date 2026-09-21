import type { SearchProvider } from "./types.js";
import { isTransientProviderError } from "./modelFailover.js";

/** 搜索主备:配额/限流/缺密钥类失败切下一个,其余错误直接抛出。 */
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
