/**
 * E1(G1-2):findings 单一装配纯函数——completed/limited(bundle+gather checkpoint)与
 * cancelled(内存快照+现算 verdicts)两路共用同一口径;answer 判定/verified 聚合/
 * sharedClaims 规则只写一遍。纯函数,不触 IO。
 */
import type { Calibration, CitationVerdict, Claim, Evidence, SourceSnapshot } from "../contracts.js";

export interface FindingClaim {
  statement: string;
  kind: string;
  quote?: string;
  source?: { url: string; title: string; tier?: string; fetchedAt: string };
  calibration?: Calibration;
  /**
   * F5 口径细分(聚合该主张全部证据):
   * quote-hit=全部证据引句逐字命中;mismatch=存在未命中;snapshot-missing=存在快照缺失
   * (比 mismatch 更严重,无法核验);unverified=主张自身未验证;no-evidence=无证据绑定。
   * 展示用 quote/source 取首条 quote-hit 证据(无命中则取首条),与聚合判定对齐。
   */
  verified: "quote-hit" | "mismatch" | "snapshot-missing" | "unverified" | "no-evidence";
}

export interface QuestionFinding {
  questionId: string;
  question: string;
  answer: "answered" | "partial" | "unanswered";
  claims: FindingClaim[];
}

export interface AssembledFindings {
  findings: QuestionFinding[];
  /** 无 qid 归属的主张(附件/复用路径;v1 恒空,防御保留) */
  sharedClaims: FindingClaim[];
  limitations: string[];
  unresolved: string[];
}

export interface AssembleInput {
  questions: Array<{ id: string; question?: string; status?: string }>;
  claimQuestions: Record<string, string>;
  claims: Claim[];
  evidence: Evidence[];
  snapshots: SourceSnapshot[];
  verdicts: CitationVerdict[];
  limitations: string[];
  unresolved: string[];
}

const answerOf = (status: string | undefined): QuestionFinding["answer"] =>
  status === "answered" ? "answered" : status === "partially" ? "partial" : "unanswered";

export function assembleFindings(input: AssembleInput): AssembledFindings {
  const verdictByEvidence = new Map(input.verdicts.map((v) => [v.evidenceId, v.verdict]));
  const evidenceById = new Map(input.evidence.map((e) => [e.id, e]));
  const snapshotById = new Map(input.snapshots.map((s) => [s.id, s]));

  const verifiedOf = (claim: Claim): FindingClaim["verified"] => {
    if (claim.kind === "unverified") return "unverified";
    if (claim.evidenceIds.length === 0) return "no-evidence";
    const verdicts = claim.evidenceIds.map((eid) => verdictByEvidence.get(eid) ?? "snapshot-missing");
    if (verdicts.every((v) => v === "quote-hit")) return "quote-hit";
    if (verdicts.some((v) => v === "snapshot-missing")) return "snapshot-missing";
    return "mismatch";
  };

  const toFindingClaim = (claim: Claim): FindingClaim => {
    // F5:展示证据取首条 quote-hit(无命中取首条)——quote/source 与聚合判定同源,不错位
    const evidences = claim.evidenceIds.map((eid) => evidenceById.get(eid)).filter((e) => e !== undefined);
    const hitEvidence = evidences.find((e) => verdictByEvidence.get(e.id) === "quote-hit") ?? evidences[0];
    const snapshot = hitEvidence ? snapshotById.get(hitEvidence.snapshotId) : undefined;
    return {
      statement: claim.statement,
      kind: claim.kind,
      ...(hitEvidence?.quote ? { quote: hitEvidence.quote } : {}),
      ...(snapshot
        ? { source: { url: snapshot.url, title: snapshot.title, ...(snapshot.tier ? { tier: snapshot.tier } : {}), fetchedAt: snapshot.fetchedAt } }
        : {}),
      ...(claim.calibration ? { calibration: claim.calibration } : {}),
      verified: verifiedOf(claim),
    };
  };

  const byQuestion = new Map<string, FindingClaim[]>();
  const sharedClaims: FindingClaim[] = [];
  for (const claim of input.claims) {
    const qid = input.claimQuestions[claim.id];
    const finding = toFindingClaim(claim);
    if (qid === undefined) {
      sharedClaims.push(finding);
      continue;
    }
    const list = byQuestion.get(qid) ?? [];
    list.push(finding);
    byQuestion.set(qid, list);
  }

  const findings: QuestionFinding[] = input.questions.map((q) => ({
    questionId: q.id,
    question: q.question ?? "",
    answer: answerOf(q.status),
    claims: byQuestion.get(q.id) ?? [],
  }));

  return {
    findings,
    sharedClaims,
    limitations: [...input.limitations],
    unresolved: [...input.unresolved],
  };
}
