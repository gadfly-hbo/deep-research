/**
 * 模型供应商故障转移的判定与熔断。
 *
 * 瞬时错误(配额/限流/中止/超时/连接/5xx)允许切备用;配置/参数类错误直接抛出,不掩盖问题。
 * 熔断:同一 provider 连续 N 次瞬时失败后,冷却期内直接跳过,避免每次调用都烧满超时。
 */
const TRANSIENT = /429|402|rate.?limit|quota|用量上限|2067|insufficient|额度|缺少模型密钥|No API key|aborted|timeout|timed? ?out|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|network|HTTP 5\d\d|服务暂时|overloaded/i;

export function isTransientProviderError(error: unknown): boolean {
  const text = String(error instanceof Error ? error.message : error);
  return TRANSIENT.test(text);
}

export interface BreakerOptions {
  threshold: number;
  cooldownMs: number;
  now?: () => number;
}

interface ProviderState {
  consecutiveFailures: number;
  trippedAt: number | null;
}

export class ModelCircuitBreaker {
  private readonly states = new Map<string, ProviderState>();

  constructor(private readonly options: BreakerOptions) {}

  private state(provider: string): ProviderState {
    let s = this.states.get(provider);
    if (!s) {
      s = { consecutiveFailures: 0, trippedAt: null };
      this.states.set(provider, s);
    }
    return s;
  }

  recordFailure(provider: string): void {
    const s = this.state(provider);
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= this.options.threshold) {
      s.trippedAt = (this.options.now ?? Date.now)();
    }
  }

  recordSuccess(provider: string): void {
    this.states.set(provider, { consecutiveFailures: 0, trippedAt: null });
  }

  isTripped(provider: string): boolean {
    const s = this.state(provider);
    if (s.trippedAt === null) return false;
    const now = (this.options.now ?? Date.now)();
    if (now - s.trippedAt >= this.options.cooldownMs) {
      s.trippedAt = null;
      s.consecutiveFailures = 0;
      return false;
    }
    return true;
  }
}
