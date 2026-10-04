import { describe, expect, it } from "vitest";
import { cleanPageTitle, liveParser } from "./live.js";

const html = (head: string, body: string) =>
  `<!doctype html><html><head>${head}</head><body><article><p>${body}</p></article></body></html>`;

describe("liveParser 网页标题提取(A 治本)", () => {
  it("优先 og:title,其次 <title>;都没有则无标题", async () => {
    const og = await liveParser().parse(
      { url: "https://a/1", status: 200, contentType: "text/html", html: html('<meta property="og:title" content="OG 标题"><title>标签标题</title>', "正文内容足够长。") },
      "t:0",
    );
    expect(og.title).toBe("OG 标题");

    const tag = await liveParser().parse(
      { url: "https://a/2", status: 200, contentType: "text/html", html: html("<title>标签标题</title>", "正文内容足够长。") },
      "t:1",
    );
    expect(tag.title).toBe("标签标题");

    const none = await liveParser().parse(
      { url: "https://a/3", status: 200, contentType: "text/html", html: html("", "<h1>没有标题元素</h1><p>正文内容足够长。</p>") },
      "t:2",
    );
    expect(none.title).toBeUndefined();
  });

  it("标题缺失或碎片形态不产垃圾:title 为 undefined", async () => {
    const none = await liveParser().parse(
      { url: "https://a/4", status: 200, contentType: "text/html", html: html('<title>{"link": ""}</title>', "正文内容足够长。") },
      "t:3",
    );
    expect(none.title).toBeUndefined();
  });

  it("cleanPageTitle:空白折叠与碎片剔除", () => {
    expect(cleanPageTitle("  森马   2024 年报 \n")).toBe("森马 2024 年报");
    expect(cleanPageTitle('{"link": ""}')).toBeUndefined();
    expect(cleanPageTitle("ab")).toBeUndefined();
    expect(cleanPageTitle(null)).toBeUndefined();
  });

  it("cleanPageTitle:GBK 乱码与占位标题剔除", () => {
    expect(cleanPageTitle("ɭ\ufffd\ufffd\ufffd\ufffd(002563)_\ufffd\ufffd˹\ufffd\ufffd")).toBeUndefined();
    expect(cleanPageTitle("Document")).toBeUndefined();
    expect(cleanPageTitle("森马服饰：2024年门店实现净增加")).toBeTruthy();
  });
});
