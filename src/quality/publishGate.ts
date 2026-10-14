/**
 * 发布门禁(P0-1 T5 自 runResearch 内联段逐位搬移):
 * 引用核查 → 语义蕴涵/数值复算扩展判定 → 硬降级 → 多源交叉 → 信源分级 → 置信度聚合
 * → unresolved 归纳 → 发布原因 → 模块专项核查 → 报告组装。
 * 纯函数:不感知取消/预算/存储。突变说明:输出 claims 数组与输入共享对象
 * (mergeCrossSourceClaims 就地并证据、降级/置信度就地改写字段),调用方写回后不得复用输入 claims;
 * 单测请先 structuredClone 夹具输入。reportMd 为完整成品(含 ## 限制 段);
 * `stopAfter:"gather"` 早退路径不经过本函数(语义不同,勿统一)。
 */
import type { Claim, CitationVerdict, Evidence, SourceSnapshot } from "../contracts.js";
import { addLimitation } from "../core/limitations.js";
import type { PlanQuestion } from "../core/stages.js";
import type { ModuleConfig } from "../modules/types.js";
import { checkCalibration, type CalibrationConflict } from "./calibrationChecker.js";
import { verifyCitations } from "./citationVerifier.js";
import { checkEntailment } from "./entailment.js";
import { checkModuleOutput } from "./moduleCheck.js";
import { checkMultiSource, mergeCrossSourceClaims } from "./multiSource.js";
import { checkNumericConsistency } from "./numericVerifier.js";

const QUESTION_STATUS_LABEL: Record<PlanQuestion["status"], string> = {
  open: "未开始",
  answered: "已回答",
  partially: "部分回答",
  unanswered: "未回答",
  skipped: "已跳过",
};

export interface PublishGateInput {
  claims: Claim[];
  evidence: Evidence[];
  snapshots: SourceSnapshot[];
  questions: PlanQuestion[];
  /** claim.id → 归属问题 id;"base" 标记基准复用主张(报告标注用) */
  claimQuestions: Record<string, string>;
  draftMd: string | null;
  capped: boolean;
  counterexampleChecked: boolean;
  /** 既有 limitations(有序);输出 reportMd 的限制段 = 该数组 + limitationsToAppend */
  limitations: string[];
  goal: string;
  moduleConfig: ModuleConfig;
  /** 增量研究标注(2.1);缺省=非增量 */
  incremental?: {
    baseRunId: string;
    reusedSnapshots: number;
    reusedEvidence: number;
    reusedClaims: number;
    newQuestions: number;
  };
}

export interface PublishGateOutput {
  /** merge 后新数组(含 kind/confidence 突变,与输入共享对象) */
  claims: Claim[];
  /** 扩展判定(带 entailment/numeric/tier) */
  verdicts: CitationVerdict[];
  /** 需追加到 state.limitations 的有序条目(五条降级披露 + reasons 去重) */
  limitationsToAppend: string[];
  unresolved: string[];
  reasons: string[];
  /** 完整成品(草稿 + 增量注记 + 口径冲突披露 + 主张判定 + 未解决问题 + 限制) */
  reportMd: string;
  status: "limited" | "published";
}

export function evaluatePublishGate(input: PublishGateInput): PublishGateOutput {
  // 跨源合并:不同来源里出现的同一事实(口径一致/高相似)合并证据,多源判定才有意义
  const claims = mergeCrossSourceClaims(input.claims);
  const baseVerdicts = verifyCitations(input.evidence, input.snapshots);
  const evidenceById = new Map(input.evidence.map((e) => [e.id, e]));
  const snapById = new Map(input.snapshots.map((s) => [s.id, s]));
  const claimByEvidence = new Map<string, Claim>();
  for (const c of claims) for (const eid of c.evidenceIds) claimByEvidence.set(eid, c);

  // 扩展判定:引句命中的证据再过语义蕴涵与数值复算;快照信源等级随判定落档
  const verdicts: CitationVerdict[] = baseVerdicts.map((v) => {
    const ev = evidenceById.get(v.evidenceId);
    const claim = ev ? claimByEvidence.get(ev.id) : undefined;
    const hit = v.verdict === "quote-hit";
    return {
      ...v,
      entailment: hit && ev && claim ? checkEntailment(claim.statement, ev.quote) : ("na" as const),
      numeric: hit && ev && claim ? checkNumericConsistency(claim, ev.quote) : ("na" as const),
      tier: ev ? snapById.get(ev.snapshotId)?.tier : undefined,
    };
  });
  const verdictById = new Map(verdicts.map((v) => [v.evidenceId, v]));
  const conflicts = checkCalibration(claims);
  const originalFactIds = new Set(claims.filter((c) => c.kind === "fact").map((c) => c.id));
  const factHit = claims.filter(
    (c) =>
      originalFactIds.has(c.id) && c.evidenceIds.every((eid) => verdictById.get(eid)?.verdict === "quote-hit"),
  ).length;
  const hitRate = originalFactIds.size > 0 ? factHit / originalFactIds.size : 1;

  // 硬降级:引句未命中 / 转述不被引句支撑 / 数值与引句不一致
  const demoted: string[] = [];
  const demotedEntail: string[] = [];
  const demotedNumeric: string[] = [];
  for (const claim of claims) {
    if (!originalFactIds.has(claim.id)) continue;
    const vs = claim.evidenceIds.map((eid) => verdictById.get(eid));
    if (!vs.every((v) => v?.verdict === "quote-hit")) {
      claim.kind = "unverified";
      demoted.push(claim.id);
      continue;
    }
    // 蕴涵与数值复算独立记录:同一主张可能同时失败,披露全部原因
    let hardFailed = false;
    if (vs.some((v) => v?.entailment === "fail")) {
      demotedEntail.push(claim.id);
      hardFailed = true;
    }
    if (vs.some((v) => v?.numeric === "mismatch")) {
      demotedNumeric.push(claim.id);
      hardFailed = true;
    }
    if (hardFailed) claim.kind = "unverified";
  }
  // 多源交叉:带口径的关键数值主张须 ≥2 个独立域名引句命中,否则降级为推断;叙述性事实单源不降类型(置信度降 medium)
  const hitEvidenceIds = new Set(verdicts.filter((v) => v.verdict === "quote-hit").map((v) => v.evidenceId));
  const multi = checkMultiSource(claims, input.evidence, input.snapshots, hitEvidenceIds);
  const singleSource: string[] = [];
  for (const id of multi.singleSourceCalibrated) {
    const claim = claims.find((c) => c.id === id);
    if (claim && originalFactIds.has(id) && claim.kind === "fact") {
      claim.kind = "inference";
      singleSource.push(id);
    }
  }
  const singleSourcePlain = new Set(multi.singleSourcePlain);
  // 信源分级:仅 C 级信源支撑的主张不降级但置信度记低并披露
  const tierCOnly: string[] = [];
  for (const claim of claims) {
    if (claim.kind === "unverified") continue;
    const tiers = claim.evidenceIds
      .map((eid) => snapById.get(evidenceById.get(eid)?.snapshotId ?? "")?.tier)
      .filter((t): t is "A" | "B" | "C" => t !== undefined);
    if (tiers.length > 0 && tiers.every((t) => t === "C")) tierCOnly.push(claim.id);
  }
  const limitationsToAppend: string[] = [];
  if (demoted.length > 0) limitationsToAppend.push(`以下主张引用核查未通过,已降级为未验证:${demoted.join("、")}`);
  if (demotedEntail.length > 0) limitationsToAppend.push(`以下主张的引句不支持其转述(语义蕴涵未通过),已降级为未验证:${demotedEntail.join("、")}`);
  if (demotedNumeric.length > 0) limitationsToAppend.push(`以下主张数值与引句不一致(数值复算未通过),已降级为未验证:${demotedNumeric.join("、")}`);
  if (singleSource.length > 0) limitationsToAppend.push(`以下主张仅单一来源支撑,已降级为推断(需交叉验证):${singleSource.join("、")}`);
  if (tierCOnly.length > 0) limitationsToAppend.push(`以下主张仅有 C 级信源(社媒/自媒体/未知来源)支撑,置信度低:${tierCOnly.join("、")}`);

  // 置信度聚合:核查全过 + 多源 + A/B 级信源 = high;单源/弱核查 = medium;降级/仅C级 = low
  for (const claim of claims) {
    const vs = claim.evidenceIds.map((eid) => verdictById.get(eid));
    if (claim.kind === "unverified") {
      claim.confidence = "low";
    } else if (claim.kind === "inference") {
      claim.confidence = vs.some((v) => v?.entailment === "weak" || v?.numeric === "mismatch") ? "low" : "medium";
    } else {
      const weak = vs.some((v) => v?.entailment === "weak");
      claim.confidence = tierCOnly.includes(claim.id) ? "low" : weak || singleSourcePlain.has(claim.id) ? "medium" : "high";
    }
  }

  const unresolved = input.questions
    .filter((q) => q.status !== "answered")
    .map((q) => `${q.question}(${QUESTION_STATUS_LABEL[q.status]})`);

  const reasons: string[] = [];
  const hardDemoted = demoted.length + demotedEntail.length + demotedNumeric.length;
  if (input.capped) reasons.push("预算上限到达,部分采证未完成");
  if (hardDemoted > 0) reasons.push("存在引用/蕴涵/数值核查未通过的关键结论");
  if (hitRate < 0.8) reasons.push(`关键主张引句命中率 ${(hitRate * 100).toFixed(0)}% 低于 80%`);
  if (!input.counterexampleChecked && !input.capped) reasons.push("反例检查未完成");

  const conflictLine = (c: CalibrationConflict): string =>
    c.kind === "unit-mix"
      ? `- 口径混用:${c.entity}(${c.period})出现多种单位:${c.units.join(" / ")}(主张 ${c.claimIds.join("、")})`
      : `- 数值冲突:${c.entity}(${c.period})同口径不同数值:${c.values.map((v) => `${v.claimId}=${v.value}${v.unit}`).join(",")}`;

  const evLabel = (eid: string): string => {
    const v = verdictById.get(eid);
    if (!v) return "snapshot-missing";
    const extras = [
      v.entailment && v.entailment !== "na" ? `蕴涵:${v.entailment}` : "",
      v.numeric && v.numeric !== "na" ? `数值:${v.numeric}` : "",
      v.tier ? `${v.tier}级信源` : "",
    ].filter(Boolean);
    return extras.length ? `${v.verdict}(${extras.join(",")})` : v.verdict;
  };

  const claimMark = (claim: Claim): string =>
    input.claimQuestions[claim.id] === "base" ? "|基准复用" : "";

  const baseReportMd = [
    input.draftMd ?? `# ${input.goal}\n\n(草稿缺失:${reasons.join(";") || "采证不足"})`,
    ...(input.incremental
      ? [
          "",
          `> 增量研究:基于 ${input.incremental.baseRunId} 追问扩展;复用快照 ${input.incremental.reusedSnapshots} / 证据 ${input.incremental.reusedEvidence} / 主张 ${input.incremental.reusedClaims},本次新问 ${input.incremental.newQuestions}`,
        ]
      : []),
    "",
    ...(conflicts.length ? ["## 口径冲突披露", ...conflicts.map(conflictLine), ""] : []),
    "## 主张状态与引用判定",
    ...claims.map(
      (claim) =>
        `- [${claim.kind}${claimMark(claim)}${claim.confidence ? `|置信度:${claim.confidence}` : ""} / ${claim.evidenceIds.map(evLabel).join(",")}] ${claim.statement}`,
    ),
    "",
    ...(unresolved.length ? ["## 未解决问题", ...unresolved.map((u) => `- ${u}`), ""] : []),
  ].join("\n");

  // 专项质量检查(模块配置):必备章节 / 主题覆盖 / 验证规则
  const moduleCheck = checkModuleOutput(input.moduleConfig, {
    reportMd: baseReportMd,
    claims,
    questions: input.questions,
  });
  if (!moduleCheck.passed) {
    reasons.push(
      `模块质量检查未通过:${[
        ...moduleCheck.missingSections.map((s) => `缺必备章节「${s}」`),
        ...moduleCheck.uncoveredTopics.map((t) => `主题未覆盖「${t}」`),
        ...moduleCheck.violations,
      ].join(";")}`,
    );
  }
  // reasons 去重追加:与既有 limitations + 本次降级披露合并判重,顺序即最终披露顺序
  const allLimitations = [...input.limitations, ...limitationsToAppend];
  for (const reason of reasons) {
    addLimitation(allLimitations, reason);
  }
  const status = reasons.length > 0 ? "limited" : "published";

  const reportMd = [
    baseReportMd,
    "",
    ...(allLimitations.length ? ["## 限制", ...allLimitations.map((l) => `- ${l}`), ""] : []),
  ].join("\n");

  return {
    claims,
    verdicts,
    limitationsToAppend: allLimitations.slice(input.limitations.length),
    unresolved,
    reasons,
    reportMd,
    status,
  };
}
