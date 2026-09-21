import { describe, expect, it } from "vitest";
import type { CitationVerdict } from "../contracts.js";
import { buildSpikeReport, type SpikeQuestionResult } from "./spikeReport.js";

const v = (verdict: CitationVerdict["verdict"]): CitationVerdict => ({
  evidenceId: "e",
  verdict,
});

const q = (
  question: string,
  verdicts: CitationVerdict[],
  fetched: number,
  parsedOk: number,
): SpikeQuestionResult => ({ question, verdicts, fetched, parsedOk, costEstimate: 0.05, wallMs: 100 });

describe("buildSpikeReport", () => {
  it("逐问题与总体计算可验证率/可达率,并触发 kill 判据", () => {
    const report = buildSpikeReport([
      q("q1", [v("quote-hit"), v("quote-hit"), v("quote-mismatch"), v("snapshot-missing")], 4, 2),
      q("q2", [v("quote-hit"), v("quote-hit"), v("quote-hit"), v("quote-hit")], 2, 2),
    ]);
    expect(report.questions[0].verifiability).toBeCloseTo(0.5);
    expect(report.questions[0].reachability).toBeCloseTo(0.5);
    expect(report.questions[1].verifiability).toBe(1);
    expect(report.overallVerifiability).toBeCloseTo(0.75);
    expect(report.overallReachability).toBeCloseTo(4 / 6);
    expect(report.killCriteriaTriggered).toBe(true);
  });

  it("全部命中且来源全可达时不触发 kill 判据", () => {
    const report = buildSpikeReport([q("q1", [v("quote-hit"), v("quote-hit")], 2, 2)]);
    expect(report.overallVerifiability).toBe(1);
    expect(report.overallReachability).toBe(1);
    expect(report.killCriteriaTriggered).toBe(false);
  });

  it("无判定/无抓取的问题按 0 计,不产生 NaN", () => {
    const report = buildSpikeReport([q("q1", [], 0, 0)]);
    expect(report.questions[0].verifiability).toBe(0);
    expect(report.questions[0].reachability).toBe(0);
    expect(report.killCriteriaTriggered).toBe(true);
  });
});
