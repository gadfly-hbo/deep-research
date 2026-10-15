import type { Calibration, SourceSnapshot } from "../contracts.js";
import type { StageName } from "../core/stages.js";

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchProvider {
  search(query: string, callKey: string): Promise<SearchHit[]>;
}

export interface FetchedPage {
  url: string;
  /** 重定向后的最终地址(若与请求地址不同);服务端据此复查 SSRF 边界(S-06) */
  finalUrl?: string;
  status: number;
  contentType: string;
  html?: string;
  text?: string;
  pdf?: Uint8Array;
  error?: string;
}

export interface PageFetcher {
  fetch(url: string, callKey: string): Promise<FetchedPage>;
}

export interface ParsedDoc {
  bodyText: string;
  parseStatus: "ok" | "failed";
  /** 网页自身标题(<title>/og:title/Readability);PDF 与纯文本源无此项 */
  title?: string;
}

export interface DocParser {
  parse(page: FetchedPage, callKey: string): Promise<ParsedDoc>;
}

export interface ExtractedClaim {
  statement: string;
  kind: "fact" | "inference" | "unverified";
  quote: string;
  calibration?: Calibration;
}

/** 模型用量计量(P2-2:替代已退役的 costEstimate;每次调用至少 modelCalls:1)。 */
export interface ModelUsage {
  modelCalls: number;
  outputTokens: number;
}

/** P2-4(R1-2):编排器传入的调查工具——executor 由宿主闭包提供(计数/配额/证据落盘),resourceUnits 恒 1。 */
export interface AgentTool {
  name: string;
  description: string;
  effect: "read" | "write" | "external";
  /** JSON schema 形状(zod 手写);工具定义(含 description)跨轮次不变(R1-1)。 */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

/** P2-4(R1-1):taskId 为完整字面量 dr:${keyBase}:gather-agent:r${round}:${q.id}(含轮次)。 */
export interface RunAgentInput {
  prompt: string;
  taskId: string;
  toolExecution: "sequential" | "parallel";
}

/** P2-4(C1 三分映射 agent 版):succeeded→text;INVALID_OUTPUT→text null(不杀问);failed/blocked→含 reason。 */
export interface RunAgentResult {
  status: "succeeded" | "failed" | "blocked";
  text: string | null;
  reason?: string;
  usage: ModelUsage;
}

export interface ModelProvider {
  extractClaims(
    input: { snapshot: SourceSnapshot },
    callKey: string,
  ): Promise<{ claims: ExtractedClaim[]; usage: ModelUsage }>;
  /** 阶段工人入口:编排器传 stage 名与输入,返回值由编排器按阶段 schema 校验。 */
  runStage(stage: StageName, input: unknown, callKey: string): Promise<{ output: unknown; usage: ModelUsage }>;
  /**
   * P2-4(D2):plain runAgent 采证入口(无状态、无会话)。
   * 可选:缺席时编排器按"通道不支持自主调查"降级(旧测试夹具/兼容路径;生产 piRuntime 恒提供)。
   */
  runAgent?(input: RunAgentInput, tools: AgentTool[], callKey: string): Promise<RunAgentResult>;
}

export interface Adapters {
  search: SearchProvider;
  page: PageFetcher;
  parser: DocParser;
  model: ModelProvider;
}

export type RecordedKind = "search" | "fetch" | "parse" | "model" | "stage";

export interface RecordedCall {
  key: string;
  kind: RecordedKind;
  response: unknown;
}

export type Recording = RecordedCall[];
