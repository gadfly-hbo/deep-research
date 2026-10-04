import type {
  Adapters,
  ExtractedClaim,
  FetchedPage,
  ParsedDoc,
  RecordedCall,
  Recording,
  SearchHit,
} from "./types.js";

interface SearchResponse {
  hits: SearchHit[];
}
interface FetchResponse {
  page: FetchedPage;
}
interface ParseResponse {
  doc: ParsedDoc;
}
interface ModelResponse {
  claims: ExtractedClaim[];
  cost: number;
}
interface StageResponse {
  output: unknown;
  cost: number;
}

export interface ReplayOptions {
  /**
   * 兼容 polish 阶段引入之前的旧录制(PRD D4):缺失 polish 调用时降级为
   * "沿用草稿原文"(等价于跳过润色)。缺省 false——新测试夹具缺 polish 响应仍应暴露缺口。
   */
  stalePolishFallback?: boolean;
}

export function replayAdapters(recording: Recording, options: ReplayOptions = {}): Adapters {
  const byKey = new Map<string, RecordedCall>(recording.map((c) => [c.key, c]));
  const lookup = <T>(kind: RecordedCall["kind"], callKey: string): T => {
    const call = byKey.get(callKey);
    if (!call || call.kind !== kind) {
      throw new Error(`录制夹具缺少调用: ${callKey} (kind=${kind})`);
    }
    return call.response as T;
  };
  return {
    search: {
      search: async (_query, callKey) => lookup<SearchResponse>("search", callKey).hits,
    },
    page: {
      fetch: async (_url, callKey) => lookup<FetchResponse>("fetch", callKey).page,
    },
    parser: {
      parse: async (_page, callKey) => lookup<ParseResponse>("parse", callKey).doc,
    },
    model: {
      extractClaims: async (_input, callKey) => lookup<ModelResponse>("model", callKey),
      runStage: async (stage, input, callKey) => {
        try {
          return lookup<StageResponse>("stage", callKey);
        } catch (error) {
          if (options.stalePolishFallback && stage === "polish") {
            const draftMd = (input as { draftMd?: string }).draftMd ?? "";
            return { output: { reportMd: draftMd }, cost: 0 };
          }
          throw error;
        }
      },
    },
  };
}
