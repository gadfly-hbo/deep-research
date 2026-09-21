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

export function replayAdapters(recording: Recording): Adapters {
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
      runStage: async (_stage, _input, callKey) => lookup<StageResponse>("stage", callKey),
    },
  };
}
