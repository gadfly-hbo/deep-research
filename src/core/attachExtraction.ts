import type { Claim, SourceSnapshot } from "../contracts.js";
import type { RunState } from "./runState.js";

/** extractClaims 的返回形状(采证装配只消费 claims 与 cost)。 */
export interface ExtractedClaims {
  claims: Array<{
    statement: string;
    kind: Claim["kind"];
    quote: string;
    calibration?: Claim["calibration"];
  }>;
  cost: number;
}

/**
 * gather 主循环的采证装配(P0-1 T8):同 id 快照就地替换、同 id 主张就地替换,
 * 证据一律追加(补采/重采前旧主张与旧证据已由编排器清掉)。
 * cost 累加、saveSnapshot/ingest 留调用点;返回本次挂接的主张数(供 q.status 判定)。
 */
export function attachGatherExtraction(
  state: RunState,
  snapshot: SourceSnapshot,
  extracted: ExtractedClaims,
  qid: string,
  versionId: string | undefined,
): number {
  const sIdx = state.snapshots.findIndex((s) => s.id === snapshot.id);
  if (sIdx >= 0) state.snapshots[sIdx] = snapshot;
  else state.snapshots.push(snapshot);
  let claimsForQ = 0;
  extracted.claims.forEach((c, ci) => {
    const claimId = `cl:${qid}:${snapshot.id}:${ci}`;
    const evidenceId = `ev:${qid}:${snapshot.id}:${ci}`;
    const claim: Claim = {
      id: claimId,
      statement: c.statement,
      kind: c.kind,
      evidenceIds: [evidenceId],
      calibration: c.calibration,
    };
    const cIdx = state.claims.findIndex((x) => x.id === claimId);
    if (cIdx >= 0) state.claims[cIdx] = claim;
    else state.claims.push(claim);
    state.evidence.push({
      id: evidenceId,
      snapshotId: snapshot.id,
      quote: c.quote,
      versionId,
      revision: 1,
      extractionCheck: "UNCHECKED",
    });
    state.claimQuestions[claimId] = qid;
    claimsForQ += 1;
  });
  return claimsForQ;
}

/** 非 gather 路径的装配范围:指令补充信源 / 用户附件 / 情报库复用。 */
export type AttachScope =
  | { kind: "question"; qid: string; infix: "" | "ins"; versionId: string | undefined }
  | { kind: "attachments"; versionId: string | undefined }
  | {
      kind: "reuse";
      bindingId: string;
      versionId: string;
      revisions: Record<string, number>;
      scopeNote: string | undefined;
    };

/**
 * 指令/附件/复用三条路径的采证装配(P0-1 T8):快照与主张一律 push(不替换),
 * 复用路径按 claimId 去重(同绑定重复装配跳过),并带 scopeNote 与绑定直连的
 * versionId/revision。cost 累加、state.snapshots 的 push 语义(无条件/缺席才推)
 * 各路径不同,留调用点。
 */
export function attachExtraction(
  state: RunState,
  snapshot: SourceSnapshot,
  extracted: ExtractedClaims,
  scope: AttachScope,
): void {
  extracted.claims.forEach((c, ci) => {
    let claimId: string;
    let evidenceId: string;
    let versionId: string | undefined;
    let revision: number;
    let scopeNote: string | undefined;
    if (scope.kind === "question") {
      claimId = `cl:${scope.qid}:${snapshot.id}:${scope.infix}${ci}`;
      evidenceId = `ev:${scope.qid}:${snapshot.id}:${scope.infix}${ci}`;
      versionId = scope.versionId;
      revision = 1;
    } else if (scope.kind === "attachments") {
      claimId = `cl:attachments:${snapshot.id}:${ci}`;
      evidenceId = `ev:attachments:${snapshot.id}:${ci}`;
      versionId = scope.versionId;
      revision = 1;
    } else {
      claimId = `cl:reuse:${scope.bindingId}:${ci}`;
      evidenceId = `ev:reuse:${scope.bindingId}:${ci}`;
      if (state.claims.some((x) => x.id === claimId)) return;
      versionId = scope.versionId;
      revision = scope.revisions[evidenceId] ?? 1;
      scopeNote = scope.scopeNote;
    }
    state.claims.push({
      id: claimId,
      statement: c.statement,
      kind: c.kind,
      evidenceIds: [evidenceId],
      calibration: c.calibration,
      ...(scopeNote !== undefined ? { scopeNote } : {}),
    });
    state.evidence.push({
      id: evidenceId,
      snapshotId: snapshot.id,
      quote: c.quote,
      versionId,
      revision,
      extractionCheck: "UNCHECKED",
      ...(scopeNote !== undefined ? { scopeNote } : {}),
    });
    state.claimQuestions[claimId] =
      scope.kind === "question" ? scope.qid : scope.kind === "attachments" ? "attachments" : "reuse";
  });
}
