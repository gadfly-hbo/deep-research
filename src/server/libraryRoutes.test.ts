import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapters } from "../adapters/types.js";
import { startServer, type RunningServer } from "./server.js";

const fakeAdapters = (): Adapters => ({
  search: { search: async () => [] },
  page: {
    fetch: async (url) => ({ url, status: 200, contentType: "text/html", html: "<p>链接正文</p>" }),
  },
  parser: { parse: async () => ({ bodyText: "链接正文", parseStatus: "ok" }) },
  model: {
    extractClaims: async () => ({ claims: [], cost: 0 }),
    runStage: async () => ({ output: {}, cost: 0 }),
  },
});

describe("情报库路由(U2-01)", () => {
  let srv: RunningServer;
  let base: string;

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "dr-lib-srv-"));
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters() });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterAll(async () => {
    await srv.close();
  });

  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, json: async () => res.json() as Promise<Record<string, any>>, res };
  };
  const post = (path: string, body: unknown) =>
    api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("不创建研究即可导入文件并在列表可见(A-02)", async () => {
    const reg = await post("/api/library/assets", {
      kind: "file",
      filename: "森马财报摘录.md",
      content: "# 森马\n2024 年营收 150 亿元(示例)",
      docType: "financial-disclosure",
      dataPeriod: "2024FY",
    });
    expect(reg.status).toBe(200);
    const item = (await reg.json()).results[0];
    expect(item.status).toBe("registered");

    const list = await api("/api/library/assets");
    const assets = (await list.json()).assets;
    const found = assets.find((a: { source: { sourceId: string } }) => a.source.sourceId === item.sourceId);
    expect(found).toBeTruthy();
    expect(found.source.title).toBe("森马财报摘录");
    expect(found.latestVersion.fetchStatus).toBe("READ_FULL");
    expect(found.reuseScope).toBe("PROJECT_ONLY");
  });

  it("批量导入逐项状态:成功/重复/失败分别返回", async () => {
    const reg = await post("/api/library/assets", {
      items: [
        { kind: "file", filename: "a.md", content: "批量正文" },
        { kind: "file", filename: "b.md", content: "批量正文" },
        { kind: "link", url: "http://127.0.0.1/x" },
      ],
    });
    const results = (await reg.json()).results;
    expect(results.map((r: { status: string }) => r.status)).toEqual(["registered", "duplicate", "failed"]);
  });

  it("链接登记为 DISCOVERED,详情不冒充已读正文(A-03);取得后产生新版本", async () => {
    const reg = await post("/api/library/assets", { kind: "link", url: "https://example.com/industry-report" });
    const item = (await reg.json()).results[0];
    expect(item.status).toBe("registered");

    const detail = await api(`/api/library/assets/${item.sourceId}`);
    const d = await detail.json();
    expect(d.source.url).toBe("https://example.com/industry-report");
    expect(d.versions[0].fetchStatus).toBe("DISCOVERED");
    expect(d.versions[0].contentHash).toBeUndefined();

    const fetched = await post("/api/library/assets/fetch", { versionId: item.versionId });
    expect(fetched.status).toBe(200);
    const f = await fetched.json();
    expect(f.fetchStatus).toBe("READ_FULL");
    const detail2 = await api(`/api/library/assets/${item.sourceId}`);
    expect((await detail2.json()).versions.length).toBe(2);
  });

  it("SSRF:本机/私网 URL 入库被拒(S-06)", async () => {
    const reg = await post("/api/library/assets", { kind: "link", url: "http://192.168.1.1/admin" });
    expect((await reg.json()).results[0].status).toBe("failed");
  });

  it("原文内容路由返回净化纯文本,未知版本 404", async () => {
    const reg = await post("/api/library/assets", { kind: "file", filename: "笔记.md", content: "正文 xyz" });
    const item = (await reg.json()).results[0];
    const content = await fetch(`${base}/api/library/content/${item.versionId}`);
    expect(content.status).toBe(200);
    expect(await content.text()).toContain("正文 xyz");
    const missing = await fetch(`${base}/api/library/content/sv-nope`);
    expect(missing.status).toBe(404);
  });
});
