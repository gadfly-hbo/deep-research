import { describe, expect, it } from "vitest";
import type { Evidence, SourceSnapshot } from "../contracts.js";
import { verifyCitations } from "./citationVerifier.js";

const snapshot = (id: string, bodyText: string): SourceSnapshot => ({
  id,
  url: `https://example.com/${id}`,
  title: `来源 ${id}`,
  fetchedAt: "2026-09-21T00:00:00.000Z",
  bodyText,
  parseStatus: "ok",
  contentType: "text/html",
});

const evidence = (id: string, snapshotId: string, quote: string): Evidence => ({
  id,
  snapshotId,
  quote,
});

describe("verifyCitations", () => {
  const snapshots = [
    snapshot("s1", "中国咖啡市场规模约 1,200 亿元(2025 年,含现磨与即饮)。现磨咖啡占比过半。"),
  ];

  it("引句在快照原文中命中 → quote-hit", () => {
    const verdicts = verifyCitations(
      [evidence("e1", "s1", "市场规模约 1,200 亿元")],
      snapshots,
    );
    expect(verdicts).toEqual([{ evidenceId: "e1", verdict: "quote-hit" }]);
  });

  it("引句与原文不符 → quote-mismatch(不放过编造引用)", () => {
    const verdicts = verifyCitations(
      [evidence("e2", "s1", "市场规模约 2,000 亿元")],
      snapshots,
    );
    expect(verdicts).toEqual([{ evidenceId: "e2", verdict: "quote-mismatch" }]);
  });

  it("快照缺失 → snapshot-missing", () => {
    const verdicts = verifyCitations(
      [evidence("e3", "s-nope", "任意引句")],
      snapshots,
    );
    expect(verdicts).toEqual([{ evidenceId: "e3", verdict: "snapshot-missing" }]);
  });

  it("空白差异不影响命中(换行/多空格归一化)", () => {
    const verdicts = verifyCitations(
      [evidence("e4", "s1", "市场规模约   1,200 亿元\n(2025 年,含现磨与即饮)。")],
      snapshots,
    );
    expect(verdicts).toEqual([{ evidenceId: "e4", verdict: "quote-hit" }]);
  });

  it("空引句无法定位 → quote-mismatch", () => {
    const verdicts = verifyCitations([evidence("e5", "s1", "")], snapshots);
    expect(verdicts).toEqual([{ evidenceId: "e5", verdict: "quote-mismatch" }]);
  });
});
