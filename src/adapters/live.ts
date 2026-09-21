import { Readability } from "@mozilla/readability";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { contentText, type Context, type Message, type Model, type Api } from "@earendil-works/pi-ai";
import { parseHTML } from "linkedom";
import { extractText } from "unpdf";
import type { StageName } from "../core/stages.js";
import type { SourceSnapshot } from "../contracts.js";
import { ModelCircuitBreaker, isTransientProviderError } from "./modelFailover.js";
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

const EXTRACTION_SYSTEM_PROMPT = [
  "你是研究证据抽取器。只输出一个 JSON 数组,不要任何其他文字或代码围栏。",
  "数组元素形状: {\"statement\": string, \"kind\": \"fact\"|\"inference\"|\"unverified\", \"quote\": string, \"calibration\"?: {\"entity\": string, \"period\": string, \"unit\": string}}。",
  "quote 必须从正文中直接复制连续片段(≤80字),不得改写、缩略、翻译、增删标点或合并不相邻句子;复制前先在正文中找到原句。无法逐字引用时 kind 取 \"unverified\" 且 quote 为空字符串。",
  "statement 用一句话陈述;涉及数值时必须给 calibration(对象/时间/单位)。",
].join("\n");

function parseClaims(text: string): ExtractedClaim[] {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const claims: ExtractedClaim[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    const statement = typeof rec.statement === "string" ? rec.statement : "";
    const quote = typeof rec.quote === "string" ? rec.quote : "";
    if (!statement) continue;
    const kind = rec.kind === "fact" || rec.kind === "inference" ? rec.kind : "unverified";
    const cal = rec.calibration as Record<string, unknown> | undefined;
    claims.push({
      statement,
      kind,
      quote,
      ...(cal &&
      typeof cal.entity === "string" &&
      typeof cal.period === "string" &&
      typeof cal.unit === "string" &&
      cal.entity.trim() !== "" &&
      cal.period.trim() !== "" &&
      cal.unit.trim() !== ""
        ? { calibration: { entity: cal.entity, period: cal.period, unit: cal.unit } }
        : {}),
    });
  }
  return claims;
}

const STAGE_PROMPTS: Record<StageName, string> = {
  plan: '你是研究计划器。只输出 JSON:{"questions":[{"id":string,"question":string,"method"?:string,"status":"open"}]}。围绕目标与范围拆解研究问题,id 用 q1、q2…,不要输出其他文字。',
  outline:
    '你是报告框架设计师。只输出 JSON:{"title":string,"subtitle"?:string,"sections":[{"id":string,"title":string,"purpose"?:string,"bullets":string[]}]}。基于研究目标与已确认的问题清单设计报告章节结构,id 用 s1、s2…,每节给 2-4 条内容要点(bullets),章节须覆盖全部研究问题,不要输出其他文字。',
  analyze: '你是证据分析器。只输出 JSON:{"findings":[{"questionId":string,"summary":string,"claimIds":string[]}],"gaps":[{"questionId":string,"reason":string}]}。基于已登记主张作答,不新增主张。',
  draft:
    '你是研究报告撰写器。只输出 JSON:{"reportMd":string}。中文 Markdown。若输入含 outline,报告标题用 outline.title,逐节按 outline.sections 的标题与要点撰写(每节用 ## 标题,证据不足的节如实说明);只陈述有证据支持的内容,推断须标注。',
  review: '你是研究评审器。只输出 JSON:{"issues":[{"severity":"high"|"low","kind":"citation"|"caliber"|"gap"|"counterexample"|"other","detail":string,"targetClaimId"?:string,"targetQuestionId"?:string,"fix":"regather"|"rephrase"|"disclose"}],"counterexampleChecked":boolean}。检查引用核查与口径冲突输入,对关键结论做反例检查。',
  formal:
    '你是报告定稿编辑。只输出 JSON:{"executiveSummary":string[],"sectionHighlights":[{"sectionId":string,"bullets":string[]}]}。executiveSummary 给 3-5 条决策者视角的结论要点;sectionHighlights 按输入 sections 的 sectionId 逐节提炼 2-4 条要点。只允许重组草稿已有内容与主张,严禁新增任何事实或数字。',
};

function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // 继续尝试截取第一个 JSON 块
  }
  const start = cleaned.search(/[{[]/);
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      // 落到空输出,由编排器 schema 校验报出
    }
  }
  return {};
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

/** 主备链路:按序尝试各 provider,配额/限流类错误自动切备用(用户决策:minimax 主用,xiaomi 备用)。 */
/** draft 输出鲁棒解析:优先 JSON 包装,模型直接吐 Markdown 时原文即报告(去围栏)。 */
export function draftFromText(text: string): { reportMd: string } {
  const cleaned = text
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  const parsed = parseJsonLoose(cleaned) as { reportMd?: unknown };
  if (parsed && typeof parsed.reportMd === "string" && parsed.reportMd.trim() !== "") {
    return { reportMd: parsed.reportMd };
  }
  return { reportMd: cleaned };
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
              text: `${EXTRACTION_SYSTEM_PROMPT}\n\n快照 URL: ${snapshot.url}\n标题: ${snapshot.title}\n正文:\n${snapshot.bodyText}`,
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
          content: [{ type: "text", text: `${STAGE_PROMPTS[stage]}\n\n输入(JSON):\n${JSON.stringify(input)}` }],
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
    // draft 是长 Markdown,模型常不守 JSON 包装;用鲁棒解析,不合格时由编排器护栏降级
    const output = stage === "draft" ? draftFromText(text) : parseJsonLoose(text);
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
        if (!response.ok) {
          return { url, status: response.status, contentType, error: `HTTP ${response.status}` };
        }
        if (contentType.includes("pdf")) {
          return { url, status: 200, contentType, pdf: new Uint8Array(await response.arrayBuffer()) };
        }
        const body = await response.text();
        return contentType.includes("html")
          ? { url, status: 200, contentType, html: body }
          : { url, status: 200, contentType, text: body };
      } catch (error) {
        return { url, status: 0, contentType: "", error: String(error) };
      }
    },
  };
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
        const article = new Readability(document).parse();
        const bodyText = article?.textContent ?? document.body?.textContent ?? "";
        return { bodyText, parseStatus: bodyText.trim() ? "ok" : "failed" };
      } catch {
        return { bodyText: "", parseStatus: "failed" };
      }
    },
  };
}
