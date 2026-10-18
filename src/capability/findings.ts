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
  /** verified:quote-hit(全部证据引句命中)/ mismatch / unverified / no-evidence */
  verified: string;
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

  const verifiedOf = (claim: Claim): string => {
    if (claim.kind === "unverified") return "unverified";
    if (claim.evidenceIds.length === 0) return "no-evidence";
    return claim.evidenceIds.every((eid) => verdictByEvidence.get(eid) === "quote-hit") ? "quote-hit" : "mismatch";
  };

  const toFindingClaim = (claim: Claim): FindingClaim => {
    const evidence = claim.evidenceIds.map((eid) => evidenceById.get(eid)).find((e) => e !== undefined);
    const snapshot = evidence ? snapshotById.get(evidence.snapshotId) : undefined;
    return {
      statement: claim.statement,
      kind: claim.kind,
      ...(evidence?.quote ? { quote: evidence.quote } : {}),
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
