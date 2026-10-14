import { describe, expect, it } from "vitest";
import { snapshotFrom } from "./snapshotFrom.js";

describe("snapshotFrom", () => {
  it("集中字面量构造:tier 透传,now 注入确定 fetchedAt", () => {
    const s = snapshotFrom({
      id: "snap:x",
      url: "https://a/1",
      title: "标题",
      bodyText: "正文",
      parseStatus: "ok",
      contentType: "text/html",
      tier: "A",
      now: "2026-10-15T00:00:00.000Z",
    });
    expect(s).toEqual({
      id: "snap:x",
      url: "https://a/1",
      title: "标题",
      bodyText: "正文",
      parseStatus: "ok",
      contentType: "text/html",
      tier: "A",
      fetchedAt: "2026-10-15T00:00:00.000Z",
    });
  });

  it("tier 缺省则不产出该字段;now 缺省取当前时(ISO 形状)", () => {
    const s = snapshotFrom({
      id: "snap:y",
      url: "user-text://1",
      title: "用户补充材料",
      bodyText: "文本",
      parseStatus: "ok",
      contentType: "text/plain",
    });
    expect("tier" in s).toBe(false);
    expect(() => new Date(s.fetchedAt).toISOString()).not.toThrow();
  });
});
