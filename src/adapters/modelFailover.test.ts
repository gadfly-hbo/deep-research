import { describe, expect, it } from "vitest";
import { isTransientProviderError, ModelCircuitBreaker } from "./modelFailover.js";

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

describe("ModelCircuitBreaker", () => {
  it("连续 2 次瞬时失败后熔断,冷却期内跳过该 provider", () => {
    const breaker = new ModelCircuitBreaker({ threshold: 2, cooldownMs: 60_000 });
    expect(breaker.isTripped("minimax-cn")).toBe(false);
    breaker.recordFailure("minimax-cn");
    expect(breaker.isTripped("minimax-cn")).toBe(false);
    breaker.recordFailure("minimax-cn");
    expect(breaker.isTripped("minimax-cn")).toBe(true);
    expect(breaker.isTripped("xiaomi")).toBe(false);
  });

  it("成功重置计数;冷却到期自动恢复", () => {
    const breaker = new ModelCircuitBreaker({ threshold: 2, cooldownMs: 10 });
    breaker.recordFailure("p");
    breaker.recordFailure("p");
    expect(breaker.isTripped("p")).toBe(true);
    breaker.recordSuccess("p");
    expect(breaker.isTripped("p")).toBe(false);
    breaker.recordFailure("p");
    breaker.recordFailure("p");
    expect(breaker.isTripped("p")).toBe(true);
    return new Promise((resolve) => setTimeout(() => {
      expect(breaker.isTripped("p")).toBe(false);
      resolve(null);
    }, 30));
  });
});
