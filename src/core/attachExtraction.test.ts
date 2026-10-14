import { describe, expect, it } from "vitest";
import type { SourceSnapshot } from "../contracts.js";
import { attachExtraction, attachGatherExtraction, type ExtractedClaims } from "./attachExtraction.js";
import { emptyState } from "./runState.js";

const snapshot: SourceSnapshot = {
  id: "snap:https://a/1",
  url: "https://a/1",
  title: "t",
  bodyText: "b",
  parseStatus: "ok",
  contentType: "text/html",
  fetchedAt: "2026-10-15T00:00:00.000Z",
};

const extracted: ExtractedClaims = {
  claims: [
    { statement: "s0", kind: "fact", quote: "q0" },
    { statement: "s1", kind: "inference", quote: "q1" },
  ],
  cost: 0.5,
};

describe("attachGatherExtraction", () => {
  it("同 id 快照与主张就地替换,证据追加;返回主张数", () => {
    const state = emptyState();
    const n1 = attachGatherExtraction(state, snapshot, extracted, "q1", "v1");
    expect(n1).toBe(2);
    expect(state.snapshots).toHaveLength(1);
    expect(state.claims.map((c) => c.id)).toEqual([
      "cl:q1:snap:https://a/1:0",
      "cl:q1:snap:https://a/1:1",
    ]);
    expect(state.evidence.map((e) => e.id)).toEqual([
      "ev:q1:snap:https://a/1:0",
      "ev:q1:snap:https://a/1:1",
    ]);
    expect(state.evidence[0]).toMatchObject({ versionId: "v1", revision: 1, extractionCheck: "UNCHECKED" });
    expect(state.claimQuestions).toEqual({
      "cl:q1:snap:https://a/1:0": "q1",
      "cl:q1:snap:https://a/1:1": "q1",
    });

    // 再次装配:快照/主张替换不翻倍,证据继续追加
    const again = { ...extracted, claims: [{ statement: "s0b", kind: "fact" as const, quote: "q0b" }] };
    const n2 = attachGatherExtraction(state, snapshot, again, "q1", "v2");
    expect(n2).toBe(1);
    expect(state.snapshots).toHaveLength(1);
    expect(state.claims).toHaveLength(2);
    expect(state.claims[0].statement).toBe("s0b");
    expect(state.evidence).toHaveLength(3);
  });
});

describe("attachExtraction", () => {
  it("question 路径:ins 中缀进 id,claimQuestions=qid,versionId 透传", () => {
    const state = emptyState();
    attachExtraction(state, snapshot, extracted, { kind: "question", qid: "q2", infix: "ins", versionId: "v9" });
    expect(state.claims.map((c) => c.id)).toEqual([
      "cl:q2:snap:https://a/1:ins0",
      "cl:q2:snap:https://a/1:ins1",
    ]);
    expect(state.evidence[1]).toMatchObject({ versionId: "v9", revision: 1 });
    expect(state.claimQuestions["cl:q2:snap:https://a/1:ins0"]).toBe("q2");
    expect(state.claims[0].scopeNote).toBeUndefined();
  });

  it("attachments 路径:id 前缀与 claimQuestions=attachments", () => {
    const state = emptyState();
    attachExtraction(state, snapshot, extracted, { kind: "attachments", versionId: undefined });
    expect(state.claims.map((c) => c.id)).toEqual([
      "cl:attachments:snap:https://a/1:0",
      "cl:attachments:snap:https://a/1:1",
    ]);
    expect(state.evidence.map((e) => e.id)).toEqual([
      "ev:attachments:snap:https://a/1:0",
      "ev:attachments:snap:https://a/1:1",
    ]);
    expect(state.claimQuestions["cl:attachments:snap:https://a/1:1"]).toBe("attachments");
  });

  it("reuse 路径:claimId 去重跳过、scopeNote 双挂、versionId/revision 直连绑定", () => {
    const state = emptyState();
    const scope = {
      kind: "reuse" as const,
      bindingId: "b1",
      versionId: "ver1",
      revisions: { "ev:reuse:b1:1": 3 },
      scopeNote: "仅适用于样本内",
    };
    attachExtraction(state, snapshot, extracted, scope);
    expect(state.claims).toHaveLength(2);
    expect(state.claims[0].scopeNote).toBe("仅适用于样本内");
    expect(state.evidence[0]).toMatchObject({ versionId: "ver1", revision: 1, scopeNote: "仅适用于样本内" });
    expect(state.evidence[1].revision).toBe(3); // revisions 命中
    expect(state.claimQuestions["cl:reuse:b1:0"]).toBe("reuse");

    // 同绑定重复装配:全部被去重跳过
    attachExtraction(state, snapshot, extracted, scope);
    expect(state.claims).toHaveLength(2);
    expect(state.evidence).toHaveLength(2);
  });
});
