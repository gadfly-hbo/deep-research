/**
 * 端到端验收(proposal §0.3 完成定义 / §15 示例):
 * 第一次品牌研究沉淀 → 显式授权后第二次行业研究复用 → 各自绑定来源版本 → 新证据继续沉淀;
 * 成果包增量、发布门禁(撤回阻断)一并覆盖。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { buildExportFilesV2 } from "../app/exportBundle.js";
import { publishBundle } from "../app/projectService.js";
import { ResearchRequestSchema, type ResearchRequest } from "../contracts.js";
import { FsLibraryStore } from "../library/fsLibraryStore.js";
import { bindAssets, changeReuseScope } from "../library/reuse.js";
import { changeLifecycle } from "../library/lifecycle.js";
import { FsProjectStore } from "../stores/fsStore.js";
import { runResearch, type RunOptions } from "./runResearch.js";

const bodies: Record<string, string> = {
  "https://brand/1": "某平台品牌关注者样本中女性占 62%,样本定义见附注。",
  "https://ind/1": "行业整体增速 8%,口径含线上与线下。",
};

function fakeAdapters(): Adapters {
  return {
    search: {
      search: async (q) =>
        q.includes("行业")
          ? [{ url: "https://ind/1", title: "行业报告", snippet: "" }]
          : [{ url: "https://brand/1", title: "品牌画像", snippet: "" }],
    },
    page: {
      fetch: async (url): Promise<FetchedPage> => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }),
    },
    parser: { parse: async (page) => ({ bodyText: bodies[page.url] ?? "", parseStatus: "ok" }) },
    model: {
      extractClaims: async ({ snapshot }) => ({
        claims: [
          {
            statement: `${snapshot.title} 关键数值`,
            kind: "fact" as const,
            quote: snapshot.bodyText.slice(0, 18),
            calibration: { entity: "样本", period: "2025", unit: "%" , value: 62 },
          },
        ],
        cost: 0.01,
      }),
      runStage: async (stage) =>
        stage === "analyze"
          ? { output: { findings: [], gaps: [] }, cost: 0.01 }
          : stage === "draft"
            ? { output: { reportMd: "# 报告\n\n## 关键发现\nx" }, cost: 0.01 }
            : { output: { issues: [], counterexampleChecked: true }, cost: 0.01 },
    },
  };
}

const brandRequest: ResearchRequest = ResearchRequestSchema.parse({
  id: "req-brand",
  module: "brand",
  goal: "品牌 A 人群画像",
  scope: { summary: "中国大陆 2025", queries: ["品牌 关注者 画像"] },
});
const industryRequest: ResearchRequest = ResearchRequestSchema.parse({
  id: "req-ind",
  module: "industry",
  goal: "细分行业规模(复用品牌材料)",
  scope: { summary: "中国大陆 2026", queries: ["行业 增速"] },
});

describe("端到端复用闭环验收", () => {
  let root: string;
  let library: FsLibraryStore;
  let brandDir: string;
  let industryDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dr-accept-"));
    library = FsLibraryStore.openOrCreate(join(root, "library"));
    brandDir = join(root, "projects", "p-brand");
    industryDir = join(root, "projects", "p-ind");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("品牌沉淀 → 授权 → 行业复用 → 版本各自固定 → 门禁与成果包一致", async () => {
    // 第一次:品牌研究沉淀
    const brandStore = FsProjectStore.create(brandDir, {
      module: "brand",
      goal: brandRequest.goal,
      scope: brandRequest.scope,
    });
    const brandRunId = "run-brand-1";
    const brand = await runResearch(brandRequest, fakeAdapters(), brandStore, {
      plan: { questions: [{ id: "q1", question: "品牌 关注者 画像", status: "open" }] },
      runId: brandRunId,
      projectId: "p-brand",
      library,
    });
    expect(brand.bundle).not.toBeNull();
    const brandSources = await library.listSources();
    expect(brandSources.some((s) => s.url === "https://brand/1")).toBe(true);
    const brandAsset = brandSources.find((s) => s.url === "https://brand/1")!;
    const brandVersion = (await library.versionsForSource(brandAsset.sourceId))[0];
    expect((await library.acquisitionsForVersion(brandVersion.versionId))[0].reuseScope).toBe("PROJECT_ONLY");

    // 显式授权放宽到工作台可复用(带依据,可审计)
    const scope = await changeReuseScope(library, {
      versionId: brandVersion.versionId,
      targetScope: "WORKSPACE_REUSABLE",
      basis: "公开调查机构报告,用户确认允许跨项目引用",
    });
    expect(scope.changed).toBe(1);
    // 用户显式授予外发/留存权利(S-03 门禁的许可路径)
    const acqs = await library.acquisitionsForVersion(brandVersion.versionId);
    await library.saveAcquisition({
      ...acqs[0],
      rights: { ...acqs[0].rights, localRetention: true, sendToExternalModel: true },
    });

    // 第二次:行业研究复用品牌材料 + 新采证
    const indStore = FsProjectStore.create(industryDir, {
      module: "industry",
      goal: industryRequest.goal,
      scope: industryRequest.scope,
    });
    const indRunId = "run-ind-1";
    const bound = await bindAssets(library, {
      runId: indRunId,
      projectId: "p-ind",
      idempotencyKey: "bind-ind-1",
      bindings: [
        {
          sourceId: brandAsset.sourceId,
          versionId: brandVersion.versionId,
          purpose: "代表品牌案例",
          applicability: "ELIGIBLE",
          checkNotes: ["样本仅限某平台关注者,不代表全行业"],
        },
      ],
    });
    expect(bound.rejected).toEqual([]);
    const industry = await runResearch(industryRequest, fakeAdapters(), indStore, {
      plan: { questions: [{ id: "q1", question: "行业 增速", status: "open" }] },
      runId: indRunId,
      projectId: "p-ind",
      library,
    });
    // 复用证据固定到第一次研究的版本;新采证另有版本
    const reusedEv = industry.bundle!.evidence.filter((e) => e.versionId === brandVersion.versionId);
    expect(reusedEv.length).toBeGreaterThan(0);
    expect(reusedEv[0].scopeNote).toContain("不代表全行业");
    const newEv = industry.bundle!.evidence.filter((e) => e.versionId && e.versionId !== brandVersion.versionId);
    expect(newEv.length).toBeGreaterThan(0);
    // 两个运行绑定与使用记录独立(A-12)
    expect((await library.bindingsForVersion(brandVersion.versionId)).map((b) => b.runId)).toEqual([indRunId]);
    expect((await library.usagesForRun(indRunId)).length).toBeGreaterThan(0);
    expect(await library.usagesForRun(brandRunId)).toEqual([]);

    // 成果包增量:无转交授权 → 正文不入包且缺失说明准确(S-04)
    const exportFiles = await buildExportFilesV2(industry.bundle!, { library, runId: indRunId });
    const paths = exportFiles.map((f) => f.path);
    expect(paths).toContain("asset_bindings.jsonl");
    expect(paths).toContain("source_versions.jsonl");
    expect(paths).toContain("limitations.md");
    expect(paths.some((p) => p.startsWith("permitted_assets/"))).toBe(false);
    const manifest = JSON.parse(
      exportFiles.find((f) => f.path === "manifest.json")!.content as string,
    ) as { schemaVersion: string; omissions: unknown[]; includesPermittedOriginals: boolean };
    expect(manifest.schemaVersion).toBe("2.0");
    expect(manifest.omissions.length).toBe(1);
    expect(manifest.includesPermittedOriginals).toBe(false);

    // 发布门禁:撤回来源后阻断;恢复后放行并写核验记录
    await changeLifecycle(library, brandAsset.sourceId, "WITHDRAWN", "机构撤稿");
    await expect(publishBundle(industryDir, indRunId, library)).rejects.toThrow(/撤回/);
    await changeLifecycle(library, brandAsset.sourceId, "ACTIVE");
    const published = await publishBundle(industryDir, indRunId, library);
    expect(published.version).toBe(1);
    const reviews = await library.reviewsFor(industry.bundle!.evidence[0].id);
    expect(reviews.length).toBeGreaterThan(0);
  });
});
