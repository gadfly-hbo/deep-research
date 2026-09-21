import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Adapters, FetchedPage } from "../adapters/types.js";
import { ResearchRequestSchema } from "../contracts.js";
import { createMemoryStore } from "../stores/memory.js";
import { runResearch } from "./runResearch.js";
import type { StageName } from "./stages.js";

const tmp = () => mkdtempSync(join(tmpdir(), "dr-att-"));

describe("附件参与采证", () => {
  it("本地文本附件被解析为快照,经模型抽取产生主张并进入成果包", async () => {
    const dir = tmp();
    const att = join(dir, "note.txt");
    writeFileSync(att, "内部纪要:某品牌 2025 年渠道费用率约 18%。");

    const adapters: Adapters = {
      search: { search: async () => [{ url: "https://a/1", title: "A", snippet: "" }] },
      page: {
        fetch: async (url): Promise<FetchedPage> => ({
          url,
          status: 200,
          contentType: "text/html",
          html: "<p>x</p>",
        }),
      },
      parser: {
        parse: async (page) => ({
          bodyText: page.text ?? "中国咖啡市场规模约 1,200 亿元(2025 年)。",
          parseStatus: "ok",
        }),
      },
      model: {
        extractClaims: async ({ snapshot }) =>
          snapshot.url.startsWith("file://")
            ? { claims: [{ statement: "渠道费用率约 18%(2025)", kind: "fact" as const, quote: "渠道费用率约 18%" }], cost: 0.01 }
            : { claims: [{ statement: "市场规模约 1200 亿元(2025)", kind: "fact" as const, quote: "市场规模约 1,200 亿元" }], cost: 0.01 },
        runStage: async (stage: StageName) =>
          stage === "analyze"
            ? { output: { findings: [], gaps: [] }, cost: 0.01 }
            : stage === "draft"
              ? { output: { reportMd: "# 报告\n\n## 市场口径表\n## 行业结构\n## 趋势与风险" }, cost: 0.01 }
              : { output: { issues: [], counterexampleChecked: true }, cost: 0.01 },
      },
    };

    const request = ResearchRequestSchema.parse({
      id: "req-att",
      module: "industry",
      goal: "中国咖啡行业研究",
      scope: { summary: "s", queries: [] },
      attachments: [att],
    });
    const { bundle } = await runResearch(request, adapters, createMemoryStore(), {
      plan: { questions: [{ id: "q1", question: "市场规模", status: "open" }] },
    });
    const attachmentClaim = bundle!.claims.find((c) => c.statement.includes("渠道费用率"));
    expect(attachmentClaim).toBeDefined();
    const attachmentEvidence = bundle!.evidence.find((e) => e.id === attachmentClaim!.evidenceIds[0]);
    const attachmentSnapshot = bundle!.snapshots.find((s) => s.id === attachmentEvidence!.snapshotId);
    expect(attachmentSnapshot!.url).toBe(`file://${att}`);
    expect(attachmentSnapshot!.parseStatus).toBe("ok");
    expect(bundle!.verdicts.find((v) => v.evidenceId === attachmentEvidence!.id)!.verdict).toBe("quote-hit");
  });
});
