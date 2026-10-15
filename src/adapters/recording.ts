import type { Adapters, RecordedCall } from "./types.js";

export function recordingAdapters(live: Adapters, sink: (call: RecordedCall) => void): Adapters {
  return {
    search: {
      search: async (query, key) => {
        const hits = await live.search.search(query, key);
        sink({ key, kind: "search", response: { hits } });
        return hits;
      },
    },
    page: {
      fetch: async (url, key) => {
        const page = await live.page.fetch(url, key);
        sink({ key, kind: "fetch", response: { page } });
        return page;
      },
    },
    parser: {
      parse: async (page, key) => {
        const doc = await live.parser.parse(page, key);
        sink({ key, kind: "parse", response: { doc } });
        return doc;
      },
    },
    model: {
      extractClaims: async (input, key) => {
        const result = await live.model.extractClaims(input, key);
        sink({ key, kind: "model", response: result });
        return result;
      },
      runStage: async (stage, input, key) => {
        const result = await live.model.runStage(stage, input, key);
        sink({ key, kind: "stage", response: result });
        return result;
      },
      // P2-4(R1-3):agent 调用录制为有序回合脚本——经手的工具调用逐轮捕获(名+入参),
      // 终局 result 一并落盘;回放按脚本驱动真 executor(executor 内的 search/fetch/parse/model
      // 调用照常被上面录制,callKey 逐位可命中)
      ...(live.model.runAgent
        ? {
            runAgent: async (
              input: Parameters<NonNullable<Adapters["model"]["runAgent"]>>[0],
              tools: Parameters<NonNullable<Adapters["model"]["runAgent"]>>[1],
              key: string,
            ) => {
              const turns: Array<{ tool: { name: string; args: Record<string, unknown> } }> = [];
              const instrumented = tools.map((t) => ({
                ...t,
                execute: async (args: Record<string, unknown>, signal: AbortSignal) => {
                  turns.push({ tool: { name: t.name, args } });
                  return t.execute(args, signal);
                },
              }));
              const result = await live.model.runAgent!(input, instrumented, key);
              sink({
                key,
                kind: "agent",
                response: { input, turns, result },
              });
              return result;
            },
          }
        : {}),
    },
  };
}
