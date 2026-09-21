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
    },
  };
}
