import type { Claim, Evidence, SourceSnapshot } from "../contracts.js";
import type { PlanQuestion } from "./stages.js";

/** 素材包预算(字)。全量快照正文实测 33k–157k 字/run,选择性注入是硬约束。 */
export interface EvidencePackBudget {
  /** 引句前后各保留的字数 */
  contextRadius?: number;
  /** 单快照 excerpt 上限 */
  maxPerSnapshot?: number;
  /** 单问题所有 excerpt 合计上限 */
  maxPerQuestion?: number;
  /** 全部问题合计上限(跨问题按引用次数全局优先淘汰) */
  maxTotal?: number;
}

export interface EvidenceNote {
  snapshotId: string;
  snapshotUrl: string;
  snapshotTitle: string;
  excerpt: string;
  /** 是否至少有一条逐字引句的完整上下文进入了 excerpt;未命中/被截掉为 false */
  verbatim: boolean;
  /** 该快照被几条不同主张引用(封顶淘汰时的优先级) */
  refCount: number;
}

export interface QuestionEvidencePack {
  questionId: string;
  question: string;
  notes: EvidenceNote[];
}

const DEFAULTS = {
  contextRadius: 400,
  maxPerSnapshot: 4000,
  maxPerQuestion: 8000,
  maxTotal: 40000,
};

const TRUNCATED = "…";
/** 非逐字命中(quote-mismatch)时的快照开头退化窗口 */
const MISS_HEAD_CHARS = 800;

interface QuoteSpan {
  start: number;
  end: number;
}

interface Interval {
  start: number;
  end: number;
  /** 命中的逐字引句在正文中的区间(用于截断后判定 verbatim) */
  quotes: QuoteSpan[];
}

interface SnapshotEntry {
  intervals: Interval[];
  claimIds: Set<string>;
}

/** claimQuestions 里非问题 id 的保留分组(附件/复用/base),标题回退 */
const FALLBACK_GROUP_TITLES: Record<string, string> = {
  base: "基准研究复用证据",
  attachments: "附件材料",
  reuse: "情报库复用资产",
};

/**
 * 按问题分组构建 writer 素材包:每条主张经证据定位来源快照,在正文里截取引句上下文窗口。
 * 纯函数,每次 draft/rephrase/polish 调用前从当前 state 现算(regather 后快照集已变,不缓存)。
 */
export function buildQuestionEvidencePacks(
  input: {
    questions: PlanQuestion[];
    claims: Claim[];
    evidence: Evidence[];
    snapshots: SourceSnapshot[];
    claimQuestions: Record<string, string>;
  },
  budget: EvidencePackBudget = {},
): QuestionEvidencePack[] {
  const { questions, claims, evidence, snapshots, claimQuestions } = input;
  const cfg = { ...DEFAULTS, ...budget };

  const snapshotById = new Map(snapshots.filter((s) => s.bodyText.trim()).map((s) => [s.id, s]));
  const evidenceById = new Map(evidence.map((e) => [e.id, e]));

  // questionId → snapshotId → entry
  const packs = new Map<string, Map<string, SnapshotEntry>>();
  const touch = (qid: string, sid: string): SnapshotEntry => {
    if (!packs.has(qid)) packs.set(qid, new Map());
    const q = packs.get(qid)!;
    if (!q.has(sid)) q.set(sid, { intervals: [], claimIds: new Set() });
    return q.get(sid)!;
  };

  for (const claim of claims) {
    const qid = claimQuestions[claim.id];
    if (!qid) continue;
    for (const eid of claim.evidenceIds) {
      const evItem = evidenceById.get(eid);
      if (!evItem) continue;
      const s = snapshotById.get(evItem.snapshotId);
      if (!s) continue;
      const entry = touch(qid, s.id);
      entry.claimIds.add(claim.id);
      const body = s.bodyText;
      const quote = evItem.quote;
      if (quote && body.includes(quote)) {
        const idx = body.indexOf(quote);
        entry.intervals.push({
          start: Math.max(0, idx - cfg.contextRadius),
          end: Math.min(body.length, idx + quote.length + cfg.contextRadius),
          quotes: [{ start: idx, end: idx + quote.length }],
        });
      } else {
        // 未逐字命中:退化为快照开头窗口,不带 quotes(verbatim 判定只看命中引句)
        entry.intervals.push({ start: 0, end: Math.min(body.length, MISS_HEAD_CHARS), quotes: [] });
      }
    }
  }

  /** 合并重叠窗口;拼接用 "\n…\n"(3 字),截断后逐字引句是否完整存活按文本坐标判定。 */
  const render = (
    entry: SnapshotEntry,
    body: string,
    cap: number,
  ): { text: string; verbatim: boolean } => {
    const sorted = [...entry.intervals].sort((a, b) => a.start - b.start);
    const merged: Interval[] = [];
    for (const iv of sorted) {
      const last = merged[merged.length - 1];
      if (last && iv.start <= last.end) {
        last.end = Math.max(last.end, iv.end);
        last.quotes.push(...iv.quotes);
      } else {
        merged.push({ start: iv.start, end: iv.end, quotes: [...iv.quotes] });
      }
    }
    let text = merged.map((iv) => body.slice(iv.start, iv.end)).join("\n…\n");
    const truncated = text.length > cap;
    if (truncated) {
      text = text.slice(0, cap - 1) + TRUNCATED;
    }
    // 第 i 段在文本坐标里的偏移 = 正文 start + 3i;完整存活要求 qEnd + 3i ≤ cap
    const verbatim = merged.some((iv, i) =>
      iv.quotes.some((q) => (truncated ? q.end + 3 * i <= cap : true)),
    );
    return { text, verbatim };
  };

  const questionTitle = new Map(questions.map((q) => [q.id, q.question]));
  // 问题按 plan 顺序;非问题分组(attachments/reuse/base 等)排后,全部发射不丢弃
  const orderedQids = [
    ...questions.map((q) => q.id),
    ...[...packs.keys()].filter((k) => !questionTitle.has(k)),
  ];
  const packsOut: QuestionEvidencePack[] = orderedQids.map((qid) => ({
    questionId: qid,
    question: questionTitle.get(qid) ?? FALLBACK_GROUP_TITLES[qid] ?? `其他分组 ${qid}`,
    notes: [...(packs.get(qid)?.entries() ?? [])]
      .map(([sid, entry]) => {
        const s = snapshotById.get(sid)!;
        const r = render(entry, s.bodyText, cfg.maxPerSnapshot);
        return r.text.trim()
          ? {
              snapshotId: sid,
              snapshotUrl: s.url,
              snapshotTitle: s.title,
              excerpt: r.text,
              verbatim: r.verbatim,
              refCount: entry.claimIds.size,
            }
          : null;
      })
      .filter((n): n is EvidenceNote => n !== null)
      .sort((a, b) => b.refCount - a.refCount),
  }));

  // 单问题封顶:引用次数优先,超限截断(严格不超过上限,省略号计入)
  for (const pack of packsOut) {
    let usedQ = 0;
    pack.notes = pack.notes.filter((note) => {
      const room = cfg.maxPerQuestion - usedQ;
      if (room <= 0) return false;
      if (note.excerpt.length > room) {
        note.excerpt = note.excerpt.slice(0, room - 1) + TRUNCATED;
      }
      usedQ += note.excerpt.length;
      return true;
    });
  }

  // 总量封顶:跨问题按引用次数全局优先淘汰(同分按既有顺序)
  const all = packsOut.flatMap((p) => p.notes.map((note) => ({ note })));
  const total = all.reduce((sum, x) => sum + x.note.excerpt.length, 0);
  if (total > cfg.maxTotal) {
    const ranked = [...all].sort((a, b) => b.note.refCount - a.note.refCount);
    const keep = new Set<EvidenceNote>();
    let left = cfg.maxTotal;
    for (const x of ranked) {
      // 放不下的整条丢弃:碎片 excerpt 对 writer 无意义,完整性优先于覆盖面
      if (x.note.excerpt.length <= left) {
        keep.add(x.note);
        left -= x.note.excerpt.length;
      }
    }
    for (const p of packsOut) p.notes = p.notes.filter((n) => keep.has(n));
  }

  return packsOut;
}
