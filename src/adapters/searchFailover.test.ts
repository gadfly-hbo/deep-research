import { describe, expect, it } from "vitest";
import { isTransientProviderError } from "./searchFailover.js";

describe("isTransientProviderError", () => {
  it("配额/限流类 → 瞬时", () => {
    expect(isTransientProviderError(new Error("402 quota 用量上限 2067"))).toBe(true);
    expect(isTransientProviderError(new Error("429 rate limit"))).toBe(true);
    expect(isTransientProviderError(new Error("No API key for provider"))).toBe(true);
  });

  it("中止/超时/连接类 → 瞬时(可切备用)", () => {
    expect(isTransientProviderError(new Error("This operation was aborted"))).toBe(true);
    expect(isTransientProviderError(new Error("TimeoutError: The operation was aborted due to timeout"))).toBe(true);
    expect(isTransientProviderError(new Error("fetch failed: ECONNRESET socket hang up"))).toBe(true);
    expect(isTransientProviderError(new Error("模型调用失败 HTTP 503"))).toBe(true);
  });

  it("配置/参数类错误 → 非瞬时(不掩盖问题)", () => {
    expect(isTransientProviderError(new Error("invalid params, function is empty (2013)"))).toBe(false);
    expect(isTransientProviderError(new Error("No such model: foo"))).toBe(false);
  });
});
