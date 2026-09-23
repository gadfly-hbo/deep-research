import { randomUUID } from "node:crypto";
import type { Applicability, AssetBinding } from "./contracts.js";
import type { LibraryStore } from "./types.js";

export interface ReuseCheckInput {
  runId: string;
  projectId: string;
  sourceId: string;
  versionId: string;
  purpose: string;
  /** 研究允许采用信息的截止点 */
  asOf?: string;
}

export interface ReuseCheckOutcome {
  applicability: Applicability;
  allowed: boolean;
  checkNotes: string[];
}

/**
 * check_reuse(§9.2):先授权,再生命周期/取得完整性/派生/时间口径,最后给适用性身份。
 * 适用性是"在某研究内"的计算结果,不写回全局状态。
 */
export async function checkReuse(store: LibraryStore, input: ReuseCheckInput): Promise<ReuseCheckOutcome> {
  const notes: string[] = [];
  const source = await store.getSource(input.sourceId);
  const version = await store.getVersion(input.versionId);
  if (!source || !version) {
    return { applicability: "FORBIDDEN", allowed: false, checkNotes: ["资产或版本不存在"] };
  }
  // 授权判定:本版本无取得记录时(如更正版本)回落到同源任一版本的取得记录
  let acquisitions = await store.acquisitionsForVersion(input.versionId);
  if (acquisitions.length === 0) {
    const versions = await store.versionsForSource(input.sourceId);
    acquisitions = (await Promise.all(versions.map((v) => store.acquisitionsForVersion(v.versionId)))).flat();
  }
  // G6/S-02:跨项目复用必须显式授权;无项目归属的直录资产同样需显式升档
  const allowedByRights = acquisitions.some(
    (a) => a.projectId === input.projectId || a.reuseScope === "WORKSPACE_REUSABLE",
  );
  if (!allowedByRights) {
    notes.push("权限:该资产为其他项目范围且未授权跨项目复用");
    return { applicability: "FORBIDDEN", allowed: false, checkNotes: notes };
  }

  // A-08:转引链上游未取得时不得按已核验原文使用
  if (source.origin && source.origin.upstreamSourceId && source.origin.obtainedUpstream === false) {
    notes.push("转引:上游原文尚未取得,摘录口径以实际取得版本为准");
    return { applicability: "NEEDS_REVIEW", allowed: true, checkNotes: notes };
  }
  // A-05/A-18:消费者画像样本边界由服务端提示,不依赖客户端填写
  if (source.docType === "consumer-profile") {
    notes.push("消费者画像:样本范围以证据口径为准,不得外推全渠道/全部购买者");
  }

  if (source.lifecycle === "WITHDRAWN") {
    notes.push(`生命周期:已撤回(${version.withdrawnReason ?? "原因见详情"}),禁止新使用`);
    return { applicability: "FORBIDDEN", allowed: false, checkNotes: notes };
  }
  if (source.lifecycle === "ARCHIVED") {
    notes.push("生命周期:已归档,复用前需人工复核仍适用");
    return { applicability: "NEEDS_REVIEW", allowed: true, checkNotes: notes };
  }

  if (version.fetchStatus === "DISCOVERED" || version.fetchStatus === "UNAVAILABLE") {
    notes.push(`取得状态:${version.fetchStatus === "DISCOVERED" ? "仅登记入口" : "不可得"},只能作为线索`);
    return { applicability: "LEAD_ONLY", allowed: true, checkNotes: notes };
  }
  if (version.parseStatus === "failed") {
    notes.push(`解析缺口:${version.parseIssue ?? "解析失败"},引用前需人工复核`);
    return { applicability: "NEEDS_REVIEW", allowed: true, checkNotes: notes };
  }
  if (source.derivedFromRunId) {
    notes.push(`派生成果:来自工作台历史运行 ${source.derivedFromRunId},只能作为线索,须展开到外部来源`);
    return { applicability: "LEAD_ONLY", allowed: true, checkNotes: notes };
  }
  if (input.asOf && version.publishedAt && version.publishedAt > input.asOf) {
    notes.push(`截止点:该版本发布于 ${version.publishedAt} 晚于研究截止点 ${input.asOf},不得用于当时判断`);
    return { applicability: "NEEDS_REVIEW", allowed: true, checkNotes: notes };
  }
  return { applicability: "ELIGIBLE", allowed: true, checkNotes: notes };
}

/** 适用性保守度排序:数值越大越受限 */
const APPLICABILITY_RANK: Record<Applicability, number> = {
  ELIGIBLE: 0,
  NEEDS_REVIEW: 1,
  LEAD_ONLY: 2,
  NOT_APPLICABLE: 3,
  FORBIDDEN: 4,
};
const APPLICABILITY_BY_RANK: Applicability[] = [
  "ELIGIBLE",
  "NEEDS_REVIEW",
  "LEAD_ONLY",
  "NOT_APPLICABLE",
  "FORBIDDEN",
];

export interface ScopeChangeRequest {
  versionId: string;
  projectId?: string;
  targetScope: "PROJECT_ONLY" | "WORKSPACE_REUSABLE" | "RESTRICTED";
  /** 授权依据(§12.2 change_reuse_scope):范围变更必须可追溯 */
  basis: string;
}

/**
 * change_reuse_scope:调整取得记录的复用范围并审计;不扩大原始使用许可——
 * 仅当该取得记录本身持有本地留存权利时才允许放宽到工作台可复用。
 */
export async function changeReuseScope(
  store: LibraryStore,
  req: ScopeChangeRequest,
): Promise<{ changed: number }> {
  const acquisitions = await store.acquisitionsForVersion(req.versionId);
  const targets = acquisitions.filter((a) => (req.projectId ? a.projectId === req.projectId : true));
  for (const a of targets) {
    if (req.targetScope === "WORKSPACE_REUSABLE" && a.rights.localRetention === false) {
      throw new Error(`取得记录 ${a.acquisitionId} 无本地留存权利,不能放宽为工作台可复用`);
    }
    await store.saveAcquisition({ ...a, reuseScope: req.targetScope });
  }
  store.audit("reuse-scope-changed", {
    versionId: req.versionId,
    targetScope: req.targetScope,
    basis: req.basis,
    changed: targets.length,
  });
  return { changed: targets.length };
}

export interface BindRequestItem {
  sourceId: string;
  versionId: string;
  purpose: string;
  applicability: Applicability;
  evidenceRevisions?: Record<string, number>;
  asOf?: string;
  checkNotes?: string[];
}

export interface BindRequest {
  runId: string;
  projectId: string;
  idempotencyKey?: string;
  bindings: BindRequestItem[];
}

export interface BindOutcome {
  bindings: AssetBinding[];
  rejected: Array<{ sourceId: string; reason: string }>;
}

/** bind_assets:服务端再次检查权限;FORBIDDEN 不落库;幂等键防重复;不静默覆盖旧快照 */
export async function bindAssets(store: LibraryStore, req: BindRequest): Promise<BindOutcome> {
  if (req.idempotencyKey) {
    const prior = (await store.bindingsForRun(req.runId)).find(
      (b) => b.idempotencyKey === req.idempotencyKey,
    );
    if (prior) {
      return { bindings: await store.bindingsForRun(req.runId), rejected: [] };
    }
  }
  const bindings: AssetBinding[] = [];
  const rejected: BindOutcome["rejected"] = [];
  for (const item of req.bindings) {
    const check = await checkReuse(store, {
      runId: req.runId,
      projectId: req.projectId,
      sourceId: item.sourceId,
      versionId: item.versionId,
      purpose: item.purpose,
      asOf: item.asOf,
    });
    if (
      !check.allowed ||
      item.applicability === "FORBIDDEN" ||
      check.applicability === "FORBIDDEN" ||
      item.applicability === "NOT_APPLICABLE"
    ) {
      rejected.push({ sourceId: item.sourceId, reason: check.checkNotes[0] ?? "权限或状态不允许" });
      continue;
    }
    // 适用性取更保守的一档:服务端检查不允许被请求方上调,用户可主动下调
    const applicability =
      APPLICABILITY_BY_RANK[Math.max(APPLICABILITY_RANK[check.applicability], APPLICABILITY_RANK[item.applicability])];
    const existingForVersion = (await store.bindingsForRun(req.runId)).find(
      (b) => b.versionId === item.versionId,
    );
    if (existingForVersion) {
      // 不静默覆盖:同 run 同版本的绑定保持原快照
      bindings.push(existingForVersion);
      continue;
    }
    const binding: AssetBinding = {
      bindingId: `b-${randomUUID().slice(0, 8)}`,
      runId: req.runId,
      projectId: req.projectId,
      sourceId: item.sourceId,
      versionId: item.versionId,
      evidenceRevisions: item.evidenceRevisions ?? {},
      purpose: item.purpose,
      applicability,
      asOf: item.asOf,
      checkNotes: [...check.checkNotes, ...(item.checkNotes ?? [])],
      idempotencyKey: req.idempotencyKey,
      boundAt: new Date().toISOString(),
    };
    await store.saveBinding(binding);
    bindings.push(binding);
  }
  store.audit("bind-request", {
    runId: req.runId,
    idempotencyKey: req.idempotencyKey ?? null,
    bound: bindings.length,
    rejected: rejected.length,
  });
  return { bindings, rejected };
}
