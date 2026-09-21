import { describe, expect, it } from "vitest";
import type { Recording } from "./types.js";
import { replayAdapters } from "./replay.js";

const recording: Recording = [
  {
    key: "run-1:gather:search:0",
    kind: "search",
    response: { hits: [{ url: "https://example.com/a", title: "A", snippet: "…" }] },
  },
  {
    key: "run-1:gather:fetch:0",
    kind: "fetch",
    response: {
      page: { url: "https://example.com/a", status: 200, contentType: "text/html", html: "<p>x</p>" },
    },
  },
  {
    key: "run-1:gather:parse:0",
    kind: "parse",
    response: { doc: { bodyText: "正文", parseStatus: "ok" } },
  },
  {
    key: "run-1:gather:model:0",
    kind: "model",
    response: { claims: [{ statement: "s", kind: "fact", quote: "正文" }], cost: 0.01 },
  },
];

describe("replayAdapters", () => {
  it("按调用键回放录制的搜索/抓取/解析/模型响应", async () => {
    const adapters = replayAdapters(recording);
    const search = await adapters.search.search("q", "run-1:gather:search:0");
    expect(search).toEqual([{ url: "https://example.com/a", title: "A", snippet: "…" }]);
    const page = await adapters.page.fetch("https://example.com/a", "run-1:gather:fetch:0");
    expect(page.status).toBe(200);
    const doc = await adapters.parser.parse(page, "run-1:gather:parse:0");
    expect(doc.bodyText).toBe("正文");
    const model = await adapters.model.extractClaims(
      {
        snapshot: {
          id: "s1",
          url: "https://example.com/a",
          title: "A",
          fetchedAt: "2026-09-21T00:00:00.000Z",
          bodyText: "正文",
          parseStatus: "ok",
          contentType: "text/html",
        },
      },
      "run-1:gather:model:0",
    );
    expect(model.claims).toHaveLength(1);
    expect(model.cost).toBe(0.01);
  });

  it("录制中不存在的调用键直接报错(暴露夹具缺口,不静默编造)", async () => {
    const adapters = replayAdapters(recording);
    await expect(adapters.search.search("q", "run-9:gather:search:0")).rejects.toThrow(
      /run-9:gather:search:0/,
    );
  });
});
