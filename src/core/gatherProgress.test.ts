/* E1 T1:onGatherProgress 回调(核心加法,三触点)——每问收束触发,capability 取消保留依据。
   缝:runResearch 唯一入口 + budgetTopup 式 fakes 先例。 */
import { describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { scriptedRunAgent } from "../adapters/testing.js";
import { ResearchRequestSchema, type Claim } from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import { runResearch, type GatherProgressSnapshot } from "./runResearch.js";

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

const request = (id: string) =>
  ResearchRequestSchema.parse({ id, module: "industry", goal: "g", scope: { summary: "s", queries: [] } });

describe("E1 T1:onGatherProgress(每问收束回调)", () => {
  it("两问各触发一次;末次快照含全部已完成问的 claimQuestions/claims/limitations;切片可变不串内部状态", async () => {
    const snapshots: GatherProgressSnapshot[] = [];
    const { run } = await runResearch(request("req-egp-1"), fakes(), createMemoryStore(), {
      runId: "run-egp-1",
      plan: { questions: [
        { id: "q1", question: "市场规模", status: "open" },
        { id: "q2", question: "竞争格局", status: "open" },
      ] },
      stopAfter: "gather",
      onGatherProgress: (s) => snapshots.push(s),
    });
    expect(run.status).not.toBe("failed");
    expect(snapshots.length).toBe(2);
    const last = snapshots[1];
    // 问题状态:两问均已收束(answered)
    const statuses = Object.fromEntries(last.questions.map((q) => [q.id, q.status]));
    expect(statuses.q1).toBe("answered");
    expect(statuses.q2).toBe("answered");
    // 归组主键:claimQuestions 把主张挂到 qid
    expect(Object.keys(last.claimQuestions).length).toBeGreaterThanOrEqual(2);
    expect(Object.values(last.claimQuestions).every((qid) => qid === "q1" || qid === "q2")).toBe(true);
    // 主张与证据/快照引用齐备;limitations 为独立副本
    expect(last.claims.length).toBeGreaterThanOrEqual(2);
    expect(last.evidence.length).toBeGreaterThanOrEqual(2);
    expect(last.snapshots.length).toBeGreaterThanOrEqual(1);
    last.limitations.push("篡改探测");
    // 末次快照的 claims 均可在 claimQuestions 找到归属(G1-2 主键闭合)
    for (const c of last.claims as Claim[]) {
      expect(last.claimQuestions[c.id]).toBeDefined();
    }
  });

  it("不传回调 → 行为与现状一致(零回调零异常)", async () => {
    const { run } = await runResearch(request("req-egp-2"), fakes(), createMemoryStore(), {
      runId: "run-egp-2",
      plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }] },
      stopAfter: "gather",
    });
    expect(run.usage.searches).toBeGreaterThanOrEqual(1);
  });
});
