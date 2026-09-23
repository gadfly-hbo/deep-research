import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { ResearchRequestSchema, type ResearchRequest } from "../contracts.js";
import { registerAsset } from "../library/assetService.js";
import { FsLibraryStore } from "../library/fsLibraryStore.js";
import { bindAssets } from "../library/reuse.js";
import { createMemoryStore } from "../stores/memory.js";
import { runResearch, type RunOptions } from "./runResearch.js";

function fakeAdapters(): Adapters {
  return {
    search: { search: async () => [{ url: "https://new/1", title: "N", snippet: "" }] },
    page: {
      fetch: async (url): Promise<FetchedPage> => ({ url, status: 200, contentType: "text/html", html: "<p>新采证正文</p>" }),
    },
    parser: { parse: async (page) => ({ bodyText: page.url === "https://new/1" ? "新采证正文:行业增速 8%。" : "", parseStatus: "ok" }) },
    model: {
      extractClaims: async ({ snapshot }) => ({
        claims: [{ statement: `${snapshot.title} 的关键数值`, kind: "fact" as const, quote: snapshot.bodyText.slice(0, 20) }],
        cost: 0.01,
      }),
      runStage: async (stage) =>
        stage === "analyze"
          ? { output: { findings: [], gaps: [] }, cost: 0.01 }
          : stage === "draft"
            ? { output: { reportMd: "# r\n\n## 复用\nx" }, cost: 0.01 }
            : { output: { issues: [], counterexampleChecked: true }, cost: 0.01 },
    },
  };
}

const request: ResearchRequest = ResearchRequestSchema.parse({
  id: "req-reuse",
  module: "industry",
  goal: "细分行业研究(复用品牌材料)",
  scope: { summary: "中国大陆 2026", queries: ["行业 增速"] },
});

describe("跨研究复用闭环(U2-06 / A-12)", () => {
  let dir: string;
  let library: FsLibraryStore;
  let asset: { sourceId: string; versionId: string };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "dr-reuse-int-"));
    library = FsLibraryStore.openOrCreate(dir);
    asset = await registerAsset(library, {
      kind: "file",
      filename: "品牌画像.md",
      content: "某平台品牌关注者样本中女性占 62%,样本定义见附注。",
      reuseScope: "WORKSPACE_REUSABLE",
      rights: { localRetention: true, sendToExternalModel: true },
    });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("绑定的 ELIGIBLE 资产正文进入采证上下文,证据固定到绑定版本并记使用记录", async () => {
    await bindAssets(library, {
      runId: "run-reuse-1",
      projectId: "p-ind",
      idempotencyKey: "bind-run-reuse-1",
      bindings: [
        {
          sourceId: asset.sourceId,
          versionId: asset.versionId,
          purpose: "品牌案例输入",
          applicability: "ELIGIBLE",
          checkNotes: ["样本仅限某平台关注者"],
        },
      ],
    });
    const options: RunOptions = {
      plan: { questions: [{ id: "q1", question: "行业 增速", status: "open" }] },
      runId: "run-reuse-1",
      projectId: "p-ind",
      library,
    };
    const { bundle } = await runResearch(request, fakeAdapters(), createMemoryStore(), options);
    const libSnapshot = bundle!.snapshots.find((s) => s.id === `snap:lib:${asset.versionId}`);
    expect(libSnapshot).toBeTruthy();
    const ev = bundle!.evidence.find((e) => e.versionId === asset.versionId);
    expect(ev).toBeTruthy();
    expect(ev!.scopeNote).toContain("关注者");
    const usages = await library.usagesForRun("run-reuse-1");
    expect(usages.some((u) => u.step === "gather" && u.bindingId)).toBe(true);
  });

  it("LEAD_ONLY 绑定只记线索使用,不注入证据(A-10/§10.2)", async () => {
    await bindAssets(library, {
      runId: "run-lead",
      projectId: "p-ind",
      bindings: [
        { sourceId: asset.sourceId, versionId: asset.versionId, purpose: "线索", applicability: "LEAD_ONLY" },
      ],
    });
    const { bundle } = await runResearch(request, fakeAdapters(), createMemoryStore(), {
      plan: { questions: [{ id: "q1", question: "行业 增速", status: "open" }] },
      runId: "run-lead",
      projectId: "p-ind",
      library,
    });
    expect(bundle!.snapshots.find((s) => s.id === `snap:lib:${asset.versionId}`)).toBeUndefined();
    const usages = await library.usagesForRun("run-lead");
    expect(usages.some((u) => u.step === "lead")).toBe(true);
  });

  it("S-03:未授权外发的资产不进入模型上下文,只记 blocked 使用与限制披露", async () => {
    const restricted = await registerAsset(library, {
      kind: "file",
      filename: "受限纪要.md",
      content: "内部访谈纪要:渠道返利政策。",
      reuseScope: "WORKSPACE_REUSABLE",
      rights: { localRetention: true },
    });
    await bindAssets(library, {
      runId: "run-blocked",
      projectId: "p-ind",
      bindings: [
        {
          sourceId: restricted.sourceId,
          versionId: restricted.versionId,
          purpose: "受限材料",
          applicability: "ELIGIBLE",
        },
      ],
    });
    const { bundle } = await runResearch(request, fakeAdapters(), createMemoryStore(), {
      plan: { questions: [{ id: "q1", question: "行业 增速", status: "open" }] },
      runId: "run-blocked",
      projectId: "p-ind",
      library,
    });
    expect(bundle!.snapshots.find((s) => s.id === `snap:lib:${restricted.versionId}`)).toBeUndefined();
    expect(bundle!.limitations.join()).toContain("未授权向外部模型发送正文");
    const usages = await library.usagesForRun("run-blocked");
    expect(usages.some((u) => u.step === "blocked-external")).toBe(true);
  });

  it("S-02:受限项目不能借用其他项目取得记录上的外发许可", async () => {
    const shared = await registerAsset(library, {
      kind: "file",
      filename: "共享披露.md",
      content: "集团披露:分部收入结构。",
      projectId: "p-a",
      rights: { localRetention: true, sendToExternalModel: true },
    });
    // 同版本上另有一条 p-b 的取得记录:仅留存、无外发授权
    await library.saveAcquisition({
      acquisitionId: "aq-b",
      versionId: shared.versionId,
      projectId: "p-b",
      acquiredAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      method: "user-file",
      readScope: "READ_FULL",
      reuseScope: "PROJECT_ONLY",
      rights: { localRetention: true },
    });
    await bindAssets(library, {
      runId: "run-leak",
      projectId: "p-b",
      bindings: [
        { sourceId: shared.sourceId, versionId: shared.versionId, purpose: "越权外发尝试", applicability: "ELIGIBLE" },
      ],
    });
    const { bundle } = await runResearch(request, fakeAdapters(), createMemoryStore(), {
      plan: { questions: [{ id: "q1", question: "行业 增速", status: "open" }] },
      runId: "run-leak",
      projectId: "p-b",
      library,
    });
    expect(bundle!.snapshots.find((s) => s.id === `snap:lib:${shared.versionId}`)).toBeUndefined();
    expect(bundle!.limitations.join()).toContain("未授权向外部模型发送正文");
  });

  it("同一资产被两个运行复用:各自独立绑定与使用记录(A-12)", async () => {
    for (const runId of ["run-a", "run-b"]) {
      await bindAssets(library, {
        runId,
        projectId: "p-ind",
        bindings: [
          { sourceId: asset.sourceId, versionId: asset.versionId, purpose: "案例", applicability: "ELIGIBLE" },
        ],
      });
      await runResearch(request, fakeAdapters(), createMemoryStore(), {
        plan: { questions: [{ id: "q1", question: "行业 增速", status: "open" }] },
        runId,
        projectId: "p-ind",
        library,
      });
    }
    const bindings = await library.bindingsForVersion(asset.versionId);
    expect(bindings.map((b) => b.runId).sort()).toEqual(["run-a", "run-b"]);
    expect((await library.usagesForRun("run-a")).length).toBeGreaterThan(0);
    expect((await library.usagesForRun("run-b")).length).toBeGreaterThan(0);
  });
});
