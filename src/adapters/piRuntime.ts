/* P2-1:全项目唯一 Pi 接入点(接入标准接点 1)——只 import pi-agent-runtime。
   ModelProvider 的 8 个调用点(extractClaims + 7 runStage)经 createRuntime().runText 承载:
   - 三分映射(红队强制):succeeded→解析原始文本;INVALID_OUTPUT(含截断)→空文本走全函数解析器
     (extract→[] / stage→{},编排器现有降级链兜底);其余 failed/blocked→throw。
   - 主备链:config 链映射 ModelConfig(真值表/自定义 baseUrl+api/其余拒绝),无密钥候选跳过,
     切换与单次超时(modelTimeoutMs + modelRecovery:1)交 runtime。
   - 五必要输入:authorize 放行 model/publish(结果仅进程内返回,本批无工具/外发);
     audit→dataDir/model-audit.jsonl;budgets→内存 store(uncapped,名义账本,P2-2 正式化)。 */
import { appendFile, mkdir, rename, stat as statFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createPiTransport,
  createRuntime,
  type AuditEvent,
  type AuditSink,
  type JsonObject,
  type JsonValue,
  type ModelConfig,
  type ModelTransport,
  type Runtime,
} from "pi-agent-runtime";
import { defaultDataDir } from "../app/dataDir.js";
import { getBudgetStore } from "../server/fileBudgetStore.js";
import type { StageName } from "../core/stages.js";
import { buildExtractPrompt, buildStagePrompt, parseClaims, parseJsonLoose, draftFromText } from "./modelText.js";
import type { AgentTool, ModelProvider, RunAgentResult } from "./types.js";

export interface LiveModelConfig {
  provider: string;
  modelId: string;
  /** 自定义 provider(非真值表)时提供:openai-completions | anthropic-messages + baseUrl */
  api?: string;
  baseUrl?: string;
}

/** provider → 环境变量名(密钥只从环境注入,不进配置文件与日志)。 */
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

const envKeyFor = (provider: string): string =>
  ENV_KEY_BY_PROVIDER[provider] ?? `${provider.replace(/-/g, "_").toUpperCase()}_API_KEY`;

/** 真值表(红队 KA4 核实,pi-ai 内建数据 + 兄弟产品实测互证;mimo v2.6-flash 无内建须全显式)。 */
const TRUTH_TABLE: Record<string, ModelConfig> = {
  "minimax-cn/MiniMax-M3": {
    provider: "minimax-cn",
    id: "MiniMax-M3",
    protocol: "anthropic-messages",
    endpoint: "https://api.minimaxi.com/anthropic",
    contextWindow: 1_048_576,
    maxOutputTokens: 32_768,
    reasoning: true, // 仅声明能力,本批不启用 thinking
    input: ["text"],
  },
  "xiaomi-token-plan-cn/mimo-v2.6-flash": {
    provider: "xiaomi-token-plan-cn",
    id: "mimo-v2.6-flash",
    protocol: "openai-completions",
    endpoint: "https://token-plan-cn.xiaomimimo.com/v1",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    input: ["text"],
  },
};

/** ModelConfig 三分映射(R1-2):(a) 真值表精确匹配;(b) baseUrl+api 自定义;(c) 其余显式拒绝。 */
export function resolveModelConfig(cfg: LiveModelConfig): ModelConfig {
  const hit = TRUTH_TABLE[`${cfg.provider}/${cfg.modelId}`];
  if (hit) return hit;
  if (cfg.baseUrl && cfg.api) {
    return {
      provider: cfg.provider,
      id: cfg.modelId,
      protocol: cfg.api as ModelConfig["protocol"],
      endpoint: cfg.baseUrl,
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      input: ["text"],
    };
  }
  throw new Error(
    `本批未接入内建模型 ${cfg.provider}/${cfg.modelId}:请在 config.json 为其提供 baseUrl+api 自定义配置,或使用已验证候选(MiniMax-M3 / mimo-v2.6-flash)`,
  );
}

/** 无密钥候选跳过(不抛错);返回 null 由链构建处过滤。 */
export function transportFor(cfg: ModelConfig): ModelTransport | null {
  const apiKey = process.env[envKeyFor(cfg.provider)];
  if (!apiKey) return null;
  return createPiTransport({ model: cfg, apiKey });
}

/**
 * limits 单一 builder(R1:恰好五键,进程内逐字节一致)。
 * 宿主累计策略显式声明(P2-2 用户裁决"放开预算",标准 P4):uncapped——
 * 不设 modelCalls/token/墙钟累计上限;单次保护保留 modelTimeoutMs(300s 防挂死)与
 * maxOutputTokens(32k 防截断);tier→Limits 的静态硬顶映射被否(方案 B),动态预算属 P2-6。
 * P2-3b:导出供 sessionRuntime 装配复用(会话任务同 limits 语义)。
 */
export const buildLimits = () => ({
  cumulative: "unlimited" as const,
  maxOutputTokens: 32_768,
  modelTimeoutMs: Number(process.env.DR_MODEL_TIMEOUT_MS ?? 300_000),
  toolTimeoutMs: 30_000, // 罩住 fetch(20s)+解析+落盘的全程上限(P2-4 工具即采证)
  controlTimeoutMs: 30_000,
});

/** 审计落盘:workspace 级 model-audit.jsonl(单行 JSON <4KB,O_APPEND 本地盘并发安全;无 fsync,断电可丢尾——名义审计可接受)。
 * 轮转(P2-2 D6):写前检查 >50MB → rename .1(覆盖旧 .1,两代合计上限 ~100MB);并发 append 中 rename 的竞窗最多丢 1-2 行,披露接受。 */
const AUDIT_ROTATE_BYTES = 50 * 1024 * 1024;
/** P2-3b:导出供 sessionRuntime 装配复用(同一审计 sink 先例)。 */
export const makeAuditSink = (auditPath: string): AuditSink => ({
  append: async (event: Readonly<AuditEvent>, signal: AbortSignal) => {
    await mkdir(dirname(auditPath), { recursive: true });
    if (signal.aborted) throw new Error("审计写入被取消");
    try {
      const stat = await statFile(auditPath);
      if (stat.size > AUDIT_ROTATE_BYTES) await rename(auditPath, `${auditPath}.1`);
    } catch {
      /* 首写无文件 */
    }
    await appendFile(auditPath, `${JSON.stringify(event)}\n`);
  },
});

/** 1MiB 护栏(R1-6):prompt 拼装完成后按字节度量,超出预算对正文留头截断(避开代理对中切)。 */
const MAX_PROMPT_BYTES = 1_048_576;
const OVERHEAD_BUDGET = 8 * 1024;

/** extract prompt 形如 `${前缀}正文`;超预算时对正文(末尾主体)留头截断。 */
function clampExtractPrompt(snapshot: { url: string; title: string; bodyText: string }): string {
  const full = buildExtractPrompt(snapshot as never);
  const total = Buffer.byteLength(full);
  if (total <= MAX_PROMPT_BYTES) return full;
  const budget = MAX_PROMPT_BYTES - OVERHEAD_BUDGET;
  const head = full.slice(0, full.length - snapshot.bodyText.length);
  const headBytes = Buffer.byteLength(head);
  let cut = Math.max(0, budget - headBytes);
  while (cut > 0 && cut < snapshot.bodyText.length && (snapshot.bodyText.charCodeAt(cut) & 0xfc00) === 0xdc00) cut -= 1;
  const clipped = Buffer.from(snapshot.bodyText, "utf8").subarray(0, cut).toString("utf8");
  return `${head}${clipped}`;
}

export interface PiRuntimeOptions {
  /** 审计文件路径(默认 dataDir/model-audit.jsonl;测试注入临时目录)。 */
  auditPath?: string;
  /** 显式候选链(测试/装配注入,绕过 env 密钥解析;生产路径不传,走真值表+密钥跳过)。 */
  candidates?: Array<{ model: ModelConfig; transport: ModelTransport }>;
}

interface Channel {
  runTextRaw(prompt: string, callKey: string): Promise<{ text: string | null; usage: { modelCalls: number; outputTokens: number } }>;
  /** P2-4(R1-2):plain runAgent 通道——完整 RunResult 透传,三分映射 agent 版(C1)。 */
  runAgentRaw(
    input: { prompt: string; taskId: string; toolExecution: "sequential" | "parallel" },
    tools: AgentTool[],
    callKey: string,
  ): Promise<RunAgentResult>;
}

/** 调用计数重建阈值(P2-2 D5):子 taskId 唯一,丢弃 runtime 对象无语义损失,防 server 长跑 Map 线性膨胀。
   P2-3b(KA2):重建只弃 runtime 对象;持久 FileBudgetStore(路径单例,永不重建)跨重建延续账目。 */
const REBUILD_AFTER_CALLS = 100_000;

/**
 * runText 通道(runtime 进程级惰性单例,R1-3:config/env 变更需重启进程——
 * 与现状模块级超时常量语义一致)。ModelProvider 与 runFreeText 共用同一通道缓存。
 */
const channelCache = new Map<string, Channel>();

function getChannel(configs: LiveModelConfig | LiveModelConfig[], opts: PiRuntimeOptions = {}): Channel {
  const chain = Array.isArray(configs) ? configs : [configs];
  const cacheKey = JSON.stringify({ configs: opts.candidates ? null : configs, auditPath: opts.auditPath ?? null, candidates: opts.candidates?.length ?? 0 });
  let channel = channelCache.get(cacheKey);
  if (channel) return channel;
  // P2-3b(R1-5):账本目录=审计同源(dirname(auditPath),与 config.json 一致;--datadir 不改其位置)
  const auditPath = opts.auditPath ?? join(defaultDataDir(), "model-audit.jsonl");
  const auditSink = makeAuditSink(auditPath);
  // P2-3b(D1):持久账本——路径级进程单例,打开处 O_EXCL 跨进程收口,跨 channel 重建延续
  const budgets = getBudgetStore(dirname(auditPath));
  if (process.env.DR_DEBUG) {
    console.error(`[model] 预算账本 ${budgets.filePath}(锁 ${dirname(auditPath)}/.model-budget-lock)`);
  }
  const lastProviderByTask = new Map<string, string>();
  let runtime: Runtime | null = null;
  let callCount = 0;

  const getRuntime = (): Runtime => {
    if (runtime) return runtime;
    const candidates =
      opts.candidates ??
      chain
        .map(resolveModelConfig)
        .map((model) => ({ model, transport: transportFor(model) }))
        .filter((c): c is { model: ModelConfig; transport: ModelTransport } => c.transport !== null);
    if (candidates.length === 0) {
      throw new Error(`缺少模型密钥:请设置环境变量 ${chain.map((c) => envKeyFor(c.provider)).join(" / ")}`);
    }
    runtime = createRuntime({
      model: candidates[0].model,
      transport: candidates[0].transport,
      fallbacks: candidates.slice(1).map((c) => ({ model: c.model, transport: c.transport })),
      // 放行 model/publish(红队强制:成功路径强制 publish 授权;结果仅进程内返回,无外发)
      authorize: async () => true,
      audit: auditSink,
      budgets,
      onEvent: (event) => {
        if (event.kind === "model.finished") {
          lastProviderByTask.set(event.taskId, `${event.provider}/${event.model}`);
          if (process.env.DR_DEBUG && event.reason) {
            console.error(
              `[model] ${event.provider}/${event.model} attempt ${event.attempt ?? 1} failed ${event.reason}` +
                (event.failureCategory ? `/${event.failureCategory}` : ""),
            );
          }
        }
      },
    });
    return runtime;
  };

  /** runText + 三分映射:返回原始文本与用量;INVALID_OUTPUT(含截断)降级桶返回 null。 */
  channel = {
    runTextRaw: async (prompt, callKey): Promise<{ text: string | null; usage: { modelCalls: number; outputTokens: number } }> => {
      if (++callCount >= REBUILD_AFTER_CALLS) {
        callCount = 0;
        runtime = null; // P2-3b:只重建 runtime 对象;FileBudgetStore(路径单例)账目延续
        lastProviderByTask.clear();
      }
      const startedAt = Date.now();
      const result = await getRuntime().runText({
        taskId: `dr:${callKey}`,
        prompt,
        limits: buildLimits(),
        modelRecovery: { extraAttempts: 1 },
      });
      if (process.env.DR_DEBUG) {
        const who = lastProviderByTask.get(`dr:${callKey}`) ?? "unknown";
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        if (result.status === "succeeded") {
          console.error(`[model] ${callKey} ${secs}s ok via ${who} text=${result.value.length}`);
        } else {
          console.error(`[model] ${callKey} ${secs}s ${result.status}:${result.reason} via ${who}`);
        }
      }
      const usage = { modelCalls: result.usage.modelCalls, outputTokens: result.usage.outputTokens };
      if (result.status === "succeeded") return { text: result.value, usage };
      // 降级桶(含截断):零计量透传,文本 null 交解析器全函数兜底
      if (result.status === "failed" && result.reason === "INVALID_OUTPUT") return { text: null, usage };
      throw new Error(`模型调用失败(${result.reason})`);
    },
    /** P2-4:runAgent 工具循环——executor 抛错=TOOL_FAILED 整问失败(C1:宿主 executor 一律 error-as-value);
       taskId 为完整字面量(含轮次,R1-1),不与 callKey 拼接。 */
    runAgentRaw: async (input, tools, callKey): Promise<RunAgentResult> => {
      if (++callCount >= REBUILD_AFTER_CALLS) {
        callCount = 0;
        runtime = null;
        lastProviderByTask.clear();
      }
      const startedAt = Date.now();
      const result = await getRuntime().runAgent({
        taskId: input.taskId,
        prompt: input.prompt,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          effect: t.effect,
          parameters: t.parameters as JsonObject,
          resourceUnits: 1,
          execute: async (args: JsonObject, signal: AbortSignal) =>
            (await t.execute(args as Record<string, unknown>, signal)) as JsonValue,
        })),
        toolExecution: input.toolExecution,
        limits: buildLimits(),
        modelRecovery: { extraAttempts: 1 },
      });
      const usage = { modelCalls: result.usage.modelCalls, outputTokens: result.usage.outputTokens };
      if (process.env.DR_DEBUG) {
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.error(
          `[model] agent ${callKey} ${secs}s ${result.status}${"reason" in result ? `:${result.reason}` : ""} ` +
            `turns=${usage.modelCalls} tools=${result.usage.toolCalls}`,
        );
      }
      if (result.status === "succeeded") return { status: "succeeded", text: result.value, usage };
      // INVALID_OUTPUT(终局截断)不杀问:text=null 交编排器后验解析兜底(C1 裁决②)
      if (result.status === "failed" && result.reason === "INVALID_OUTPUT") {
        return { status: "succeeded", text: null, usage };
      }
      return { status: result.status === "blocked" ? "blocked" : "failed", text: null, reason: result.reason, usage };
    },
  };
  channelCache.set(cacheKey, channel);
  return channel;
}

/** 与旧 piAiModel 同形的 ModelProvider 工厂。 */
export function piRuntimeModel(configs: LiveModelConfig | LiveModelConfig[], opts: PiRuntimeOptions = {}): ModelProvider {
  const channel = getChannel(configs, opts);
  return {
    extractClaims: ({ snapshot }, callKey) =>
      channel.runTextRaw(clampExtractPrompt(snapshot), callKey).then(({ text, usage }) => ({
        claims: parseClaims(text ?? ""),
        usage,
      })),
    runStage: (stage: StageName, input: unknown, callKey) =>
      channel.runTextRaw(buildStagePrompt(stage, input), callKey).then(({ text, usage }) => ({
        output:
          stage === "draft" || stage === "polish"
            ? text === null
              ? {}
              : draftFromText(text)
            : parseJsonLoose(text ?? ""),
        usage,
      })),
    runAgent: (input, tools, callKey) => channel.runAgentRaw(input, tools, callKey),
  };
}

/** 通用自由文本入口(R1-7:backfill-titles 与 probe 脚本共用同一通道单例与 limits)。 */
export async function runFreeText(
  configs: LiveModelConfig | LiveModelConfig[],
  { prompt, callKey }: { prompt: string; callKey: string },
  opts?: PiRuntimeOptions,
): Promise<{ text: string }> {
  const { text } = await getChannel(configs, opts).runTextRaw(prompt, callKey);
  return { text: text ?? "" };
}
