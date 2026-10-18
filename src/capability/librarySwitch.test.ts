/* E1 T3:情报库沉淀开关 + 模块中性防回归。
   缝:FsLibraryStore.openOrCreate 临时目录(library 测试先例)+ capability Port。 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { scriptedRunAgent } from "../adapters/testing.js";
import { FsLibraryStore } from "../library/fsLibraryStore.js";
import { getModuleConfig } from "../modules/registry.js";
import { createResearchCapability } from "./researchCapability.js";
import type { ExternalResearchResult } from "./researchCapability.js";

const USAGE = { modelCalls: 1, outputTokens: 16 };

const fakes = (): Adapters => ({
  search: { search: async () => [{ url: "https://a/1", title: "A", snippet: "" }] },
  page: { fetch: async (url): Promise<FetchedPage> => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }) },
  parser: { parse: async () => ({ bodyText: "中国咖啡市场规模约 1,200 亿元(2025 年)。", parseStatus: "ok" }) },
  model: {
    extractClaims: async ({ snapshot }: { snapshot: { url: string } }) => ({
      claims: [{ statement: `${snapshot.url} 的主张`, kind: "fact" as const, quote: "市场规模" }],
      usage: { ...USAGE },
    }),
    runStage: async () => ({ output: { findings: [], gaps: [] }, usage: { ...USAGE } }),
    runAgent: scriptedRunAgent(),
  },
});

const waitTerminal = async (cap: ReturnType<typeof createResearchCapability>, jobId: string): Promise<ExternalResearchResult> => {
  for (let i = 0; i < 200; i++) {
    const r = cap.result(jobId);
    if (r) return r;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job 未到终态: ${jobId}`);
};

describe("E1 T3:情报库沉淀开关(D10)", () => {
  it("注入 library+projectId:job 完成后来源沉淀入库;归属 projectId", async () => {
    const root = mkdtempSync(join(tmpdir(), "dr-e1-lib-"));
    const library = FsLibraryStore.openOrCreate(join(root, "library"));
    const cap = createResearchCapability({ adapters: fakes(), dataDir: root, library, projectId: "analysis-task-1" });
    const { jobId } = cap.submit({ questions: [{ id: "q1", question: "市场规模" }] });
    const result = await waitTerminal(cap, jobId);
    expect(result.status).toBe("completed");
    const sources = await library.listSources();
    expect(sources.length).toBeGreaterThanOrEqual(1);
    expect(sources.some((s) => s.url === "https://a/1" || s.title === "A")).toBe(true);
  }, 20_000);

  it("取消后已抓快照已入库(采证时刻沉淀,不待终态)", async () => {
    const root = mkdtempSync(join(tmpdir(), "dr-e1-libc-"));
    const library = FsLibraryStore.openOrCreate(join(root, "library"));
    const adapters = fakes();
    let cancelNow: (() => void) | null = null;
    let fetchCount = 0;
    const originalFetch = adapters.page.fetch.bind(adapters.page);
    adapters.page.fetch = async (url: string, callKey: string) => {
      fetchCount += 1;
      if (fetchCount >= 2 && cancelNow) cancelNow();
      return originalFetch(url, callKey);
    };
    const cap = createResearchCapability({ adapters, dataDir: root, library, projectId: "analysis-task-2" });
    const { jobId } = cap.submit({ questions: [{ id: "q1", question: "市场规模" }, { id: "q2", question: "竞争格局" }] });
    cancelNow = () => cap.cancel(jobId);
    const result = await waitTerminal(cap, jobId);
    expect(result.status).toBe("cancelled");
    const sources = await library.listSources();
    expect(sources.length).toBeGreaterThanOrEqual(1); // q1 的快照在取消前已入库
  }, 20_000);

  it("不注入 library:job 正常完成,无沉淀路径也无错", async () => {
    const root = mkdtempSync(join(tmpdir(), "dr-e1-libn-"));
    const cap = createResearchCapability({ adapters: fakes(), dataDir: root });
    const { jobId } = cap.submit({ questions: [{ id: "q1", question: "市场规模" }] });
    const result = await waitTerminal(cap, jobId);
    expect(result.status).toBe("completed");
  }, 20_000);
});

describe("E1 T3:module 中性防回归(D6)", () => {
  it("brand/industry 两 config 的 preferredDomains 均空——capability 缺省 module=industry 保持中性", () => {
    for (const mod of ["brand", "industry"] as const) {
      const config = getModuleConfig(mod);
      expect(config.sourceStrategy.preferredDomains ?? []).toEqual([]);
    }
  });
});
