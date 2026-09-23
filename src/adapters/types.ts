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

export interface ModelProvider {
  extractClaims(
    input: { snapshot: SourceSnapshot },
    callKey: string,
  ): Promise<{ claims: ExtractedClaim[]; cost: number }>;
  /** 阶段工人入口:编排器传 stage 名与输入,返回值由编排器按阶段 schema 校验。 */
  runStage(stage: StageName, input: unknown, callKey: string): Promise<{ output: unknown; cost: number }>;
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
