/**
 * 多源交叉验证:
 * 1) 跨源合并——不同来源快照里出现的"同一事实"(同口径数值一致,或陈述高度相似)合并为一条主张,证据并集;
 * 2) 单源判定——带口径的关键数值主张若只有一个独立域名支撑,降级为推断并披露;
 *    叙述性事实单源不改类型(置信度降为 medium),避免摧毁正常抽取(一快照一主张是流水线常态)。
 */
import type { Claim, Evidence, SourceSnapshot } from "../contracts.js";
import { normalizeUnit } from "./calibrationChecker.js";
import { isYear, numericTokens } from "./entailment.js";

const norm = (s: string): string => s.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

function bigrams(text: string): Set<string> {
  const t = norm(text);
  const set = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 陈述中的数值签名(去千分位、豁免疫份):数值不同即冲突,绝不合并 */
function numSignature(statement: string): string {
  return numericTokens(statement)
    .filter((t) => !isYear(t))
    .sort()
    .join("|");
}

/** 同一事实判定:口径四元组一致(对象/期间/归一单位/数值±1%),或(数值一致前提下的)陈述二元组 Jaccard ≥ 0.65 */
function sameFact(a: Claim, b: Claim): boolean {
  const ca = a.calibration;
  const cb = b.calibration;
  if (ca && cb && typeof ca.value === "number" && typeof cb.value === "number") {
    if (
      norm(ca.entity) === norm(cb.entity) &&
      norm(ca.period) === norm(cb.period) &&
      normalizeUnit(ca.unit) === normalizeUnit(cb.unit)
    ) {
      const tol = Math.abs(ca.value) * 0.01 + 1e-9;
      if (Math.abs(ca.value - cb.value) <= tol) return true;
    }
  }
  const na = numSignature(a.statement);
  const nb = numSignature(b.statement);
  if ((na || nb) && na !== nb) return false; // 同题不同值是冲突事实,由口径/核查披露,不合并
  return jaccard(bigrams(a.statement), bigrams(b.statement)) >= 0.65;
}

/** 就地合并 fact 主张:被合并者的证据并入保留者,返回(可能变短的)主张数组。 */
export function mergeCrossSourceClaims(claims: Claim[]): Claim[] {
  const kept: Claim[] = [];
  for (const claim of claims) {
    if (claim.kind !== "fact") {
      kept.push(claim);
      continue;
    }
    const target = kept.find((k) => k.kind === "fact" && sameFact(k, claim));
    if (target) {
      for (const eid of claim.evidenceIds) if (!target.evidenceIds.includes(eid)) target.evidenceIds.push(eid);
    } else {
      kept.push(claim);
    }
  }
  return kept;
}

export interface MultiSourceResult {
  /** 带口径的关键数值主张中,仅单一域名支撑的(应降级为推断) */
  singleSourceCalibrated: string[];
  /** 叙述性事实中仅单一域名支撑的(不降级,置信度降 medium) */
  singleSourcePlain: string[];
}

export function checkMultiSource(
  claims: Claim[],
  evidence: Evidence[],
  snapshots: SourceSnapshot[],
  hitEvidenceIds: Set<string>,
): MultiSourceResult {
  const domainByEvidence = new Map<string, string>();
  const snapById = new Map(snapshots.map((s) => [s.id, s]));
  for (const ev of evidence) {
    const url = snapById.get(ev.snapshotId)?.url ?? "";
    try {
      domainByEvidence.set(ev.id, new URL(url).hostname.replace(/^www\./, ""));
    } catch {
      domainByEvidence.set(ev.id, url);
    }
  }
  const singleSourceCalibrated: string[] = [];
  const singleSourcePlain: string[] = [];
  for (const claim of claims) {
    if (claim.kind !== "fact") continue;
    const domains = new Set(
      claim.evidenceIds.filter((eid) => hitEvidenceIds.has(eid)).map((eid) => domainByEvidence.get(eid) ?? ""),
    );
    if (domains.size >= 2) continue;
    if (claim.calibration && typeof claim.calibration.value === "number") singleSourceCalibrated.push(claim.id);
    else singleSourcePlain.push(claim.id);
  }
  return { singleSourceCalibrated, singleSourcePlain };
}
