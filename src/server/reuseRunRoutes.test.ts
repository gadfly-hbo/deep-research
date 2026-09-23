import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapters } from "../adapters/types.js";
import { startServer, type RunningServer } from "./server.js";

const bodyA = "某平台品牌关注者样本中女性占 62%。样本定义见附注,不含购买者。";

const fakeAdapters = (): Adapters => ({
  search: { search: async () => [{ url: "https://a/1", title: "A", snippet: "" }] },
  page: { fetch: async (url) => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }) },
  parser: { parse: async () => ({ bodyText: bodyA, parseStatus: "ok" }) },
  model: {
    extractClaims: async ({ snapshot }) => ({
      claims: [{ statement: `${snapshot.title} 数值`, kind: "fact" as const, quote: snapshot.bodyText.slice(0, 16) }],
      cost: 0.01,
    }),
    runStage: async (stage) =>
      stage === "plan"
        ? { output: { questions: [{ id: "q1", question: "人群" }] }, cost: 0.01 }
        : stage === "analyze"
          ? { output: { findings: [], gaps: [] }, cost: 0.01 }
          : stage === "draft"
            ? { output: { reportMd: "# r\n\n## 人群\nx" }, cost: 0.01 }
            : { output: { issues: [], counterexampleChecked: true }, cost: 0.01 },
  },
});

describe("研究启动时的复用绑定(U2-06)", () => {
  let srv: RunningServer;
  let base: string;
  let reusable: { sourceId: string; versionId: string };
  let privateAsset: { sourceId: string; versionId: string };

  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "dr-reuse-run-"));
    srv = await startServer({ dataDir, makeAdapters: () => fakeAdapters() });
    base = `http://127.0.0.1:${srv.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<Record<string, any>>);
    reusable = (await post("/api/library/assets", {
      kind: "file",
      filename: "画像.md",
      content: bodyA,
      reuseScope: "WORKSPACE_REUSABLE",
    })).results[0];
    privateAsset = (await post("/api/library/assets", {
      kind: "file",
      filename: "私.md",
      content: "仅项目内材料。",
      projectId: "p-elsewhere",
    })).results[0];
  });
  afterAll(async () => {
    await srv.close();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<Record<string, any>>);

  it("启动研究时绑定合格资产、拒绝越权资产,绑定与使用记录可查", async () => {
    const project = await post("/api/projects", {
      module: "brand",
      goal: "复用画像的品牌研究",
      scope: { summary: "s", queries: [] },
    });
    const run = await post(`/api/projects/${project.id}/runs`, {
      request: {
        id: `req-${Date.now().toString(36)}`,
        module: "brand",
        goal: "复用画像的品牌研究",
        scope: { summary: "s", queries: ["人群"] },
      },
      plan: { questions: [{ id: "q1", question: "人群", status: "open" }] },
      selectedAssets: [
        { sourceId: reusable.sourceId, versionId: reusable.versionId, purpose: "人群案例" },
        { sourceId: privateAsset.sourceId, versionId: privateAsset.versionId, purpose: "越权尝试" },
      ],
    });
    expect(run.reuse.bound).toBe(1);
    expect(run.reuse.rejected).toHaveLength(1);
    expect(run.reuse.rejected[0].sourceId).toBe(privateAsset.sourceId);

    // 等运行落地后查绑定/使用
    await new Promise((r) => setTimeout(r, 600));
    const runList = await fetch(`${base}/api/projects/${project.id}`).then(
      (r) => r.json() as Promise<{ runs: Array<{ id: string; status: string }> }>,
    );
    const runId = runList.runs[0].id;
    const bindingsRes = await fetch(`${base}/api/library/bindings?runId=${runId}`).then(
      (r) => r.json() as Promise<{ bindings: Array<{ versionId: string; applicability: string }>; usages: unknown[] }>,
    );
    expect(bindingsRes.bindings).toHaveLength(1);
    expect(bindingsRes.bindings[0].versionId).toBe(reusable.versionId);
    expect(bindingsRes.usages.length).toBeGreaterThan(0);
  });
});
