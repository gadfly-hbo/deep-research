import type {
  Adapters,
  ExtractedClaim,
  FetchedPage,
  ParsedDoc,
  RecordedCall,
  Recording,
  RunAgentResult,
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
  usage: { modelCalls: number; outputTokens: number };
}
interface StageResponse {
  output: unknown;
  usage: { modelCalls: number; outputTokens: number };
}
/** R1-3:agent 录制形状=有序回合脚本(经手工具调用)+ 终局 result。 */
interface AgentResponse {
  input: { prompt: string; taskId: string; toolExecution: "sequential" | "parallel" };
  turns: Array<{ tool: { name: string; args: Record<string, unknown> } }>;
  result: RunAgentResult;
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
            return { output: { reportMd: draftMd }, usage: { modelCalls: 0, outputTokens: 0 } };
          }
          throw error;
        }
      },
      // P2-4(R1-3):按录制的回合脚本驱动真 executor——工具调用逐轮重演(executor 打到本
      // 回放适配器,按录制 callKey 逐位命中),终局返回录制的 result;
      // 快照/investigation/extract 由此全链再生
      runAgent: async (input, tools, callKey) => {
        const rec = lookup<AgentResponse>("agent", callKey);
        if (rec.input.prompt !== input.prompt) {
          throw new Error(`录制夹具 agent 任务卡不匹配: ${callKey}`);
        }
        const signal = new AbortController().signal;
        for (const turn of rec.turns) {
          const tool = tools.find((t) => t.name === turn.tool.name);
          if (!tool) throw new Error(`回放缺少工具: ${turn.tool.name} (${callKey})`);
          await tool.execute(turn.tool.args, signal);
        }
        return rec.result;
      },
    },
  };
}
