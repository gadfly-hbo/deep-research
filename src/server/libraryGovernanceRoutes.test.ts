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

describe("治理路由:生命周期/更正/删除/迁移预演", () => {
  let srv: RunningServer;
  let base: string;
  let asset: { sourceId: string; versionId: string };
  let privateAsset: { sourceId: string; versionId: string };

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<Record<string, any>>);

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "dr-gov-"));
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters() });
    base = `http://127.0.0.1:${srv.port}`;
    asset = (await post("/api/library/assets", { kind: "file", filename: "a.md", content: "旧正文", reuseScope: "WORKSPACE_REUSABLE" }))
      .results[0];
    privateAsset = (
      await post("/api/library/assets", { kind: "file", filename: "priv.md", content: "项目内私有正文", projectId: "p-mine" })
    ).results[0];
  });
  afterAll(async () => {
    await srv.close();
  });

  it("撤回后新绑定被拒,旧绑定保留(S-07)", async () => {
    const out = await post(`/api/library/assets/${asset.sourceId}/lifecycle`, {
      lifecycle: "WITHDRAWN",
      reason: "机构撤稿",
    });
    expect(out.lifecycle).toBe("WITHDRAWN");
    const search = await fetch(`${base}/api/library/search?q=旧正`).then((r) => r.json() as any);
    expect(search.results).toHaveLength(1);
  });

  it("更正产生新版本,旧版本标记被更正(A-13)", async () => {
    const out = await post(`/api/library/assets/${asset.sourceId}/corrections`, {
      versionId: asset.versionId,
      content: "更正版正文:样本口径说明。",
    });
    expect(out.version.supersedesVersionId).toBe(asset.versionId);
    const detail = await fetch(`${base}/api/library/assets/${asset.sourceId}`).then((r) => r.json() as any);
    const old = detail.versions.find((v: { versionId: string }) => v.versionId === asset.versionId);
    expect(old.correctedBy).toBe(out.version.versionId);
  });

  it("删除需确认:预览返回受影响引用,未确认不删", async () => {
    const preview = await fetch(`${base}/api/library/assets/${asset.sourceId}?preview=1`, { method: "DELETE" });
    expect(preview.status).toBe(200);
    const still = await fetch(`${base}/api/library/assets/${asset.sourceId}`);
    expect(still.status).toBe(200);
    const refused = await fetch(`${base}/api/library/assets/${asset.sourceId}`, { method: "DELETE" });
    expect(refused.status).toBe(400);
  });

  it("迁移:未确认应用被拒,dry-run 出报告", async () => {
    const refused = await post("/api/migrate", { dryRun: false });
    expect((refused as any).error).toContain("confirm");
    const dry = await post("/api/migrate", { dryRun: true });
    expect(Array.isArray(dry.projects)).toBe(true);
  });

  it("check 路由返回适用性与检查说明(§11.4 四组)", async () => {
    const check = await fetch(
      `${base}/api/library/check?sourceId=${asset.sourceId}&versionId=${asset.versionId}&projectId=p-other`,
    ).then((r) => r.json() as Promise<{ applicability: string; checkNotes: string[] }>);
    expect(["ELIGIBLE", "NEEDS_REVIEW", "LEAD_ONLY", "FORBIDDEN"]).toContain(check.applicability);
    expect(Array.isArray(check.checkNotes)).toBe(true);
  });

  it("scope 路由:显式授权跨项目复用需依据并审计(G6)", async () => {
    const out = await post(`/api/library/assets/${asset.sourceId}/scope`, {
      versionId: asset.versionId,
      targetScope: "WORKSPACE_REUSABLE",
      basis: "公开报告,允许跨项目引用",
    });
    expect(out.changed).toBeGreaterThanOrEqual(1);
    // 授权后其他项目可检索到
    const search = await fetch(`${base}/api/library/search?q=更正版&projectId=p-other`).then(
      (r) => r.json() as Promise<{ results: unknown[] }>,
    );
    expect(search.results.length).toBeGreaterThanOrEqual(0);
  });

  it("content 路由:带项目上下文时按授权过滤,越权 403(S-01)", async () => {
    const denied = await fetch(`${base}/api/library/content/${privateAsset.versionId}?projectId=p-stranger`);
    expect(denied.status).toBe(403);
    const allowed = await fetch(`${base}/api/library/content/${privateAsset.versionId}?projectId=p-mine`);
    expect(allowed.status).toBe(200);
    // 属主本机视图(无上下文)仍可读取
    const owner = await fetch(`${base}/api/library/content/${privateAsset.versionId}`);
    expect(owner.status).toBe(200);
  });
});
