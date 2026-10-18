/* E1 F5:findings 装配 verified 口径细分 + 展示证据对齐(纯函数单测)。
   缝:assembleFindings 直接驱动(不触 IO/runResearch)。 */
import { describe, expect, it } from "vitest";
import type { Claim, Evidence, SourceSnapshot } from "../contracts.js";
import { assembleFindings } from "./findings.js";

const snap = (id: string, body: string): SourceSnapshot => ({
  id, url: `https://a/${id}`, title: `T-${id}`, fetchedAt: "2026-10-18T00:00:00Z",
  bodyText: body, parseStatus: "ok", contentType: "text/html", tier: "A",
});
const ev = (id: string, sid: string, quote: string): Evidence => ({ id, snapshotId: sid, quote });
const claim = (id: string, evidenceIds: string[], kind: Claim["kind"] = "fact"): Claim => ({
  id, statement: `主张-${id}`, kind, evidenceIds,
});

describe("E1 F5:verified 口径细分与展示对齐", () => {
  const snapshots = [snap("s1", "市场规模约 1,200 亿元"), snap("s2", "口径完全不同的正文")];
  const evidence = [ev("e1", "s1", "市场规模约 1,200 亿元"), ev("e2", "s2", "不存在的引句")];
  // verdicts:e1=quote-hit,e2=quote-mismatch(verifyCitations 同义;此处直接构造)
  const verdicts = [
    { evidenceId: "e1", verdict: "quote-hit" as const },
    { evidenceId: "e2", verdict: "quote-mismatch" as const },
  ];

  it("全命中→quote-hit;混合→mismatch 且展示证据取首条命中(quote/source 与判定不错位)", () => {
    const allHit = assembleFindings({
      questions: [{ id: "q1", question: "市场规模", status: "answered" }],
      claimQuestions: { c1: "q1" },
      claims: [claim("c1", ["e1"])],
      evidence,
      snapshots,
      verdicts,
      limitations: [],
      unresolved: [],
    });
    expect(allHit.findings[0]!.claims[0]!.verified).toBe("quote-hit");
    expect(allHit.findings[0]!.claims[0]!.quote).toBe("市场规模约 1,200 亿元");
    expect(allHit.findings[0]!.claims[0]!.source?.url).toBe("https://a/s1");

    const mixed = assembleFindings({
      questions: [{ id: "q1", question: "q", status: "answered" }],
      claimQuestions: { c1: "q1" },
      // 顺序刻意让未命中证据在前:F5 规则仍应取首条命中的 e1 作展示
      claims: [claim("c1", ["e2", "e1"])],
      evidence,
      snapshots,
      verdicts,
      limitations: [],
      unresolved: [],
    });
    const c = mixed.findings[0]!.claims[0]!;
    expect(c.verified).toBe("mismatch");
    expect(c.quote).toBe("市场规模约 1,200 亿元"); // 展示取命中证据,非首条
    expect(c.source?.url).toBe("https://a/s1");
  });

  it("快照缺失 → snapshot-missing(比 mismatch 严重,单独口径);无证据→no-evidence;unverified→unverified", () => {
    const missing = assembleFindings({
      questions: [{ id: "q1", question: "q", status: "answered" }],
      claimQuestions: { c1: "q1", c2: "q1" },
      claims: [claim("c1", ["e1"]), claim("c2", [])],
      evidence: [ev("e1", "gone", "引句")],
      snapshots: [], // e1 的快照不在 → snapshot-missing
      verdicts: [{ evidenceId: "e1", verdict: "snapshot-missing" as const }],
      limitations: [],
      unresolved: [],
    });
    const [c1, c2] = missing.findings[0]!.claims;
    expect(c1!.verified).toBe("snapshot-missing");
    expect(c1!.source).toBeUndefined(); // 无快照即无来源展示
    expect(c2!.verified).toBe("no-evidence");

    const unverified = assembleFindings({
      questions: [{ id: "q1", question: "q", status: "answered" }],
      claimQuestions: { c1: "q1" },
      claims: [claim("c1", ["e1"], "unverified")],
      evidence, snapshots, verdicts, limitations: [], unresolved: [],
    });
    expect(unverified.findings[0]!.claims[0]!.verified).toBe("unverified");
  });

  it("无 qid 归属 → sharedClaims(防御桶);answer 判定 answered/partially/其余", () => {
    const out = assembleFindings({
      questions: [
        { id: "q1", question: "a", status: "answered" },
        { id: "q2", question: "b", status: "partially" },
        { id: "q3", question: "c", status: "open" },
      ],
      claimQuestions: {},
      claims: [claim("c9", ["e1"])],
      evidence, snapshots, verdicts, limitations: [], unresolved: [],
    });
    expect(out.sharedClaims).toHaveLength(1);
    expect(out.findings.map((f) => f.answer)).toEqual(["answered", "partial", "unanswered"]);
  });
});
