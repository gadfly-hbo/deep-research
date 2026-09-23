import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapters } from "../adapters/types.js";
import { startServer, type RunningServer } from "./server.js";

const fakeAdapters = (): Adapters => ({
  search: { search: async () => [] },
  page: { fetch: async (url) => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }) },
  parser: { parse: async () => ({ bodyText: "x", parseStatus: "ok" }) },
  model: { extractClaims: async () => ({ claims: [], cost: 0 }), runStage: async () => ({ output: {}, cost: 0 }) },
});

describe("情报库检索/实体/元数据路由", () => {
  let srv: RunningServer;
  let base: string;

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "dr-lib-srch-"));
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters() });
    base = `http://127.0.0.1:${srv.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<Record<string, any>>);
    await post("/api/library/assets", {
      kind: "file",
      filename: "安克笔记.md",
      content: "安克(Anker)在中国市场的品牌定位与充电器份额。",
      reuseScope: "WORKSPACE_REUSABLE",
    });
    await post("/api/library/assets", {
      kind: "file",
      filename: "森马摘录.md",
      content: "森马服饰 2024 年营收 150 亿元。",
      projectId: "p-senma",
    });
  });
  afterAll(async () => {
    await srv.close();
  });

  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${base}${path}`, init);
    return { status: res.status, json: async () => res.json() as Promise<Record<string, any>> };
  };

  it("搜索路由:中文召回 + 片段 + 版本与限制信息", async () => {
    const res = await api("/api/library/search?q=安克");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.results[0].title).toBe("安克笔记");
    expect(body.results[0].snippet).toContain("安克");
    expect(body.results[0].versionId).toMatch(/^sv-/);
    expect(body.indexState).toBe("rebuilt");
  });

  it("搜索路由带项目上下文:PROJECT_ONLY 不跨项目泄露(S-01)", async () => {
    const leak = await api("/api/library/search?q=森马&projectId=p-other");
    expect((await leak.json()).results).toEqual([]);
    const own = await api("/api/library/search?q=森马&projectId=p-senma");
    expect((await own.json()).results).toHaveLength(1);
  });

  it("实体:创建 + 关联到资产后档案聚合可见", async () => {
    const list = await api("/api/library/assets");
    const anker = (await list.json()).assets.find((a: { source: { title: string } }) => a.source.title === "安克笔记");
    const created = await fetch(`${base}/api/library/entities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "brand", name: "安克", aliases: ["Anker"] }),
    }).then((r) => r.json() as Promise<{ entityId: string }>);
    await fetch(`${base}/api/library/assets/${anker.source.sourceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entityIds: [created.entityId] }),
    });
    const entities = await api("/api/library/entities");
    const row = (await entities.json()).entities.find((e: { entityId: string }) => e.entityId === created.entityId);
    expect(row.assetCount).toBe(1);
  });

  it("元数据更正:标题/类型可改,未知字段被忽略", async () => {
    const list = await api("/api/library/assets");
    const target = (await list.json()).assets[0];
    const patched = await fetch(`${base}/api/library/assets/${target.source.sourceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "安克品牌档案", docType: "industry-report", evil: "x" }),
    });
    expect(patched.status).toBe(200);
    const detail = await api(`/api/library/assets/${target.source.sourceId}`);
    const d = await detail.json();
    expect(d.source.title).toBe("安克品牌档案");
    expect(d.source.docType).toBe("industry-report");
    expect((d.source as Record<string, unknown>).evil).toBeUndefined();
  });
});
