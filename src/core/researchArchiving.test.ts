import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { ResearchRequestSchema, type ResearchRequest } from "../contracts.js";
import { FsLibraryStore } from "../library/fsLibraryStore.js";
import type { LibraryStore } from "../library/types.js";
import { createMemoryStore } from "../stores/memory.js";
import { runResearch, type RunOptions } from "./runResearch.js";

const bodies: Record<string, string> = {
  "https://a/1": "中国咖啡市场规模约 1,200 亿元(2025 年)。行业边界含现磨与即饮。",
  "https://b/2": "现磨咖啡门店数持续增长。",
};

function fakeAdapters(): Adapters {
  return {
    search: {
      search: async () => [
        { url: "https://a/1", title: "A", snippet: "" },
        { url: "https://b/2", title: "B", snippet: "" },
      ],
    },
    page: {
      fetch: async (url): Promise<FetchedPage> => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }),
    },
    parser: { parse: async (page) => ({ bodyText: bodies[page.url] ?? "", parseStatus: "ok" }) },
    model: {
      extractClaims: async ({ snapshot }) =>
        snapshot.url === "https://a/1"
          ? { claims: [{ statement: "规模约 1200 亿元(2025)", kind: "fact" as const, quote: "市场规模约 1,200 亿元" }], cost: 0.01 }
          : { claims: [{ statement: "门店数增长", kind: "inference" as const, quote: "门店数持续增长" }], cost: 0.01 },
      runStage: async (stage) =>
        stage === "analyze"
          ? { output: { findings: [], gaps: [] }, cost: 0.01 }
          : stage === "draft"
            ? { output: { reportMd: "# r\n\n## 规模\nx" }, cost: 0.01 }
            : { output: { issues: [], counterexampleChecked: true }, cost: 0.01 },
    },
  };
}

const request: ResearchRequest = ResearchRequestSchema.parse({
  id: "req-arch",
  module: "industry",
  goal: "中国咖啡行业规模与结构",
  scope: { summary: "中国大陆 2025", queries: ["咖啡 市场规模"] },
});

const fullRun: RunOptions = {
  plan: { questions: [{ id: "q1", question: "咖啡 市场规模", status: "open" }] },
  projectId: "p-coffee",
};

describe("研究过程留档(U2-02 / 流程 C)", () => {
  let dir: string;
  let library: FsLibraryStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dr-arch-"));
    library = FsLibraryStore.openOrCreate(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("gather 读取成功即沉淀:来源/版本/取得记录入情报库,默认项目范围", async () => {
    await runResearch(request, fakeAdapters(), createMemoryStore(), { ...fullRun, library });
    const sources = await library.listSources();
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.url).sort()).toEqual(["https://a/1", "https://b/2"]);
    const source = sources.find((s) => s.url === "https://a/1")!;
    const versions = await library.versionsForSource(source.sourceId);
    expect(versions[0].fetchStatus).toBe("READ_FULL");
    const content = await library.readContent(versions[0].contentRef!);
    expect(content).toContain("1,200 亿元");
    const acqs = await library.acquisitionsForVersion(versions[0].versionId);
    expect(acqs[0].method).toBe("research-fetch");
    expect(acqs[0].projectId).toBe("p-coffee");
    expect(acqs[0].reuseScope).toBe("PROJECT_ONLY");
  });

  it("证据绑定来源版本并带修订号与待核验状态", async () => {
    const { bundle } = await runResearch(request, fakeAdapters(), createMemoryStore(), { ...fullRun, library });
    const ev = bundle!.evidence[0];
    expect(ev.versionId).toMatch(/^sv-/);
    expect(ev.revision).toBe(1);
    expect(ev.extractionCheck).toBe("UNCHECKED");
    // 版本确实存在于情报库且内容可定位
    const version = await library.getVersion(ev.versionId!);
    expect(version).not.toBeNull();
  });

  it("中断/有限交付的任务仍保留已有效取得的材料(S-10)", async () => {
    await runResearch(request, fakeAdapters(), createMemoryStore(), {
      ...fullRun,
      library,
      stopAfter: "gather",
    });
    const sources = await library.listSources();
    expect(sources.length).toBeGreaterThan(0);
  });

  it("共享登记失败不冒充已沉淀:run 继续,limitations 披露待处理(S-11)", async () => {
    const broken = {
      ...library,
      saveSource: async () => {
        throw new Error("library write failed");
      },
    } as unknown as LibraryStore;
    const { bundle } = await runResearch(request, fakeAdapters(), createMemoryStore(), {
      ...fullRun,
      library: broken,
    });
    expect(bundle).not.toBeNull();
    expect(bundle!.limitations.some((l) => l.includes("共享登记待处理"))).toBe(true);
  });
});
