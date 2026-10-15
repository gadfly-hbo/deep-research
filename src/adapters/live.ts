import { Readability } from "@mozilla/readability";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { contentText, type Context, type Message, type Model, type Api } from "@earendil-works/pi-ai";
import { parseHTML } from "linkedom";
import { extractText } from "unpdf";
import type { StageName } from "../core/stages.js";
import type { SourceSnapshot } from "../contracts.js";
import { ModelCircuitBreaker, isTransientProviderError } from "./modelFailover.js";
import { STAGE_PROMPTS, parseClaims, parseJsonLoose, draftFromText, buildExtractPrompt, buildStagePrompt } from "./modelText.js";
import type { ExtractedClaim, ModelProvider, PageFetcher, DocParser, SearchProvider } from "./types.js";

const FETCH_TIMEOUT_MS = 30_000;
const MODEL_TIMEOUT_MS = Number(process.env.DR_MODEL_TIMEOUT_MS ?? 300_000);

function debugCall(provider: string, modelId: string, what: string, started: number, outcome: string): void {
  if (process.env.DR_DEBUG) {
    console.error(`[model] ${provider}/${modelId} ${what} ${((Date.now() - started) / 1000).toFixed(1)}s ${outcome}`);
  }
}

export interface LiveModelConfig {
  provider: string;
  modelId: string;
  /** 自定义 provider(非 pi-ai 内置)时提供 */
  api?: string;
  baseUrl?: string;
}

type StreamFn = (
  model: Model<Api>,
  context: Context,
  options?: Record<string, unknown>,
) => AsyncIterable<{ type: string; message?: { content: unknown; usage?: { cost?: { total?: number } } } }>;

async function streamFnFor(model: Model<Api>): Promise<StreamFn> {
  if (model.api === "anthropic-messages") {
    const mod = await import("@earendil-works/pi-ai/api/anthropic-messages");
    return mod.streamSimple as unknown as StreamFn;
  }
  if (model.api === "openai-completions") {
    const mod = await import("@earendil-works/pi-ai/api/openai-completions");
    return mod.streamSimple as unknown as StreamFn;
  }
  throw new Error(`一期模型适配器不支持 pi-ai api=${model.api}(仅 anthropic-messages / openai-completions)`);
}





const ENV_KEY_BY_PROVIDER: Record<string, string> = {
  "minimax-cn": "MINIMAX_CN_API_KEY",
  minimax: "MINIMAX_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  zai: "ZAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "volcengine-plan": "VOLCENGINE_PLAN_API_KEY",
};

function resolveModel(config: LiveModelConfig): Model<Api> {
  if (config.baseUrl && config.api) {
    // 自定义 provider(如 volcengine-plan):按配置构造模型对象
    return {
      id: config.modelId,
      name: config.modelId,
      api: config.api,
      provider: config.provider,
      baseUrl: config.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    } as Model<Api>;
  }
  // getBuiltinModel 的泛型约束面向编译期已知的 provider/model 字面量;配置驱动的取值在适配器边界收敛一次。
  return getBuiltinModel(config.provider as never, config.modelId as never) as Model<Api>;
}

function resolveApiKey(provider: string): string {
  const envName = ENV_KEY_BY_PROVIDER[provider] ?? `${provider.replace(/-/g, "_").toUpperCase()}_API_KEY`;
  const key = process.env[envName];
  if (!key) {
    throw new Error(`缺少模型密钥:请设置环境变量 ${envName}(密钥不进配置文件与日志)`);
  }
  return key;
}

export function piAiModel(configs: LiveModelConfig | LiveModelConfig[]): ModelProvider {
  const chain = Array.isArray(configs) ? configs : [configs];

  const breaker = new ModelCircuitBreaker({ threshold: 2, cooldownMs: 10 * 60_000 });

  async function withChain<T>(call: (cfg: LiveModelConfig) => Promise<T>): Promise<T> {
    const errors: string[] = [];
    let triedAny = false;
    for (const cfg of chain) {
      if (breaker.isTripped(cfg.provider)) {
        errors.push(`${cfg.provider}: 熔断冷却中(前两次连续瞬时失败)`);
        continue;
      }
      triedAny = true;
      try {
        const result = await call(cfg);
        breaker.recordSuccess(cfg.provider);
        return result;
      } catch (error) {
        // 配额/限流/中止/超时/连接类瞬时错误切备用;配置类错误直接抛出
        if (!isTransientProviderError(error)) throw error;
        breaker.recordFailure(cfg.provider);
        errors.push(`${cfg.provider}: ${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
      }
    }
    if (!triedAny) {
      throw new Error(`全部模型供应商处于熔断冷却期:${errors.join(" | ")};稍后重试`);
    }
    throw new Error(`全部模型供应商不可用(瞬时故障):${errors.join(" | ")}`);
  }

  async function extractWith(cfg: LiveModelConfig, snapshot: SourceSnapshot): Promise<{ claims: ExtractedClaim[]; cost: number }> {
    const model = resolveModel(cfg);
    const streamSimple = await streamFnFor(model);
    const apiKey = resolveApiKey(cfg.provider);
    const context: Context = {
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: [
            {
              type: "text",
              // xiaomi MIMO 端点不遵循 system 通道(xiaomi token-plan 实测),指令并入 user 消息,minimax 同样兼容
              text: buildExtractPrompt(snapshot),
            },
          ],
        },
      ],
    };
    let text = "";
    let cost = 0;
    const startedAt = Date.now();
    for await (const event of streamSimple(model, context, {
      apiKey,
      // 快速失败:重试与故障转移归主备链路管,不让 pi-ai 内部重试吃掉超时预算
      maxRetries: 1,
      maxRetryDelayMs: 5_000,
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    })) {
      if (event.type === "text_delta") {
        text += (event as { delta?: string }).delta ?? "";
      } else if (event.type === "done" && event.message) {
        const usage = event.message.usage;
        if (typeof usage?.cost?.total === "number") cost = usage.cost.total;
      } else if (event.type === "error") {
        const errMsg = (event as { error?: { errorMessage?: string } }).error?.errorMessage;
        throw new Error(`模型调用失败(${cfg.provider}/${cfg.modelId}): ${errMsg ?? JSON.stringify(event).slice(0, 300)}`);
      }
    }
    debugCall(cfg.provider, cfg.modelId, "extract", startedAt, `ok claims=${parseClaims(text).length}`);
    return { claims: parseClaims(text), cost };
  }

  async function stageWith(cfg: LiveModelConfig, stage: StageName, input: unknown): Promise<{ output: unknown; cost: number }> {
    const model = resolveModel(cfg);
    const streamSimple = await streamFnFor(model);
    const apiKey = resolveApiKey(cfg.provider);
    // 阶段工人 = pi-agent-core 的进程内 agent loop;本阶段无线工具,工具域在采证阶段由编排器确定性调用。
    const stageStartedAt = Date.now();
    const resultMessages = (await runAgentLoop(
      [
        {
          role: "user",
          // xiaomi MIMO 端点不遵循 system 通道(实测),阶段指令并入 user 消息,minimax 同样兼容
          content: [{ type: "text", text: buildStagePrompt(stage, input) }],
          timestamp: Date.now(),
        },
      ] as never[],
      { messages: [] },
      {
        model,
        apiKey,
        maxRetries: 1,
        maxRetryDelayMs: 5_000,
        convertToLlm: (messages: { role?: string }[]) =>
          messages.filter(
            (m): m is Message =>
              m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult",
          ),
      } as never,
      () => {},
      AbortSignal.timeout(MODEL_TIMEOUT_MS) as never,
      streamSimple as never,
    )) as { role: string; content?: unknown; usage?: { cost?: { total?: number } } }[];
    let text = "";
    let cost = 0;
    let failedReason: string | null = null;
    for (const message of resultMessages) {
      if (message.role !== "assistant") continue;
      const m = message as { content?: unknown; stopReason?: string; errorMessage?: string; usage?: { cost?: { total?: number } } };
      // runAgentLoop 会把供应商错误(如 429)吞进消息而不是抛出;检出 stopReason=error 主动抛,主备链路才会生效
      if (m.stopReason === "error") {
        failedReason = m.errorMessage ?? "agent loop 内部错误";
        continue;
      }
      text += contentText(m.content as never);
      if (typeof m.usage?.cost?.total === "number") cost += m.usage.cost.total;
    }
    if (failedReason) {
      debugCall(cfg.provider, cfg.modelId, `stage:${stage}`, stageStartedAt, `error`);
      throw new Error(`模型调用失败(${cfg.provider}/${cfg.modelId}): ${failedReason}`);
    }
    debugCall(cfg.provider, cfg.modelId, `stage:${stage}`, stageStartedAt, `ok text=${text.length}`);
    // draft/polish 是长 Markdown,模型常不守 JSON 包装;用鲁棒解析,不合格时由编排器护栏降级
    const output = stage === "draft" || stage === "polish" ? draftFromText(text) : parseJsonLoose(text);
    return { output, cost };
  }

  return {
    extractClaims: ({ snapshot }) => withChain((cfg) => extractWith(cfg, snapshot)),
    runStage: (stage, input) => withChain((cfg) => stageWith(cfg, stage, input)),
  };
}

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
