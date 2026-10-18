/* E1 T2:嵌入式研究能力库——Port/job 管理器/装配/持久化(合成驱动,不触网)。
   缝:Adapters 直注(budgetTopup fakes 先例)+ FsProjectStore 临时目录。 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { scriptedRunAgent } from "../adapters/testing.js";
import { createResearchCapability } from "./researchCapability.js";
import type { ExternalResearchResult } from "./researchCapability.js";

const USAGE = { modelCalls: 1, outputTokens: 16 };

const fakes = (): Adapters => ({
  search: { search: async () => [{ url: "https://a/1", title: "A", snippet: "" }] },
  page: { fetch: async (url): Promise<FetchedPage> => ({ url, status: 200, contentType: "text/html", html: "<p>x</p>" }) },
  parser: { parse: async () => ({ bodyText: "中国咖啡市场规模约 1,200 亿元(2025 年)。", parseStatus: "ok" }) },
  model: {
    extractClaims: async ({ snapshot }: { snapshot: { url: string } }) => ({
      claims: [{ statement: `${snapshot.url} 的主张:市场规模约 1,200 亿元`, kind: "fact" as const, quote: "市场规模约 1,200 亿元", calibration: { entity: "中国咖啡市场", period: "2025", unit: "亿元" } }],
      usage: { ...USAGE },
    }),
    runStage: async () => ({ output: { findings: [], gaps: [] }, usage: { ...USAGE } }),
    runAgent: scriptedRunAgent(),
  },
});

const waitTerminal = async (
  cap: ReturnType<typeof createResearchCapability>,
  jobId: string,
): Promise<ExternalResearchResult> => {
  for (let i = 0; i < 200; i++) {
    const r = cap.result(jobId);
    if (r) return r;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`job 未到终态: ${jobId} 状态 ${cap.status(jobId).status}`);
};

const dataDir = (): string => mkdtempSync(join(tmpdir(), "dr-e1-cap-"));

describe("E1 T2:能力库 Port", () => {
  it("happy 2 问 → completed:findings 按 claimQuestions 归组,claims 带引句/来源/verified,usage 返回", async () => {
    const cap = createResearchCapability({ adapters: fakes(), dataDir: dataDir() });
    const { jobId } = cap.submit({
      questions: [
        { id: "q1", question: "市场规模", scopeNote: "仅中国大陆" },
        { id: "q2", question: "竞争格局" },
      ],
    });
    expect(jobId).toMatch(/^cap-/);
    const result = await waitTerminal(cap, jobId);
    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(2);
    const f1 = result.findings[0]!;
    expect(f1.questionId).toBe("q1");
    expect(f1.question).toContain("市场规模");
    expect(f1.answer).toBe("answered");
    // scopeNote 并入问题文本(G1-6)
    expect(f1.question).toContain("仅中国大陆");
    expect(f1.claims.length).toBeGreaterThanOrEqual(1);
    const claim = f1.claims[0]!;
    expect(claim.quote).toContain("市场规模");
    expect(claim.source?.url).toBe("https://a/1");
    expect(claim.source?.fetchedAt).toBeTruthy();
    expect(claim.verified).toBe("quote-hit");
    expect(claim.calibration?.unit).toBe("亿元");
    expect(result.usage.searches).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it("预算尽 → limited:部分 findings + unanswered 如实", async () => {
    const cap = createResearchCapability({ adapters: fakes(), dataDir: dataDir() });
    const { jobId } = cap.submit({
      questions: [
        { id: "q1", question: "市场规模" },
        { id: "q2", question: "门店数量" },
        { id: "q3", question: "竞争格局" },
      ],
      budget: { maxSearches: 1, maxFetches: 2 },
    });
    const result = await waitTerminal(cap, jobId);
    expect(result.status).toBe("limited");
    const answers = result.findings.map((f) => f.answer);
    expect(answers.some((a) => a === "unanswered")).toBe(true);
    expect(result.findings.some((f) => f.claims.length > 0)).toBe(true);
    expect(result.limitations.length).toBeGreaterThan(0);
  }, 20_000);

  it("运行中取消 → cancelled:已完成问 claims 级 findings 保留 + 取消 limitation(回调路径)", async () => {
    const adapters = fakes();
    let cancelNow: (() => void) | null = null;
    let fetchCount = 0;
    const originalFetch = adapters.page.fetch.bind(adapters.page);
    adapters.page.fetch = async (url: string, callKey: string) => {
      fetchCount += 1;
      if (fetchCount >= 2 && cancelNow) cancelNow(); // 第 2 问首个抓取时发取消信号(问边界后生效)
      return originalFetch(url, callKey);
    };
    const cap = createResearchCapability({ adapters, dataDir: dataDir() });
    const { jobId } = cap.submit({ questions: [{ id: "q1", question: "市场规模" }, { id: "q2", question: "竞争格局" }] });
    cancelNow = () => cap.cancel(jobId);
    const result = await waitTerminal(cap, jobId);
    expect(result.status).toBe("cancelled");
    expect(result.limitations.some((l) => l.includes("已取消"))).toBe(true);
    // 取消保留:q1(先完成问)有 claims;在途的 q2 按 G1-1 披露也可能完成(断言下限即可)
    const q1 = result.findings.find((f) => f.questionId === "q1");
    expect(q1?.claims.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(result.findings.every((f) => f.claims.every((c) => c.quote !== undefined))).toBe(true);
  }, 20_000);

  it("幂等键 → 同 jobId;重试换键 → 新 job;bad input 拒绝不产生 jobId", async () => {
    const cap = createResearchCapability({ adapters: fakes(), dataDir: dataDir() });
    const a = cap.submit({ questions: [{ id: "q1", question: "市场规模" }], idempotencyKey: "key-1" });
    const b = cap.submit({ questions: [{ id: "q1", question: "市场规模" }], idempotencyKey: "key-1" });
    expect(b.jobId).toBe(a.jobId);
    const c = cap.submit({ questions: [{ id: "q1", question: "市场规模" }], idempotencyKey: "key-2" });
    expect(c.jobId).not.toBe(a.jobId);
    await waitTerminal(cap, a.jobId);
    await waitTerminal(cap, c.jobId);

    expect(() => cap.submit({ questions: [] })).toThrow(/1~6/);
    expect(() => cap.submit({ questions: [{ id: "q1", question: "a" }, { id: "q1", question: "b" }] })).toThrow(/重复/);
    expect(() => cap.submit({ questions: [{ id: "", question: "a" }] })).toThrow(/不能为空/);
    expect(() =>
      cap.submit({ questions: [{ id: "q1", question: "a" }, { id: "q2", question: "b" }, { id: "q3", question: "c" }], tier: "low" }),
    ).toThrow(/low 档/);
    expect(() => cap.submit({ questions: Array.from({ length: 7 }, (_, i) => ({ id: `q${i}`, question: `x${i}` })) })).toThrow(/1~6/);
    // 显式 budget 免联动
    const explicit = cap.submit({ questions: Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, question: `x${i}` })), budget: { maxSearches: 10, maxFetches: 10 } });
    expect(explicit.jobId).toMatch(/^cap-/);
    await waitTerminal(cap, explicit.jobId);
  }, 40_000);

  it("并发上限:3 job maxConcurrentJobs=2 → 第三排队后起步;排队中取消即时终态", async () => {
    const adapters = fakes();
    const originalAgent = adapters.model.runAgent?.bind(adapters.model);
    if (!originalAgent) throw new Error("fakes 缺 runAgent");
    adapters.model.runAgent = async (input, tools, callKey) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return originalAgent(input, tools, callKey);
    };
    const cap = createResearchCapability({ adapters, dataDir: dataDir(), maxConcurrentJobs: 2 });
    const j1 = cap.submit({ questions: [{ id: "q1", question: "a1" }] });
    const j2 = cap.submit({ questions: [{ id: "q1", question: "a2" }] });
    const j3 = cap.submit({ questions: [{ id: "q1", question: "a3" }] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cap.status(j1.jobId).status).toBe("running");
    expect(cap.status(j2.jobId).status).toBe("running");
    expect(cap.status(j3.jobId).status).toBe("submitted");
    cap.cancel(j3.jobId);
    expect(cap.status(j3.jobId).status).toBe("cancelled");
    expect(cap.result(j3.jobId)?.limitations[0]).toContain("排队");
    const r1 = await waitTerminal(cap, j1.jobId);
    const r2 = await waitTerminal(cap, j2.jobId);
    expect(r1.status).toBe("completed");
    expect(r2.status).toBe("completed");
  }, 40_000);

  it("目录隔离 + 跨重启可读:cap- 前缀、capability-jobs 与 projects 兄弟、server 清扫/列表不触及、新实例可读终态", async () => {
    const root = dataDir();
    const cap = createResearchCapability({ adapters: fakes(), dataDir: root });
    const { jobId } = cap.submit({ questions: [{ id: "q1", question: "市场规模" }] });
    await waitTerminal(cap, jobId);
    // 目录形状
    const jobDirs = readdirSync(join(root, "capability-jobs"));
    expect(jobDirs.every((d) => d.startsWith("cap-"))).toBe(true);
    expect(existsSync(join(root, "projects"))).toBe(false);
    // 跨重启:同 dataDir 新实例读终态(G1-3)
    const cap2 = createResearchCapability({ adapters: fakes(), dataDir: root });
    expect(cap2.status(jobId).status).toBe("completed");
    const reread = cap2.result(jobId);
    expect(reread?.findings[0]?.questionId).toBe("q1");
    // server 不触及:同根起 server(含一个 capability"running"记录),清扫不改、列表不含
    const { startServer } = await import("../server/server.js");
    const runDir = join(root, "capability-jobs", jobId, "runs", `run-${jobId}`, "run.json");
    const runRecord = JSON.parse(readFileSync(runDir, "utf8")) as { status: string };
    const before = runRecord.status;
    const srv = await startServer({ dataDir: root, makeAdapters: () => fakes() });
    try {
      const list = (await (await fetch(`http://127.0.0.1:${srv.port}/api/projects`)).json()) as { projects: Array<{ id: string }> };
      expect(list.projects.some((p) => p.id.startsWith("cap-"))).toBe(false);
      const after = JSON.parse(readFileSync(runDir, "utf8")) as { status: string };
      expect(after.status).toBe(before);
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("装配校验:dataDir 落 projects 路径抛错;library 无 projectId 抛错", () => {
    const root = dataDir();
    const projectsPath = join(root, "projects");
    expect(() => createResearchCapability({ adapters: fakes(), dataDir: projectsPath })).toThrow(/projects/);
    expect(() =>
      createResearchCapability({ adapters: fakes(), dataDir: root, library: { dir: root } as never }),
    ).toThrow(/projectId/);
  });
});
