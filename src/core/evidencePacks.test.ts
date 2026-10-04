import { describe, expect, it } from "vitest";
import type { Claim, Evidence, SourceSnapshot } from "../contracts.js";
import { buildQuestionEvidencePacks } from "./evidencePacks.js";

const snap = (id: string, bodyText: string): SourceSnapshot => ({
  id,
  url: `https://example.com/${id}`,
  title: `标题-${id}`,
  fetchedAt: "2026-10-04T00:00:00Z",
  bodyText,
  parseStatus: "ok",
  contentType: "text/html",
});

const ev = (id: string, snapshotId: string, quote: string): Evidence => ({
  id,
  snapshotId,
  quote,
});

const claim = (id: string, evidenceIds: string[]): Claim => ({
  id,
  statement: `主张-${id}`,
  kind: "fact",
  evidenceIds,
});

const question = (id: string) => ({ id, question: `问题-${id}`, status: "open" as const });

describe("buildQuestionEvidencePacks(按问题分组的引句上下文素材包)", () => {
  it("quote 命中快照正文 → 截取引句前后窗口且逐字命中", () => {
    const quote = "锚点句,关键数据在此。";
    const body = `${"前".repeat(500)}${quote}${"后".repeat(500)}`;
    const packs = buildQuestionEvidencePacks(
      {
        questions: [question("q1")],
        claims: [claim("cl:q1:snap:u:0", ["ev:1"])],
        evidence: [ev("ev:1", "snap:u", quote)],
        snapshots: [snap("snap:u", body)],
        claimQuestions: { "cl:q1:snap:u:0": "q1" },
      },
      { contextRadius: 50 },
    );
    expect(packs).toHaveLength(1);
    expect(packs[0].questionId).toBe("q1");
    expect(packs[0].notes).toHaveLength(1);
    const note = packs[0].notes[0];
    expect(note.snapshotId).toBe("snap:u");
    expect(note.verbatim).toBe(true);
    expect(note.excerpt).toContain(quote);
    // 窗口 = 前 50 + 引句 + 后 50,不得超出
    expect(note.excerpt.length).toBeLessThanOrEqual(quote.length + 100);
    expect(note.excerpt.startsWith("前")).toBe(true);
  });

  it("同一快照多个引句窗口重叠 → 合并为一个 excerpt", () => {
    const q1 = "第一个锚点。";
    const q2 = "第二个锚点。";
    const gap = "间".repeat(60);
    const body = `${"前".repeat(300)}${q1}${gap}${q2}${"后".repeat(300)}`;
    const packs = buildQuestionEvidencePacks(
      {
        questions: [question("q1")],
        claims: [claim("c1", ["e1"]), claim("c2", ["e2"])],
        evidence: [ev("e1", "snap:u", q1), ev("e2", "snap:u", q2)],
        snapshots: [snap("snap:u", body)],
        claimQuestions: { c1: "q1", c2: "q1" },
      },
      { contextRadius: 100 },
    );
    expect(packs[0].notes).toHaveLength(1);
    expect(packs[0].notes[0].excerpt).toContain(q1);
    expect(packs[0].notes[0].excerpt).toContain(q2);
  });

  it("合并后超出单快照上限 → 截断并带省略标记", () => {
    const q1 = "锚甲。";
    const q2 = "锚乙。";
    // 两个锚点相距 4000 字,半径 100 → 合并窗口远超上限
    const body = `${q1}${"填".repeat(4000)}${q2}`;
    const packs = buildQuestionEvidencePacks(
      {
        questions: [question("q1")],
        claims: [claim("c1", ["e1"]), claim("c2", ["e2"])],
        evidence: [ev("e1", "snap:u", q1), ev("e2", "snap:u", q2)],
        snapshots: [snap("snap:u", body)],
        claimQuestions: { c1: "q1", c2: "q1" },
      },
      { contextRadius: 100, maxPerSnapshot: 100 },
    );
    const excerpt = packs[0].notes[0].excerpt;
    // 两锚点窗口拼接后 ~215 字,超出上限 100 → 截断带省略号
    expect(excerpt.length).toBeLessThanOrEqual(101); // 100 + 省略号
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).toContain(q1);
  });

  it("超出单问题上限 → 引用次数多的快照优先保留,其余丢弃", () => {
    const bodyA = "甲".repeat(600);
    const bodyB = "乙".repeat(600);
    const packs = buildQuestionEvidencePacks(
      {
        questions: [question("q1")],
        claims: [
          claim("c1", ["e1"]),
          claim("c2", ["e2"]),
          claim("c3", ["e3"]),
          claim("c4", ["e4"]),
        ],
        // snap:u 被 3 条主张引用,snap:v 仅 1 条
        evidence: [
          ev("e1", "snap:u", "锚甲一。"),
          ev("e2", "snap:u", "锚甲二。"),
          ev("e3", "snap:u", "锚甲三。"),
          ev("e4", "snap:v", "锚乙。"),
        ],
        snapshots: [snap("snap:u", bodyA), snap("snap:v", bodyB)],
        claimQuestions: { c1: "q1", c2: "q1", c3: "q1", c4: "q1" },
      },
      { maxPerQuestion: 600 },
    );
    const ids = packs[0].notes.map((n) => n.snapshotId);
    expect(ids).toEqual(["snap:u"]); // 高引用保留,低引用丢弃
  });

  it("超出总量上限 → 靠后问题的素材包为空", () => {
    const mk = (qid: string, sid: string) => ({
      claims: [claim(`c-${qid}`, [`e-${qid}`])],
      evidence: [ev(`e-${qid}`, sid, "锚。")],
      snapshots: [snap(sid, `${qid}素材`.repeat(300))],
      claimQuestions: { [`c-${qid}`]: qid },
    });
    const a = mk("q1", "snap:a");
    const b = mk("q2", "snap:b");
    const packs = buildQuestionEvidencePacks(
      {
        questions: [question("q1"), question("q2")],
        claims: [...a.claims, ...b.claims],
        evidence: [...a.evidence, ...b.evidence],
        snapshots: [...a.snapshots, ...b.snapshots],
        claimQuestions: { ...a.claimQuestions, ...b.claimQuestions },
      },
      { maxTotal: 1000 },
    );
    expect(packs.find((p) => p.questionId === "q1")!.notes.length).toBeGreaterThan(0);
    expect(packs.find((p) => p.questionId === "q2")!.notes).toHaveLength(0);
  });

  it("quote 未在正文中命中 → 退化为快照开头截断段且不标逐字命中", () => {
    const body = "正文开头的内容。".repeat(100);
    const packs = buildQuestionEvidencePacks(
      {
        questions: [question("q1")],
        claims: [claim("c1", ["e1"])],
        evidence: [ev("e1", "snap:u", "正文里不存在的句子")],
        snapshots: [snap("snap:u", body)],
        claimQuestions: { c1: "q1" },
      },
      { maxPerSnapshot: 100 },
    );
    const note = packs[0].notes[0];
    expect(note.verbatim).toBe(false);
    expect(note.excerpt.startsWith("正文开头的内容。")).toBe(true);
    expect(note.excerpt.length).toBeLessThanOrEqual(101);
  });

  it("基准复用主张(claimQuestions=base)→ 归入 base 素材包", () => {
    const packs = buildQuestionEvidencePacks(
      {
        questions: [question("q1")],
        claims: [claim("c-base", ["e1"])],
        evidence: [ev("e1", "snap:u", "锚。")],
        snapshots: [snap("snap:u", "基准素材内容。".repeat(50))],
        claimQuestions: { "c-base": "base" },
      },
    );
    const basePack = packs.find((p) => p.questionId === "base");
    expect(basePack).toBeDefined();
    expect(basePack!.notes).toHaveLength(1);
  });

  it("证据指向缺失快照 → 跳过该条不抛错", () => {
    const packs = buildQuestionEvidencePacks(
      {
        questions: [question("q1")],
        claims: [claim("c1", ["e1"]), claim("c2", ["e2"])],
        evidence: [ev("e1", "snap:不存在", "锚。"), ev("e2", "snap:u", "锚。")],
        snapshots: [snap("snap:u", "可用素材。".repeat(20))],
        claimQuestions: { c1: "q1", c2: "q1" },
      },
    );
    expect(packs[0].notes).toHaveLength(1);
    expect(packs[0].notes[0].snapshotId).toBe("snap:u");
  });
});

describe("buildQuestionEvidencePacks 审查修复回归", () => {
  it("attachments/reuse 分组全部发射,带回退标题", () => {
    const packs = buildQuestionEvidencePacks(
      {
        questions: [question("q1")],
        claims: [claim("c1", ["e1"]), claim("c2", ["e2"])],
        evidence: [ev("e1", "snap:a", "锚。"), ev("e2", "snap:b", "锚。")],
        snapshots: [snap("snap:a", "附件原文。".repeat(50)), snap("snap:b", "复用资产原文。".repeat(50))],
        claimQuestions: { c1: "attachments", c2: "reuse" },
      },
    );
    const att = packs.find((p) => p.questionId === "attachments");
    const reuse = packs.find((p) => p.questionId === "reuse");
    expect(att?.question).toBe("附件材料");
    expect(att?.notes).toHaveLength(1);
    expect(reuse?.question).toBe("情报库复用资产");
    expect(reuse?.notes).toHaveLength(1);
  });

  it("逐字引句被单快照截断裁掉 → verbatim=false", () => {
    const quote = "远处在后面的锚点。";
    // 开头有一个未命中引句(退化窗口 800 字),命中引句在 5000 字处,上限 1000
    const body = `${"填".repeat(5000)}${quote}`;
    const packs = buildQuestionEvidencePacks(
      {
        questions: [question("q1")],
        claims: [claim("c1", ["e1"]), claim("c2", ["e2"])],
        evidence: [ev("e1", "snap:u", "不存在的引句"), ev("e2", "snap:u", quote)],
        snapshots: [snap("snap:u", body)],
        claimQuestions: { c1: "q1", c2: "q1" },
      },
      { maxPerSnapshot: 1000 },
    );
    const note = packs[0].notes[0];
    expect(note.excerpt.length).toBeLessThanOrEqual(1000);
    expect(note.excerpt).not.toContain(quote);
    expect(note.verbatim).toBe(false);
  });

  it("refCount 按不同主张去重:一条主张两条证据指向同快照计 1", () => {
    const packs = buildQuestionEvidencePacks(
      {
        questions: [question("q1")],
        claims: [claim("c1", ["e1", "e2"])],
        evidence: [ev("e1", "snap:u", "锚甲。"), ev("e2", "snap:u", "锚乙。")],
        snapshots: [snap("snap:u", "锚甲。中间内容。锚乙。".repeat(30))],
        claimQuestions: { c1: "q1" },
      },
    );
    expect(packs[0].notes[0].refCount).toBe(1);
  });

  it("总量封顶跨问题按引用次数全局优先", () => {
    const mk = (qid: string, sid: string, refs: number) => ({
      claims: Array.from({ length: refs }, (_, i) => claim(`${qid}-c${i}`, [`${qid}-e${i}`])),
      evidence: Array.from({ length: refs }, (_, i) => ev(`${qid}-e${i}`, sid, "锚。")),
      snapshots: [snap(sid, `${qid}素材内容。`.repeat(150))], // ~1350 字
      claimQuestions: Object.fromEntries(Array.from({ length: refs }, (_, i) => [`${qid}-c${i}`, qid])),
    });
    const a = mk("q1", "snap:a", 1);
    const b = mk("q2", "snap:b", 3);
    const packs = buildQuestionEvidencePacks(
      {
        questions: [question("q1"), question("q2")],
        claims: [...a.claims, ...b.claims],
        evidence: [...a.evidence, ...b.evidence],
        snapshots: [...a.snapshots, ...b.snapshots],
        claimQuestions: { ...a.claimQuestions, ...b.claimQuestions },
      },
      { maxTotal: 1500 },
    );
    const q1 = packs.find((p) => p.questionId === "q1")!;
    const q2 = packs.find((p) => p.questionId === "q2")!;
    expect(q2.notes[0].excerpt).not.toContain("…"); // 高引用完整保留
    expect(q2.notes[0].refCount).toBe(3);
    expect(q1.notes).toHaveLength(0); // 低引用整条丢弃,不留碎片
  });
});
